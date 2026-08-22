---
title: "Summary: Pod Deletion Lifecycle, Garbage Collection, and Who Actually Deletes a Pod"
---

> **Full notes:** [[notes/K8s/pod-deletion-lifecycle-and-garbage-collection|Pod Deletion Lifecycle, Garbage Collection, and Who Actually Deletes a Pod -->]]

## Key Concepts

### The three-actor split — the punchline

A Pod is **two things**: an etcd key (owned by kube-apiserver) and a set of Linux processes (owned by kubelet). Neither actor can reach the other's domain, so every deletion is a three-act play.

| Act | What happens | Actor |
|---|---|---|
| **Decide** | first `DELETE` → API server sets `deletionTimestamp`; **object stays in etcd**, pod shows `Terminating` | **Initiator**: RS controller, you, kube-scheduler, eviction handler, node-lifecycle controller, podgc |
| **Kill** | `SIGTERM` → `terminationGracePeriodSeconds` → `SIGKILL`; tear down sandbox, volumes, cgroups, pod IP | **kubelet** (only it owns the CRI socket) |
| **Remove** | etcd key disappears | **API server**, executing a final `DELETE …?gracePeriodSeconds=0` that **kubelet** sends |

> **kubelet never touches etcd.** It issues an HTTP `DELETE` (with `GracePeriodSeconds: 0` **and** `Preconditions{uid}` so it can't kill a recreated same-name pod). Kubelet *asks*; the API server *decides*. If asked for one name, give the **initiator** — that's the intent and the first `delete pods` audit entry.

### Why terminal (`Failed`/`Succeeded`) pods accumulate

Three GC paths could reap them. None fires.

| Path | Trigger | Why it doesn't fire |
|---|---|---|
| Cascading (owner-ref) GC | owner object **gone** | owner RS is **alive** — ownership is *why* they persist. A naked `Failed` pod is *also* never GC'd; this path is not phase-aware at all |
| ReplicaSet controller | — | `IsPodActive()` = false for `Failed`, so it isn't counted toward `replicas` **and the controller owns no reaping loop**. Deliberate: terminal pods are debugging artifacts |
| podgc `gcTerminated` | cluster-wide terminated count **>** `--terminated-pod-gc-threshold` (12500) | 261 − 12500 = negative → returns immediately |

```go
func IsPodActive(p *v1.Pod) bool {
	return v1.PodSucceeded != p.Status.Phase &&
		v1.PodFailed != p.Status.Phase &&
		p.DeletionTimestamp == nil
}
```

RS loop for `replicas: 3` with 1 Failed: lists 3 → `FilterActivePods` → 2 → creates 1. **Never revisits the Failed object.** Same for the Job controller.

### `--terminated-pod-gc-threshold` is a high-water mark, not a timer

```go
deleteCount := terminatedPodCount - gcc.terminatedPodThreshold
if deleteCount <= 0 { return }
sort.Sort(byEvictionAndCreationTimestamp(terminatedPods))
for i := 0; i < deleteCount; i++ { /* delete */ }
```

- Default **12500**, a `kube-controller-manager` flag → **unsettable on GKE/EKS/AKS**.
- Deletes **only the overflow** — brings the count *down to* the threshold, not to zero.
- Ordering is **evicted-first, then oldest creationTimestamp, then name** — not pure FIFO.
- `<= 0` **disables** `gcTerminated` entirely. Official wording: *"If <= 0, the terminated pod garbage collector is disabled."*
- Runs every 20 s (`gcCheckPeriod`).

### The four podgc paths — only one is threshold-bound

| Path | Trigger | Threshold-bound? |
|---|---|---|
| `gcTerminated` | phase ∉ {Pending, Running, Unknown} | **Yes** (12500) |
| `gcTerminating` | `deletionTimestamp != nil` ∧ node **NotReady** ∧ node tainted `node.kubernetes.io/out-of-service` | No |
| `gcOrphaned` | `spec.nodeName` → Node object that no longer exists (40 s `quarantineTime` + confirming GET) | No |
| `gcUnscheduledTerminating` | `deletionTimestamp != nil` ∧ `spec.nodeName == ""` | No |

All four force-delete (grace 0) and first PATCH `phase=Failed` + a `DisruptionTarget` condition (e.g. `reason: DeletionByPodGC`). `PodDisruptionConditions` was stable in 1.31, gate removed in 1.34.

`gcOrphaned` is why tombstones "mysteriously" clear when a node pool scales down. `gcTerminating` is the manual escape hatch for a dead node whose kubelet will never send the finalizing delete.

### `OutOfpods` and the bind→admit race

`OutOfpods` is the kubelet **admission** rejection (predicate admit handler), distinct from the eviction manager:

```
reason:  OutOfpods
message: "Node didn't have enough resource: pods, requested: 1, used: 32, capacity: 32"
```

Scheduler binds off a cached snapshot; kubelet recomputes for real and refuses. **No DELETE is ever issued** — kubelet only PATCHes status. With 869/1010 nodes capped at ≤32 pods, every node sits permanently at the boundary where the two views can differ by one, so each lost race mints a permanent tombstone. Same race class as [[notes/K8s/daemonset-pod-race-conditions|DaemonSet pod race conditions]].

**Fixes ranked:** (1) raise `max-pods` / larger nodes — removes the race, the real defect; (2) descheduler `RemoveFailedPods` with `reasons: [OutOfpods, Evicted]` + `minPodLifetimeSeconds: 3600`; (3) janitor CronJob; (4) nothing — tombstones are inert (no CPU/memory/scheduling weight). **Avoid** blanket reactive `delete --field-selector=status.phase=Failed` in prod — destroys forensics exactly when something just broke.

### Replacement is not removal

Two independent facts that look like one event:

- **Replacement**: `Failed ∉ IsPodActive` → RS sees 2/3 → **CREATE**. Purely additive; it never deletes the Failed pod.
- **Removal**: needs podgc (threshold) or a human. Different actor, different trigger, **may never happen**.

### PDBs do NOT protect rolling updates

| Route | PDB checked? | Callers |
|---|---|---|
| `POST pods/<n>/eviction` | **Yes** — `200` allowed / `429` blocked / `500` multiple PDBs | drain, cluster-autoscaler, descheduler |
| `DELETE pods/<n>` | **No** — no PDB code path exists on this route | rolling update, RS scale-down, `kubectl delete pod`, `rollout restart`, taint manager, podgc |

Official docs: *"deleting deployments or pods bypasses Pod Disruption Budgets."* Rollout safety is `strategy.rollingUpdate.maxUnavailable`; PDBs guard **voluntary disruption** only. Scheduler preemption treats PDBs as advisory. `maxUnavailable: 0` ⇒ `kubectl drain` **never completes** (documented, intended).

### `kubectl rollout restart` deletes nothing directly

One `PATCH` on the Deployment stamping `kubectl.kubernetes.io/restartedAt` into `spec.template` → new `pod-template-hash` → new RS. Then:

```
deployment-controller  writes ONLY .spec.replicas on ReplicaSets
     └─ replicaset-controller (OLD rs)  DELETE pods   ◀── the actual deleter
          └─ kubelet  SIGTERM → grace → SIGKILL → DELETE ...?gracePeriodSeconds=0
```

The Deployment controller has no code path that deletes a Pod. It does delete old **ReplicaSets** per `revisionHistoryLimit` (default 10), which have 0 replicas by then. Same chain for any template change.

### RS scale-down victim ordering (`ActivePodsWithRanks.Less`)

1. unassigned (`spec.nodeName == ""`) → 2. `Pending` < `Unknown` < `Running` → 3. not-ready before ready → 4. **lower `controller.kubernetes.io/pod-deletion-cost`** → 5. on nodes holding more ready pods of the same RS → 6. ready for less time → 7. higher restart count → 8. newer `creationTimestamp`.

`pod-deletion-cost` is `int32`, default `0`, negative allowed, gated by `PodDeletionCost` — **Beta / default-on since 1.22, never GA'd**. Tiers 6 and 8 use `logarithmicRankDiff` with a UID tie-break, deliberately randomising among similarly-aged pods.

### Why so few terminal pods are visible

`kubectl get pods` does **not** filter by phase. The supply is just small:

1. **`Succeeded` is structurally impossible for Deployment pods** — `restartPolicy: Always` is mandatory for Deployment/StatefulSet/DaemonSet, so reachable phases are only Pending/Running/Failed. `Succeeded` needs `OnFailure`/`Never` → Jobs, CronJobs, bare pods.
2. **Job/CronJob pods are reaped by owner-cascade, not podgc.** `successfulJobsHistoryLimit: 3` / `failedJobsHistoryLimit: 1` (defaults) → cronjob-controller deletes Jobs → cascading GC deletes pods (owner *genuinely* gone, so the path that failed for RS-owned pods succeeds here). Same via `ttlSecondsAfterFinished` (**no default** — bare Jobs *do* accumulate). Net: podgc's 12500 is a backstop that almost never engages.
3. **Namespace scoping** — cluster-wide counts need `-A`.

### `propagationPolicy` cascade

| Policy | Order | Owner state |
|---|---|---|
| `Background` (**kubectl default**) | owner first, children async after | removed from etcd immediately; `kubectl` returns instantly |
| `Foreground` | children first, owner last | gets `deletionTimestamp` + `foregroundDeletion` finalizer, stays visible while blocking children exist |
| `Orphan` | owner only | children survive; GC strips the `ownerReference` |

Background is why pods linger after `kubectl delete deployment` "succeeded". Foreground blocks **only** on dependents with `ownerReference.blockOwnerDeletion: true` **and present in the GC controller cache** — a resource type GC can't list/watch silently fails to block. Best-effort ordering, not a transaction.

### You cannot un-delete an object

Three independent defenses:

1. **Mutating webhooks can't mutate on DELETE** — `object: null`, `oldObject: <obj>`. Any response patch is **ignored**.
2. **The write is below admission** — `Store.updateForGracefulDeletionAndFinalizers` → `Storage.GuaranteedUpdate`. Not an UPDATE request; UPDATE webhooks are never invoked.
3. **`deletionTimestamp` is immutable** — `ValidateImmutableField`, same class as `uid`/`creationTimestamp`/`deletionGracePeriodSeconds`.

The two directions differ:

| Attempt | Mechanism | Client sees |
|---|---|---|
| `nil` → set (fake a delete) | `ValidateImmutableField` fires | `422`: `metadata.deletionTimestamp: field is immutable` |
| set → `nil` (un-delete) | `rest.BeforeUpdate` silently restores old value before validation | **`200 OK`, no effect** — the dangerous silent no-op |

Also: `metadata.finalizers: Forbidden: no new finalizers can be added if the object is being deleted, found new finalizers [...]`.

### Finalizer vs validating webhook

| | Validating webhook on DELETE | Finalizer |
|---|---|---|
| Prevents deletion? | **Yes** — the only real veto; rejects before `deletionTimestamp` is written | **No** — only *delays* it |
| Object recoverable? | Yes, untouched | **No** — terminal state, one-way |
| Added when | any time | **must exist before** the DELETE |
| Failure mode | webhook down + `failurePolicy: Fail` ⇒ **no deletions cluster-wide** for matched resources | controller down ⇒ **stuck Terminating forever** (same as a wedged namespace) — a bug, not a veto |

### DELETE AdmissionReview gotchas

- `DELETE` **is** valid in `rules[].operations` (full set: `CREATE`, `UPDATE`, `DELETE`, `CONNECT`, `*`) — just pointless for mutation.
- `oldObject` on DELETE has been populated **only since 1.15** ([PR #76346](https://github.com/kubernetes/kubernetes/pull/76346)). Earlier releases sent `null`, which is why DELETE webhooks were historically useless.
- `options` (the client's `DeleteOptions`) is **unique to DELETE** — lets you spot `gracePeriodSeconds: 0` force-deletes, the `propagationPolicy`, and `preconditions`.
- **Evictions do NOT arrive as DELETE**: `operation: CREATE`, `resource: pods`, `subResource: eviction`. A DELETE-only webhook silently misses drain/CA/descheduler. Also `resources: ["*"]` matches resources but **not** subresources — need `"*/*"` or `"pods/*"`.
- `deletecollection` fans out to **one AdmissionReview per object** → `failurePolicy: Fail` + a flake = *partial* delete.
- `objectSelector` / `matchConditions` on DELETE must reference `oldObject.metadata`; a null object never matches.
- `sideEffects` in `v1` allows only `None` or `NoneOnDryRun`. Default `timeoutSeconds` is **10 s**.

## Quick Reference

### Who issues the DELETE

| Scenario | Deleter | Eviction API? | PDB? | Tombstone? |
|---|---|---|---|---|
| RS scale-down / rolling update | replicaset-controller | No | **No** | No |
| RS replacing a Failed pod | **nobody** | — | — | **Yes** |
| `kubectl rollout restart` | old RS's controller | No | **No** | No |
| `kubectl delete pod` | you | No | **No** | No |
| drain / cluster-autoscaler / descheduler | `pods/eviction` handler | **Yes** | **Yes** | No |
| Scheduler preemption | kube-scheduler | No | advisory | No |
| Taint manager (`NoExecute`) | node-lifecycle controller | No | No | No |
| Node object deleted | podgc `gcOrphaned` | No | No | No |
| **kubelet eviction / admission reject** | **nobody** | — | — | **Yes** |

### Investigation

```bash
kubectl -n <ns> get pods --field-selector=status.phase==Failed

kubectl get pods -A --field-selector=status.phase==Failed \
  -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,REASON:.status.reason,NODE:.spec.nodeName,AGE:.metadata.creationTimestamp'

# histogram of reasons — fastest way to spot a systemic race
kubectl get pods -A --field-selector=status.phase==Failed \
  -o jsonpath='{range .items[*]}{.status.reason}{"\n"}{end}' | sort | uniq -c | sort -rn
```

**Gotcha:** `--field-selector` supports `status.phase` and `spec.nodeName` but **NOT `status.reason`** — filter reason client-side.

**Events age out** (`--event-ttl` default `1h0m0s`, an etcd lease), so the **audit log is authoritative** for "who deleted it". On GKE: `protoPayload.methodName="io.k8s.core.v1.pods.delete"`, read `protoPayload.authenticationInfo.principalEmail`:

| principal | meaning |
|---|---|
| `…:pod-garbage-collector` | podgc |
| `…:replicaset-controller` | scale-down / rollout |
| `system:node:<node>` | kubelet's grace-0 finalizing delete (**not** the decision) |
| `system:kube-scheduler` | preemption |
| a human email | someone did it by hand |

Expect **two** `pods.delete` entries per normal termination. The **first** is the answer.

### Pod stuck `Terminating` — decision tree

```
deletionTimestamp is set, Act 3 never ran. Exactly two causes:

finalizers NON-EMPTY                      finalizers EMPTY
  a controller owes a removal:              nobody sends the grace-0 DELETE:
   • its Deployment is down                  • node NotReady / kubelet dead
   • lost RBAC to patch                      • kubelet wedged (PLEG unhealthy)
   • panics on this object                   • container ignoring SIGTERM
   • CRD owner uninstalled without
     clearing finalizers
  FIX: fix the controller. Last resort:     FIX: taint the dead node
   kubectl patch pod X --type=merge          node.kubernetes.io/out-of-service
     -p '{"metadata":{"finalizers":null}}'   → podgc gcTerminating force-deletes.
   (leaks the external resource)             Or --grace-period=0 --force
```

Avoid `--force --grace-period=0` as a first move: it drops the API object while containers may still be **running** — split-brain risk for StatefulSets and RWO volumes. That's exactly why the `out-of-service` taint path exists.

### Version currency

| Thing | Status |
|---|---|
| `--terminated-pod-gc-threshold` | default **12500**, kube-controller-manager flag (unsettable on managed control planes) |
| `oldObject` on DELETE AdmissionReview | populated since **1.15** |
| `PodDeletionCost` gate | Alpha 1.21, **Beta / default-on 1.22**, never GA |
| `PodDisruptionConditions` (`DisruptionTarget`) | stable **1.31**, gate removed 1.34 → unconditional |
| `pods/resize` (`InPlacePodVerticalScaling`) | Alpha 1.27, Beta 1.33, **GA 1.35** |
| `ConsistentListFromCache` | Beta-on 1.31, **GA 1.34** (needs etcd ≥ v3.4.31 / v3.5.13) |
| `sideEffects` allowed values (`v1`) | `None`, `NoneOnDryRun` only |

## Key Takeaways

- **Three actors, three acts**: initiator *decides* (writes `deletionTimestamp`, object stays), kubelet *kills* (SIGTERM→SIGKILL, tears down the sandbox), API server *removes* the etcd key on kubelet's final grace-0 `DELETE`. kubelet **never touches etcd** — it asks; the API server decides. Name the **initiator** if forced to pick one.
- Terminal pods persist because **all three GC paths are inapplicable**: the owner is alive (cascading GC), `IsPodActive()` hides them *and* no controller reaps them (RS/Job), and the cluster is far below 12500 (podgc). A **naked** `Failed` pod isn't GC'd either — cascading GC is not phase-aware.
- `--terminated-pod-gc-threshold` is a **cluster-wide high-water mark**, not a timer or a per-namespace count. It deletes only the overflow, **evicted-first then oldest**, and `<= 0` disables it entirely. It's a kube-controller-manager flag, so it's unsettable on GKE.
- Only `gcTerminated` is threshold-bound. `gcTerminating` (out-of-service taint **+** NotReady node), `gcOrphaned` (Node object gone), and `gcUnscheduledTerminating` (no `nodeName`) run unconditionally. `gcOrphaned` is why tombstones clear when node pools shrink.
- **Replacement ≠ removal.** The RS controller creates a replacement because `Failed` isn't active; it never deletes the Failed pod. Two independent events, different actors, different triggers.
- **PDBs apply to `pods/eviction` only.** Rolling updates, scale-downs, and `kubectl delete pod` are direct DELETEs and bypass them completely. Use `maxUnavailable` for rollout safety.
- **`kubectl rollout restart` deletes nothing.** It PATCHes the pod template; the Deployment controller only writes `.spec.replicas` on ReplicaSets; the **old RS's controller** is the actual deleter.
- `OutOfpods` is a kubelet **admission** rejection from the bind→admit race — kubelet writes `Failed` and issues no DELETE, minting a permanent tombstone. Low `max-pods` makes it chronic. Fix the density, not the symptom.
- **You cannot un-delete an object.** Mutating webhooks are no-ops on DELETE (`object: null`), the `deletionTimestamp` write happens below admission, and the field is immutable — with an asymmetry: faking a delete gets `422`, un-deleting gets a **silent `200 OK` no-op**.
- **Finalizers delay; validating webhooks veto.** A finalizer added *before* deletion pauses removal for cleanup but there is no path back to alive. Only a validating webhook on DELETE returning `allowed: false` truly prevents deletion. Both have cluster-wedging failure modes.
- **Evictions reach webhooks as `CREATE` on `pods/eviction`**, so a DELETE-only webhook silently misses every drain, cluster-autoscaler, and descheduler removal.
- **Events age out in 1h** (`--event-ttl`). For "who deleted my pod", read the audit log and take the **first** of the two `pods.delete` entries.
