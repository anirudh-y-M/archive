---
title: "Pod Deletion Lifecycle, Garbage Collection, and Who Actually Deletes a Pod"
---

## Overview

"Who deleted my pod?" has no single answer, because a Pod is **two different things** that live in two different places:

```
        ┌─────────────────────────────┐        ┌──────────────────────────────┐
        │  Pod as an API OBJECT       │        │  Pod as a set of PROCESSES   │
        │  a key in etcd under        │        │  containers, sandbox, cgroups│
        │  /registry/pods/<ns>/<name> │        │  veth, volume mounts         │
        │                             │        │                              │
        │  owner: kube-apiserver      │        │  owner: kubelet + CRI        │
        │  kubelet cannot touch etcd  │        │  apiserver cannot touch node │
        └─────────────────────────────┘        └──────────────────────────────┘
                        ▲                                     ▲
                        └────────── deletionTimestamp ────────┘
                              the handshake between them
```

Because neither actor can reach into the other's domain, every pod deletion is a **three-act play**. And because terminal pods (`Failed` / `Succeeded`) are *status writes* rather than deletions, an entire class of pod "removal" never happens at all — which is why clusters accumulate tombstones.

This note covers the full deletion path (initiator → kubelet → API server), all four garbage-collection mechanisms and why each one usually does *not* fire, the `propagationPolicy` cascade semantics, finalizers vs. validating webhooks for blocking deletion, and what a DELETE looks like at the admission layer.

Related: [[notes/K8s/kube-apiserver-request-routing|kube-apiserver Request Routing]] for what the API server does before it touches etcd, and [[notes/K8s/daemonset-pod-race-conditions|DaemonSet Pod Race Conditions]] for the bind→admit race that mints `OutOfpods` tombstones.

---

## The Three-Actor Split: Decide, Kill, Remove

This is the punchline. Memorise this table and most pod-deletion confusion evaporates.

| Act | What happens | Actor |
|---|---|---|
| **1. Decide** | Issue the first `DELETE`. API server sets `metadata.deletionTimestamp` + `deletionGracePeriodSeconds`. **The object stays in etcd.** Pod now shows `Terminating`. | **Initiator** — ReplicaSet controller, you, kube-scheduler (preemption), the eviction handler, node-lifecycle controller, podgc |
| **2. Kill** | `SIGTERM` → `terminationGracePeriodSeconds` → `SIGKILL`. Tear down sandbox, unmount volumes, delete cgroups, release the pod IP. | **kubelet** (only it can — it owns the CRI socket) |
| **3. Remove** | The etcd key disappears. | **API server**, executing a final `DELETE …?gracePeriodSeconds=0` that **kubelet** sends |

```
  ┌──────────┐  ①DELETE   ┌───────────────┐  writes  ┌──────┐
  │initiator │───────────▶│ kube-apiserver│─────────▶│ etcd │  deletionTimestamp set
  └──────────┘            └───────────────┘          └──────┘  object STILL PRESENT
                                  │ watch
                                  ▼
                            ┌──────────┐
                            │ kubelet  │ ② sees deletionTimestamp != nil
                            └──────────┘    SIGTERM → grace → SIGKILL
                                  │          sandbox/volumes/cgroups gone
                                  │ ③ DELETE ...?gracePeriodSeconds=0
                                  ▼          + Preconditions{uid: <pod UID>}
                          ┌───────────────┐  removes ┌──────┐
                          │ kube-apiserver│─────────▶│ etcd │  key GONE
                          └───────────────┘          └──────┘
```

> **Note:** A very common misconception is "the kubelet deletes the pod." The kubelet **never talks to etcd** — that is a hard architectural invariant of Kubernetes. The kubelet issues an HTTP `DELETE` to the API server, which authenticates it as `system:node:<node>`, authorizes it via the **Node authorizer** (this kubelet may only delete pods bound to its own node), runs admission, checks finalizers, emits an audit event, and *then* removes the key. Kubelet **asks**; the API server **decides**. Verified in [`pkg/kubelet/status/status_manager.go`](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/status/status_manager.go) — the status manager calls `Pods(ns).Delete(ctx, name, DeleteOptions{GracePeriodSeconds: 0, Preconditions: UIDPreconditions(pod.UID)})` and logs `"Pod fully terminated and removed from etcd"`.

The UID precondition in step 3 matters: without it, a slow kubelet could delete a *brand-new* pod that happens to reuse the same namespace/name.

**If someone asks you for one name**, give the **initiator**. That is the intent, and it is what the first `delete pods` audit entry attributes. Kubelet's grace-0 follow-up is bookkeeping, not a decision.

---

## Who Issues the DELETE — the Full Actor Table

| Scenario | Who issues DELETE | Audit identity | Eviction API? | PDB honored? | Tombstone left? |
|---|---|---|---|---|---|
| RS scale-down (incl. rolling update) | replicaset-controller | `system:serviceaccount:kube-system:replicaset-controller` | No — direct DELETE | **No** | No |
| RS *replacing* a Failed pod | **nobody** | — | — | — | **Yes** |
| `kubectl rollout restart` | old RS's controller | `…:replicaset-controller` | No | **No** | No |
| `kubectl delete pod` | you | your user / SA | No | **No** | No |
| `kubectl drain`, cluster-autoscaler, descheduler | API server's `pods/eviction` handler | the caller | **Yes** | **Yes** | No |
| Scheduler preemption | kube-scheduler | `system:kube-scheduler` | No | Advisory only (best-effort) | No |
| Taint manager (`NoExecute`) | node-lifecycle controller | node-controller identity | No | No | No |
| Node object deleted | podgc `gcOrphaned` | `…:pod-garbage-collector` | No | No | No |
| Job/CronJob history trimming | cronjob-controller deletes the **Job**; cascading GC deletes pods | `…:cronjob-controller` / `…:generic-garbage-collector` | No | No | No |
| **kubelet eviction (node pressure)** | **nobody** | — | — | — | **Yes** |
| **kubelet admission reject (`OutOfpods`)** | **nobody** | — | — | — | **Yes** |

Only three rows leave tombstones. Two of them are kubelet-side and share one mechanism: **kubelet writes `status.phase=Failed` and deletes nothing.** That is the entire source of accumulated terminal pods.

---

## Why Terminal Pods Accumulate

Real case: **261 terminal pods cluster-wide, 184 of them with `reason: OutOfpods`**, all owned by a live-and-healthy ReplicaSet. Three garbage-collection paths could theoretically reap them. None fires.

```
                        Failed pod sits in etcd
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
 ┌──────────────┐         ┌───────────────┐        ┌──────────────────┐
 │ Cascading GC │         │  RS controller│        │ podgc            │
 │ (owner-ref)  │         │               │        │ (phase-based)    │
 ├──────────────┤         ├───────────────┤        ├──────────────────┤
 │ owner RS is  │         │ IsPodActive() │        │ 261 terminated   │
 │ ALIVE  → NOP │         │ = false → not │        │ < 12500 thresh.  │
 │              │         │ counted, not  │        │ → deleteCount<=0 │
 │              │         │ reaped → NOP  │        │ → NOP            │
 └──────────────┘         └───────────────┘        └──────────────────┘
        ✗                        ✗                         ✗
                    ⇒ the pod lives forever
```

### Path 1: Cascading (Owner-Reference) GC — Inverted Premise

The `garbage-collector-controller` deletes objects whose **owner has disappeared**. Here the owner (`ReplicaSet 8545cbdcc6`) is alive and healthy.

> **Note:** The reasoning "these aren't naked pods and they're `Failed`, so GC should remove them" inverts the mechanism twice.
> 1. A **live owner is the reason they persist**, not a reason they should go. Cascading GC's trigger is owner *absence*.
> 2. A genuinely **naked** `Failed` pod (no `ownerReferences` at all) is *also* never GC'd by this controller — there is no dangling reference to act on. Nothing in the cascading GC path is phase-aware.

Cascading GC only ever asks *"do all my owners still exist?"* It never asks *"am I still useful?"*

### Path 2: The ReplicaSet Controller — Never Reaps, By Design

Every workload controller filters its pod list through one predicate — [`pkg/controller/controller_utils.go`](https://github.com/kubernetes/kubernetes/blob/master/pkg/controller/controller_utils.go):

```go
func IsPodActive(p *v1.Pod) bool {
	return v1.PodSucceeded != p.Status.Phase &&
		v1.PodFailed != p.Status.Phase &&
		p.DeletionTimestamp == nil
}

// FilterActivePods returns pods that have not terminated.
func FilterActivePods(logger klog.Logger, pods []*v1.Pod) []*v1.Pod {
	var result []*v1.Pod
	for _, p := range pods {
		if IsPodActive(p) { result = append(result, p) }
	}
	return result
}
```

So for `replicas: 3` with one pod `Failed`:

```
   RS reconcile loop
   ├── list pods matching selector  → 3 objects  (2 Running, 1 Failed)
   ├── FilterActivePods()           → 2 objects  ← the Failed one is invisible here
   ├── diff = 2 - 3 = -1            → CREATE one pod
   └── ...and that's it. No branch anywhere in this loop
       ever revisits the Failed object.
```

The Failed pod is **not counted** toward `replicas`, and the controller **owns no reaping loop** for it. This is deliberate: terminal pods are preserved as debugging artifacts — their `status`, container exit codes, and `reason` are the only forensic record once Events have aged out. The Job controller behaves identically (failed pods survive until the Job itself is deleted and cascades).

**Consequence:** a Deployment/ReplicaSet accumulates `Failed` pods indefinitely. **Nothing in the workload controllers cleans up after itself.**

### Path 3: podgc — a Quota, Not a Timer

The **pod garbage collector** (`pod-garbage-collector-controller` inside kube-controller-manager) is the *only* controller that reaps terminal pods on phase alone. It runs every **20 s** (`gcCheckPeriod`).

> **Note:** The framing "Succeeded and Failed pods are deleted after 12500" is wrong in kind. `--terminated-pod-gc-threshold` is not an age, a per-namespace count, or a trigger delay. It is a **cluster-wide high-water mark**. From [`pkg/controller/podgc/gc_controller.go`](https://github.com/kubernetes/kubernetes/blob/master/pkg/controller/podgc/gc_controller.go):
>
> ```go
> terminatedPodCount := len(terminatedPods)
> deleteCount := terminatedPodCount - gcc.terminatedPodThreshold
> if deleteCount <= 0 { return }                       // ← the whole story
> sort.Sort(byEvictionAndCreationTimestamp(terminatedPods))
> for i := 0; i < deleteCount; i++ { /* delete terminatedPods[i] */ }
> ```
>
> It deletes **exactly the overflow** — enough pods to bring the count back *down to* the threshold — and no more. At 261 terminal pods with a threshold of 12500, `deleteCount = -12239`, so podgc returns immediately without deleting anything. Official flag description: *"Number of terminated pods that can exist before the terminated pod garbage collector starts deleting terminated pods. If <= 0, the terminated pod garbage collector is disabled."*

**Victim ordering is not purely oldest-first.** `byEvictionAndCreationTimestamp` sorts:

```
1. Evicted pods first  (eviction.PodIsEvicted(status)) — "Evicted pods will be
                        deleted first to avoid impact on terminated pods
                        created by controllers"
2. then oldest creationTimestamp
3. then lexicographic name as tie-breaker
```

**The four podgc paths, and which ignore the threshold:**

```go
func (gcc *PodGCController) gc(ctx context.Context) {
	pods, _ := gcc.podLister.List(labels.Everything())
	nodes, _ := gcc.nodeLister.List(labels.Everything())
	if gcc.terminatedPodThreshold > 0 {      // ← ONLY this one is gated
		gcc.gcTerminated(ctx, pods)
	}
	gcc.gcTerminating(ctx, pods)
	gcc.gcOrphaned(ctx, pods, nodes)
	gcc.gcUnscheduledTerminating(ctx, pods)
}
```

| podgc path | Trigger condition | Threshold-bound? | Fired in our case? |
|---|---|---|---|
| `gcTerminated` | `phase ∉ {Pending, Running, Unknown}` — i.e. `Failed`/`Succeeded` | **Yes** (12500) | No — 261 < 12500 |
| `gcTerminating` | `deletionTimestamp != nil` **AND** node not Ready **AND** node has `node.kubernetes.io/out-of-service` taint | No | No — no such taint |
| `gcOrphaned` | pod's `spec.nodeName` refers to a **Node object that no longer exists** (after a 40 s `quarantineTime` + a confirming GET) | No | No — nodes still exist |
| `gcUnscheduledTerminating` | `deletionTimestamp != nil` **AND** `spec.nodeName == ""` | No | No — these were scheduled |

Two operational facts that fall out of the source:

- **`gcOrphaned` is why tombstones "mysteriously" clear.** Scale a node pool down and every terminal pod bound to those Nodes vanishes with them. `OutOfpods` pods pinned to *live, at-capacity* nodes have no such escape hatch.
- **podgc force-deletes and back-fills the phase.** `markFailedAndDeletePodWithCondition` first PATCHes `status.phase = Failed` (important for orphans, which would otherwise sit in `Running` forever with no kubelet to update them), attaches a `DisruptionTarget` condition with `reason: DeletionByPodGC` / `message: "PodGC: node no longer exists"`, and only then calls `Delete(..., NewDeleteOptions(0))` — grace period **0**. The `DisruptionTarget` condition is unconditional today: the `PodDisruptionConditions` gate was Beta in 1.26, **stable in 1.31**, and removed in 1.34.

### Why `OutOfpods` Dominates the Count

Same GC story as any other `Failed` pod — but a much higher **generation rate**. `OutOfpods` is the kubelet **admission** rejection (the predicate admit handler), which is a different code path from the eviction manager:

```
reason:  OutOfpods
message: "Node didn't have enough resource: pods, requested: 1, used: 32, capacity: 32"
```

From [`pkg/kubelet/lifecycle/predicate.go`](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/lifecycle/predicate.go):

```go
const InsufficientResourcePrefix = "OutOf"
const (
	OutOfCPU              = "OutOfcpu"
	OutOfMemory           = "OutOfmemory"
	OutOfEphemeralStorage = "OutOfephemeral-storage"
	OutOfPods             = "OutOfpods"
)

func (e *InsufficientResourceError) Error() string {
	return fmt.Sprintf("Node didn't have enough resource: %s, requested: %d, used: %d, capacity: %d",
		e.ResourceName, e.Requested, e.Used, e.Capacity)
}
```

The generating mechanism is the **bind→admit race** — the same class of bug described in [[notes/K8s/daemonset-pod-race-conditions|DaemonSet Pod Race Conditions]]:

```
 t0  scheduler's cache says node-7 has 31/32 pods  ──▶ Bind(pod-X, node-7)
 t1  kubelet on node-7 recomputes for real: 32/32 already admitted
 t2  kubelet REJECTS admission → PATCH status:
         phase: Failed, reason: OutOfpods
     ┌────────────────────────────────────────────────────────┐
     │ No DELETE is ever issued. The object is now a permanent│
     │ tombstone, owned by a live RS, invisible to IsPodActive│
     └────────────────────────────────────────────────────────┘
 t3  RS controller: active=2, want=3 → CREATE a replacement (additive only)
```

The scheduler is authoritative for *placement* but is not the authority on *node capacity at bind time*; kubelet is. With **869 of 1010 nodes capped at ≤32 pods**, essentially every node sits permanently at the boundary where the scheduler's view and kubelet's view can disagree by one. Every lost race mints one permanent tombstone. **184 of them is accumulated interest on a low pod-density setting.**

### Fixes, Ranked

On GKE and every other managed control plane you **cannot** lower `--terminated-pod-gc-threshold` — it is a `kube-controller-manager` flag and you do not own that process. (Nor would you want to set it to `0` or a negative number: that *disables* `gcTerminated` entirely.)

| Rank | Fix | Why |
|---|---|---|
| 1 | **Fix the generation rate**: raise `max-pods` per node, or use fewer/larger nodes | 32 pods on a `t2d-standard-32` is very low density and is the **actual defect**. Tombstones are the symptom, the race is the disease. |
| 2 | **Descheduler `RemoveFailedPods`** | The standard platform-level reaper. Scoped, age-gated, declarative. |
| 3 | **Janitor CronJob** deleting `Failed` pods older than N hours | Works everywhere, zero new components, but it's your code to own. |
| 4 | **Do nothing** | Tombstones are *inert*: no CPU, no memory, no scheduling weight, no PDB accounting, not counted by `IsPodActive`. Real costs are `kubectl get pods` noise and etcd object count. |

Descheduler config, in the current `descheduler/v1alpha2` profile format:

```yaml
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"
profiles:
  - name: reap-tombstones
    pluginConfig:
    - name: "RemoveFailedPods"
      args:
        reasons:
          - "OutOfpods"
          - "Evicted"
        minPodLifetimeSeconds: 3600     # keep 1h of forensic evidence
        excludeOwnerKinds:
          - "Job"                       # let Job/TTL controllers own those
        namespaces:
          include: ["ci-runners"]
    plugins:
      deschedule:
        enabled:
          - "RemoveFailedPods"
```

**Avoid** a blanket reactive `kubectl delete pod --field-selector=status.phase=Failed` in production. It destroys the only remaining debugging evidence at precisely the moment something has just broken. If you must, gate it on age.

---

## Replacement Is Not Removal

Unlearn the framing "the Failed pod was removed and replaced." Those are **two independent facts that merely look like one event**:

```
FACT A — replacement                        FACT B — removal
────────────────────                        ─────────────────
Failed ∉ IsPodActive                        needs podgc (threshold) or a human
  ↓                                           ↓
RS sees 2/3                                 threshold is 12500
  ↓                                           ↓
CREATE one new pod                          may literally never happen
  ↓                                           ↓
actor: replicaset-controller                actor: pod-garbage-collector / you
trigger: replica deficit                    trigger: cluster-wide overflow
timing: seconds                             timing: never, in practice
```

Replacement is **purely additive**. The RS controller never deletes the Failed pod to make room for the new one. Replica count is restored by **creation alone**.

---

## `kubectl rollout restart` Deletes Nothing Directly

It issues exactly one API call: a `PATCH` on the **Deployment**, stamping a timestamp into the *pod template*. From [`objectrestarter.go`](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/kubectl/pkg/polymorphichelpers/objectrestarter.go):

```yaml
spec:
  template:
    metadata:
      annotations:
        kubectl.kubernetes.io/restartedAt: "2026-08-21T09:14:22+09:00"
```

Changing the template changes the template hash, so a **new ReplicaSet** is required. Everything after the PATCH is ordinary controller reconciliation:

```
kubectl        PATCH deployments/api          ← the only call kubectl makes
  │
  └─▶ deployment-controller
        ├── computes new pod-template-hash → CREATE ReplicaSet api-7f9b4c
        ├── PATCH rs/api-7f9b4c   .spec.replicas: 0 → n   (scale up)
        └── PATCH rs/api-8545cb   .spec.replicas: n → 0   (scale down)
              │                    ▲
              │        ┌───────────┴──────────────────────────┐
              │        │ Deployment controller ONLY ever writes│
              │        │ .spec.replicas on ReplicaSets. It has │
              │        │ no code path that deletes a Pod.      │
              │        └──────────────────────────────────────┘
              ▼
        replicaset-controller (for the OLD rs)
              │  sorts its own children by ActivePodsWithRanks
              └──▶ DELETE pods/api-8545cb-xxxxx      ← THE ACTUAL DELETER
                     │
                     └──▶ kubelet: SIGTERM → grace → SIGKILL
                            └──▶ DELETE ...?gracePeriodSeconds=0
```

The Deployment controller *does* delete objects — but only **old ReplicaSets**, per `revisionHistoryLimit` (default 10), and by then those RSes have `replicas: 0` and no children. **Every pod deletion in a rollout is the old RS's controller acting on its own children**, verified in [`pkg/controller/replicaset/replica_set.go`](https://github.com/kubernetes/kubernetes/blob/master/pkg/controller/replicaset/replica_set.go): `rsc.podControl.DeletePod(ctx, rs.Namespace, targetPod.Name, rs)`.

The exact same chain runs for **any** template change — image bump, env var, resource tweak, annotation. `rollout restart` is simply "change the template without changing anything meaningful."

---

## PDBs Do Not Protect Rolling Updates

This is the single most frequently assumed-wrong fact about PodDisruptionBudgets.

```
                    ┌──────────────────────────────────────────┐
   PDB is checked   │  POST /api/v1/namespaces/x/pods/y/eviction│
   HERE, and only   │  → API server's eviction handler          │
   here             │      200 OK   eviction allowed → deletes  │
                    │      429      blocked by PDB              │
                    │      500      pod covered by >1 PDB       │
                    └──────────────────────────────────────────┘
                                       ▲
                     ┌─────────────────┴─────────────────┐
                     │ kubectl drain                     │
                     │ cluster-autoscaler                │
                     │ descheduler                       │
                     │ your own eviction client          │
                     └───────────────────────────────────┘

                    ┌──────────────────────────────────────────┐
   PDB is NOT even  │  DELETE /api/v1/namespaces/x/pods/y      │
   consulted here   │  → generic delete handler. No PDB code    │
                    │    path exists on this route.            │
                    └──────────────────────────────────────────┘
                                       ▲
                     ┌─────────────────┴─────────────────┐
                     │ rolling update / RS scale-down    │
                     │ kubectl delete pod                │
                     │ kubectl rollout restart           │
                     │ taint manager (NoExecute)         │
                     │ podgc                             │
                     └───────────────────────────────────┘
```

The Kubernetes docs state it outright: *"Not all voluntary disruptions are constrained by Pod Disruption Budgets. For example, deleting deployments or pods bypasses Pod Disruption Budgets."*

| Concern | Governed by |
|---|---|
| Rollout safety (how many pods down during a Deployment update) | `Deployment.spec.strategy.rollingUpdate.maxUnavailable` / `maxSurge` |
| Voluntary-disruption safety (drain, node upgrade, autoscaler defrag) | `PodDisruptionBudget` |
| Involuntary disruption (kernel panic, node loss, node-pressure eviction) | **Nothing.** Replicate + spread. |

Corollary gotcha: `maxUnavailable: 0` / `minAvailable: 100%` in a PDB means **zero** voluntary evictions — `kubectl drain` on a node running such a pod **never completes**. That is documented, intended behavior, not a bug.

---

## ReplicaSet Scale-Down Victim Ordering

When the RS controller must delete `n` pods it sorts its children with `ActivePodsWithRanks.Less` and deletes from the front. Verified against `pkg/controller/controller_utils.go`:

| # | Criterion | Deleted first |
|---|---|---|
| 1 | Node assignment | pods with empty `spec.nodeName` |
| 2 | Phase ordinal | `Pending` < `Unknown` < `Running` |
| 3 | Readiness | not-ready before ready |
| 4 | **`controller.kubernetes.io/pod-deletion-cost`** | **lower cost first** ← the knob *you* control |
| 5 | "Doubled up" rank | pods on nodes holding **more** ready pods of the same RS (preserves spread) |
| 6 | Ready duration | ready for *less* time (log-scale bucketed) |
| 7 | Restart count | **higher** max container restart count |
| 8 | `creationTimestamp` | **newer** pods (log-scale bucketed) |

```yaml
# "sacrifice this replica first on scale-down"
metadata:
  annotations:
    controller.kubernetes.io/pod-deletion-cost: "-100"   # int32; default 0
```

> **Note:** Two nuances. (a) `pod-deletion-cost` is gated by the `PodDeletionCost` feature gate, which has been **Beta, default-on since 1.22** and has *never* graduated to GA — so it is available on essentially every modern cluster, but a paranoid platform could disable it. (b) Criteria 6 and 8 use `logarithmicRankDiff`, so pods within the same logarithmic time bucket are treated as **ties** and broken by UID. This intentionally randomises victim selection among similarly-aged pods instead of always killing the newest — it prevents a churning workload from repeatedly destroying whichever pod just started.

---

## Why So Few Terminal Pods Are Visible in Practice

`kubectl get pods` does **not** filter by phase — `Failed` and `Succeeded` pods are listed. If you rarely see them, the *supply* is small, not the display. Three unrelated reasons:

**1. `Succeeded` is structurally impossible for Deployment pods.**

```
Succeeded  ⇐  all containers exited 0  AND  none will be restarted

restartPolicy: Always   ← mandatory for Deployment / StatefulSet / DaemonSet
        ↓
kubelet restarts every container on every exit, always
        ↓
reachable phases: Pending, Running, Failed.   Succeeded: unreachable.
```

`Succeeded` requires `restartPolicy: OnFailure` or `Never` → Jobs, CronJobs, and bare pods only.

**2. Job/CronJob pods are reaped long before 12500, by an entirely different mechanism.**

```
CronJob (successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1  ← defaults)
      │
      └─▶ cronjob-controller DELETEs the Job objects beyond the limits
              │
              └─▶ cascading GC: the pods' OWNER genuinely disappeared
                      │
                      └─▶ pods deleted   ← the exact path that did NOT fire
                                            for RS-owned Failed pods

Job (ttlSecondsAfterFinished: 600)
      └─▶ ttl-after-finished-controller DELETEs the Job → same cascade
```

Net effect: **podgc's 12500 is a backstop that almost never engages**, because owner-cascade already handles the high-volume producers. The gotcha: `ttlSecondsAfterFinished` has **no default**, so bare `Job`s created without it *do* accumulate their pods forever.

**3. Namespace scoping.** 261 was a cluster-wide (`-A`) count; `kubectl get pods` is namespaced.

### Investigation Playbook

```bash
# Terminal pods in one namespace
kubectl -n <ns> get pods --field-selector=status.phase==Failed

# Cluster-wide, with the fields that actually matter
kubectl get pods -A --field-selector=status.phase==Failed \
  -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,REASON:.status.reason,NODE:.spec.nodeName,AGE:.metadata.creationTimestamp'

# Histogram of failure reasons — the fastest way to spot a systemic race
kubectl get pods -A --field-selector=status.phase==Failed \
  -o jsonpath='{range .items[*]}{.status.reason}{"\n"}{end}' | sort | uniq -c | sort -rn

# Which nodes are minting them (correlate with max-pods)
kubectl get pods -A --field-selector=status.phase==Failed \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort | uniq -c | sort -rn

# Confirm podgc is nowhere near its threshold
kubectl get pods -A --field-selector=status.phase==Failed    --no-headers | wc -l
kubectl get pods -A --field-selector=status.phase==Succeeded --no-headers | wc -l
```

> **Gotcha:** `--field-selector` supports `status.phase`, `spec.nodeName`, and `metadata.name/namespace` for pods, but **not** `status.reason`. Reason filtering must happen client-side (as above). A `--field-selector=status.reason=OutOfpods` will be rejected by the API server.

**Events age out** — `kube-apiserver --event-ttl` defaults to **1h0m0s**, enforced via an etcd lease. So for "who deleted this pod?" the **audit log is authoritative**. On GKE, query Cloud Logging:

```
protoPayload.methodName="io.k8s.core.v1.pods.delete"
protoPayload.resourceName="core/v1/namespaces/<ns>/pods/<name>"
```

and read `protoPayload.authenticationInfo.principalEmail` to distinguish:

| principal | meaning |
|---|---|
| `system:serviceaccount:kube-system:pod-garbage-collector` | podgc |
| `system:serviceaccount:kube-system:replicaset-controller` | scale-down / rollout |
| `system:node:<node-name>` | kubelet's grace-0 finalizing delete (**not** the decision) |
| `system:kube-scheduler` | preemption |
| a human email | someone did it by hand |

Expect **two** `pods.delete` entries for a normal termination: the initiator's, then kubelet's grace-0 one. The **first** is the answer.

---

## Owner Deletion Ordering: `propagationPolicy`

| Policy | Order | Owner state during deletion |
|---|---|---|
| `Background` (**kubectl default**) | Owner first, children asynchronously afterwards | Removed from etcd **immediately**; `kubectl` returns instantly |
| `Foreground` | Children first, owner last | Owner gets `deletionTimestamp` + a `foregroundDeletion` finalizer and sits in *"deletion in progress"* until blocking children are gone |
| `Orphan` | Owner only | Children survive; GC strips the now-dangling `ownerReference` |

```
Background — kubectl delete deployment api
  t0  DELETE deployments/api                 → gone from etcd. kubectl exits. ✔
  t0+ generic-garbage-collector walks the graph:
        Deployment(absent) ⇒ its RSes are orphans   → DELETE ReplicaSets
        ReplicaSet(absent) ⇒ its Pods are orphans   → DELETE Pods
  ⇒ this is exactly why `kubectl get pods` still shows pods for ~30s
    after `kubectl delete deployment` "succeeded".

Foreground — kubectl delete deployment api --cascade=foreground
  t0  DELETE deployments/api
        API server sets: deletionTimestamp = now
                         finalizers += ["foregroundDeletion"]
        object REMAINS visible via the API
  t1  GC deletes dependents. Only those with
        ownerReference.blockOwnerDeletion: true
      hold up the owner; others are deleted but do not block.
  t2  last blocking dependent gone
        → GC removes the "foregroundDeletion" finalizer
        → object disappears from etcd

Orphan — kubectl delete deployment api --cascade=orphan
  t0  DELETE deployments/api → gone
  t1  GC strips ownerReferences from the RSes
  ⇒ ReplicaSets and Pods keep running, now unmanaged.
```

Set it with `kubectl delete --cascade=background|foreground|orphan` (default `background`, per `delete_flags.go`), or in the request body:

```json
{ "apiVersion": "meta.k8s.io/v1", "kind": "DeleteOptions",
  "propagationPolicy": "Foreground" }
```

> **Note:** Foreground is weaker than it looks. Per the official docs, *"the only dependents that block owner deletion are those that have the `ownerReference.blockOwnerDeletion=true` field **and are in the garbage collection controller cache**."* Objects whose resource type cannot be listed/watched (a broken aggregated API, a CRD served by a down conversion webhook — see [[notes/K8s/kube-apiserver-request-routing|kube-apiserver Request Routing]]) are simply absent from that cache and silently fail to block. Foreground is a best-effort ordering hint, not a transaction.

---

## Finalizers, `deletionTimestamp`, and Blocking Deletion

### Can a Webhook Un-Delete an Object by Stripping `deletionTimestamp`?

**No** — three independent defenses, any one of which is sufficient.

```
① Mutating webhooks cannot mutate on DELETE
   AdmissionReview.request = { object: null, oldObject: <the object> }
   There is nothing to patch. Any JSONPatch in the response is IGNORED.

② The transition is not an interceptable UPDATE
   Graceful deletion runs inside the registry layer, BELOW admission:
     Store.Delete
       └─ updateForGracefulDeletionAndFinalizers
            └─ Storage.GuaranteedUpdate(...)      ← writes deletionTimestamp
   This is not an UPDATE request. A webhook registered on UPDATE is
   never invoked for it.

③ deletionTimestamp is immutable once set
   ValidateObjectMetaAccessorUpdate treats it like uid / creationTimestamp /
   deletionGracePeriodSeconds.
```

Verified in `apimachinery/pkg/api/validation/objectmeta.go`:

```go
allErrs = append(allErrs, ValidateImmutableField(
    newMeta.GetDeletionTimestamp(), oldMeta.GetDeletionTimestamp(),
    fldPath.Child("deletionTimestamp")).WithOrigin("immutable")...)
```

> **Note (refinement).** The two directions behave *differently*, and the difference is worth knowing:
>
> | Attempt | Mechanism | Observable result |
> |---|---|---|
> | old `nil` → new `set` (fake a deletion) | `ValidateImmutableField` fires | **422 Invalid**: `metadata.deletionTimestamp: Invalid value: ...: field is immutable` |
> | old `set` → new `nil` (un-delete) | `rest.BeforeUpdate` silently restores it *before* validation: `if !oldMeta.GetDeletionTimestamp().IsZero() { objectMeta.SetDeletionTimestamp(oldMeta.GetDeletionTimestamp()) }` — so new == old by the time validation runs | **200 OK with no effect.** The write "succeeds"; the field does not change. |
>
> The second case is the dangerous one: a naive controller sees success and assumes it worked. **You cannot un-delete an object.**

Companion guardrail — you cannot add a finalizer *after the fact*. `ValidateNoNewFinalizers` runs whenever `oldMeta.GetDeletionTimestamp() != nil`, with the exact message:

```
metadata.finalizers: Forbidden: no new finalizers can be added if the object
is being deleted, found new finalizers ["example.com/cleanup"]
```

### What Actually Works

**To *delay* deletion and run cleanup: a finalizer, added *before* deletion.**

```
1. reconcile  │ PATCH metadata.finalizers += "example.com/cleanup"
              │ (must happen while deletionTimestamp is still nil)
2. user       │ DELETE obj
   apiserver  │ deletionTimestamp = now; finalizers non-empty
              │ ⇒ object is NOT removed. Phase: "Terminating".
3. controller │ sees deletionTimestamp != nil
              │ → tear down the external resource (S3 bucket, DNS record, …)
4. controller │ PATCH metadata.finalizers -= "example.com/cleanup"
5. apiserver  │ finalizers list now empty → key removed from etcd
```

Semantics: **a finalizer blocks deletion; it does not cancel it.** Once `deletionTimestamp` is set the object is in a terminal state with no path back to alive. A controller that never removes its finalizer produces the classic *stuck-in-Terminating-forever* object — identical failure mode to a wedged Namespace. That is a **bug, not a veto**.

**To *prevent* deletion: a validating webhook on `DELETE` returning `allowed: false`.** This rejects the request in the admission chain, *before* `deletionTimestamp` is ever written. It is the only genuine veto.

| Mechanism | Runs when | Effect | Can the object survive? |
|---|---|---|---|
| **Validating webhook on DELETE** | before `deletionTimestamp` is set | request rejected, e.g. `403` | **Yes** — nothing changed |
| **Finalizer** | after `deletionTimestamp` is set | deletion *paused* pending cleanup | **No** — terminal state, one-way |
| **Mutating webhook on DELETE** | before, but patch ignored | nothing | No — it's a no-op |

### Admission on DELETE — the Wire Format

`DELETE` **is** valid in `webhooks[].rules[].operations` (the full set is `CREATE`, `UPDATE`, `DELETE`, `CONNECT`, `*`), and the API server really does call mutating webhooks for it. It is just pointless for mutation.

```json
{
  "apiVersion": "admission.k8s.io/v1",
  "kind": "AdmissionReview",
  "request": {
    "uid": "705ab4f5-...",
    "kind":     { "group": "apps", "version": "v1", "kind": "Deployment" },
    "resource": { "group": "apps", "version": "v1", "resource": "deployments" },
    "subResource": "",
    "name": "my-deployment",
    "namespace": "default",
    "operation": "DELETE",
    "userInfo": {
      "username": "system:serviceaccount:kube-system:replicaset-controller",
      "groups": ["system:serviceaccounts", "system:authenticated"]
    },
    "object": null,
    "oldObject": { "…": "full current object as persisted in etcd" },
    "options": {
      "apiVersion": "meta.k8s.io/v1",
      "kind": "DeleteOptions",
      "gracePeriodSeconds": 30,
      "propagationPolicy": "Background",
      "preconditions": { "uid": "...", "resourceVersion": "..." }
    },
    "dryRun": false
  }
}
```

| Field | Why it matters on DELETE |
|---|---|
| `object: null` | Nothing to mutate. This is the structural reason mutating-on-DELETE is impossible. |
| `oldObject` | The current persisted state, **before** `deletionTimestamp` is written. Populated **only since Kubernetes 1.15** ([PR #76346](https://github.com/kubernetes/kubernetes/pull/76346)); earlier releases sent `null` here too, which is why DELETE webhooks were historically useless. |
| `options` | **Unique to DELETE.** Lets you detect `gracePeriodSeconds: 0` force-deletes, inspect the `propagationPolicy`, and see `preconditions`. |
| `userInfo` | The initiator. The basis for nearly every "block deletes except by X" policy. |
| `dryRun` | Honor it. Never fire side effects when `true`. |

Response — the only shape that vetoes anything:

```json
{ "apiVersion": "admission.k8s.io/v1", "kind": "AdmissionReview",
  "response": { "uid": "<echo request.uid>", "allowed": false,
                "status": { "code": 403, "message": "deletion of prod deployments requires a break-glass annotation" } } }
```

**Gotchas that bite real DELETE webhooks:**

```
① EVICTIONS DO NOT ARRIVE AS DELETE
   POST .../pods/<name>/eviction  ⇒  operation:   CREATE
                                     resource:    pods
                                     subResource: eviction
   A webhook with rules[operations: ["DELETE"], resources: ["pods"]]
   SILENTLY MISSES every drain, cluster-autoscaler, and descheduler
   removal. To cover both you need two rules:
       - operations: ["DELETE"], resources: ["pods"]
       - operations: ["CREATE"], resources: ["pods/eviction"]
   Note `resources: ["*"]` matches resources but NOT subresources;
   you need "*/*" or "pods/*" to catch the eviction subresource.

② deletecollection FANS OUT
   One DELETE on a collection ⇒ one AdmissionReview PER OBJECT.
   With failurePolicy: Fail and a flaky webhook, a bulk delete
   becomes a PARTIAL delete.

③ objectSelector MATCHES AGAINST oldObject ON DELETE
   A null object (object on delete, oldObject on create) is NOT
   considered a match. Same for matchConditions CEL: reference
   oldObject.metadata, not object.metadata.

④ failurePolicy: Fail ON A DELETE WEBHOOK IS A CLUSTER FOOTGUN
   Webhook unavailable ⇒ ALL deletions of matched resources are
   blocked cluster-wide. If the matched resource is broad (or the
   webhook's own namespace is matched) you cannot delete your way
   out. Always scope with namespaceSelector / matchConditions and
   exclude kube-system.

⑤ sideEffects MUST BE HONEST
   v1 allows only `None` or `NoneOnDryRun`. Declare wrongly and
   dry-run requests either skip your webhook or the API request
   fails outright.

⑥ CONNECT IS THE SAME STORY
   pods/exec, attach, portforward reach webhooks as CONNECT.
   Callable, auditable, vetoable — but not mutable.
```

Default webhook `timeoutSeconds` is **10 s**; keep DELETE webhooks well under that, since every controller-driven scale-down pays the latency.

---

## See also

- [[notes/K8s/kube-apiserver-request-routing|kube-apiserver Request Routing]] — the request pipeline, what the API server owns beyond etcd, and the `pods/eviction` / `pods/binding` subresource logic referenced above.
- [[notes/K8s/daemonset-pod-race-conditions|DaemonSet Pod Race Conditions]] — the bind→admit race class that generates `OutOfpods` tombstones.
- [[notes/K8s/hpa-vpa-autoscaling|HPA / VPA / metrics-server]] — the other half of the scale-down story (who decides `.spec.replicas`).
- [[notes/kubebuilder/multi_version_webhook|Multi-Version CRDs & Conversion Webhooks]] — the *conversion* webhook axis, distinct from admission-on-DELETE.
- [[notes/K8s/kubernetes|Kubernetes Concepts]] — taints, tolerations, scheduling primitives.
- Official: [Pod Lifecycle — Termination & Pod garbage collection](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- Official: [Garbage Collection — cascading deletion](https://kubernetes.io/docs/concepts/architecture/garbage-collection/)
- Official: [API-initiated Eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/api-eviction/)
- Official: [Disruptions — voluntary vs involuntary](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/)
- Official: [ReplicaSet — Pod deletion cost](https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/#pod-deletion-cost)
- Official: [Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
- Official: [Dynamic Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/)
- Official: [`kube-controller-manager` flags](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/)
- Source: [`pkg/controller/podgc/gc_controller.go`](https://github.com/kubernetes/kubernetes/blob/master/pkg/controller/podgc/gc_controller.go)
- Source: [`pkg/controller/controller_utils.go`](https://github.com/kubernetes/kubernetes/blob/master/pkg/controller/controller_utils.go) (`IsPodActive`, `ActivePodsWithRanks`)
- Source: [`pkg/kubelet/status/status_manager.go`](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/status/status_manager.go) (the grace-0 finalizing delete)
- Repo: [`kubernetes-sigs/descheduler`](https://github.com/kubernetes-sigs/descheduler) — `RemoveFailedPods`

---

## Interview Prep

### Q: Who deletes a pod? Walk me through the whole thing.

**A:** Three actors, three acts. Nobody "deletes a pod" alone, because a pod is both an etcd key and a set of Linux processes, and no single component owns both.

```
ACT 1 — DECIDE                     ACT 2 — KILL                ACT 3 — REMOVE
initiator                          kubelet                     API server
─────────                          ───────                     ──────────
DELETE /api/v1/ns/x/pods/y         watch fires: deletionTS!=nil DELETE ...?
   ↓                                  ↓                        gracePeriodSeconds=0
apiserver: authn/authz/admission   preStop hook                Preconditions{uid}
   ↓                               SIGTERM to PID 1               ↓
registry: markAsDeleting              ↓                        finalizers empty?
  deletionTimestamp = now          wait terminationGrace           ↓ yes
  deletionGracePeriodSeconds = 30  Period (default 30s)         etcd key REMOVED
   ↓                                  ↓                        audit event
OBJECT STILL IN ETCD               SIGKILL if still alive
Pod shows "Terminating"               ↓
                                   remove sandbox, unmount
                                   volumes, delete cgroups,
                                   release pod IP
                                      ↓
                                   (control plane concurrently
                                    pulls pod out of EndpointSlices)
```

Who is the "initiator" depends on the scenario: `replicaset-controller` (scale-down / rolling update), you (`kubectl delete pod`), `kube-scheduler` (preemption), the API server's own eviction handler (drain / autoscaler / descheduler), node-lifecycle controller (NoExecute taint), or podgc.

**The answer they're fishing for:** if forced to name one, name the **initiator** — that's the intent, and it's the first `delete pods` entry in the audit log. Kubelet's grace-0 delete in Act 3 is bookkeeping. And *never* say "kubelet deletes it from etcd" — kubelet has no etcd access whatsoever.

### Q: I have 261 `Failed` pods owned by a healthy ReplicaSet. Why hasn't anything cleaned them up?

**A:** Because all three candidate mechanisms are inapplicable — and two of them for reasons that are the *opposite* of what people expect.

| Mechanism | Trigger | Why it doesn't fire |
|---|---|---|
| Cascading GC | owner object **gone** | Owner RS is **alive**. Ownership is *why* they persist. A naked Failed pod is also never GC'd — this path is not phase-aware at all. |
| ReplicaSet controller | — | `IsPodActive()` returns false for `Failed`, so the pod isn't counted toward `replicas` **and the controller has no reaping loop for it**. Deliberate: terminal pods are debugging artifacts. |
| podgc `gcTerminated` | cluster-wide terminated count **>** `--terminated-pod-gc-threshold` (12500) | `deleteCount = 261 - 12500 = -12239` → returns immediately |

The framing "they're Failed so GC should take them" is backwards. Nothing in Kubernetes deletes a terminal pod that still has a living owner, until the cluster-wide count crosses 12500.

### Q: What exactly does `--terminated-pod-gc-threshold` do? Common wrong answer?

**A:** Wrong answer: "terminal pods get deleted after 12500 seconds / after 12500 exist per namespace / 12500 is a delay." All wrong.

It is a **cluster-wide high-water mark**, evaluated every 20 s:

```go
deleteCount := terminatedPodCount - gcc.terminatedPodThreshold
if deleteCount <= 0 { return }
sort.Sort(byEvictionAndCreationTimestamp(terminatedPods))
for i := 0; i < deleteCount; i++ { markFailedAndDeletePod(terminatedPods[i]) }
```

```
 count = 12600, threshold = 12500
   ↓
 deleteCount = 100   → delete exactly 100, leaving 12500
                       (evicted pods first, then oldest, then by name)
```

Three gotchas:
1. It deletes **only the overflow** — it does not drain to zero.
2. Ordering is **evicted-first, then oldest** (`byEvictionAndCreationTimestamp`) — the comment in-tree says *"Evicted pods will be deleted first to avoid impact on terminated pods created by controllers."* Not purely FIFO.
3. Setting it to `0` or negative **disables `gcTerminated` entirely** (`if gcc.terminatedPodThreshold > 0`). The other three podgc paths keep running.

And on GKE / EKS / AKS you cannot change it — it's a `kube-controller-manager` flag on a control plane you don't own.

### Q: podgc has four code paths. Which ones ignore the threshold, and why does that matter operationally?

**A:** Only `gcTerminated` is gated. The other three are unconditional safety valves.

```
gc() every 20s
├── if threshold > 0 → gcTerminated             ← THE ONLY GATED ONE
│      phase ∉ {Pending,Running,Unknown}
├── gcTerminating                                (ungated)
│      deletionTS != nil ∧ node NOT Ready
│                       ∧ node has node.kubernetes.io/out-of-service
├── gcOrphaned                                   (ungated)
│      spec.nodeName points at a Node OBJECT THAT NO LONGER EXISTS
│      (40s quarantineTime, then a confirming GET to avoid informer lag)
└── gcUnscheduledTerminating                     (ungated)
       deletionTS != nil ∧ spec.nodeName == ""
```

Operational significance:

- **`gcOrphaned`** is the sneaky one people notice without understanding: scale a node pool down and every terminal pod on those nodes disappears too. If your tombstones are pinned to *live* at-capacity nodes, you never get that free cleanup.
- **`gcTerminating`** is the manual escape hatch for a genuinely dead node: you taint it `node.kubernetes.io/out-of-service`, and pods stuck `Terminating` (because their kubelet will never come back to send the grace-0 delete) get force-removed, which in turn lets StatefulSet/attach-detach controllers safely reattach volumes elsewhere. Requires the node to also be NotReady.
- **`gcUnscheduledTerminating`** covers pods deleted before the scheduler ever bound them — there is no kubelet to finalize them, so podgc must.
- All four use grace period **0** and first PATCH `phase=Failed` (so orphans don't sit in `Running` forever), attaching a `DisruptionTarget` condition — e.g. `reason: DeletionByPodGC`. `PodDisruptionConditions` was stable in 1.31 and the gate was removed in 1.34, so this is unconditional now.

### Q: Does a PodDisruptionBudget protect my Deployment during a rolling update?

**A:** **No.** This is the classic gotcha.

```
                       PDB CHECKED?
POST pods/<n>/eviction      YES        ← drain, cluster-autoscaler, descheduler
DELETE pods/<n>             NO         ← rolling update, scale-down,
                                          kubectl delete pod, rollout restart,
                                          taint manager, podgc, preemption*
```

PDB enforcement lives entirely in the API server's **`pods/eviction` subresource handler**, which returns `200` (allowed, then deletes), `429` (blocked by budget), or `500` (pod covered by more than one PDB). The generic `DELETE` route has no PDB code path at all. Official docs: *"deleting deployments or pods bypasses Pod Disruption Budgets."*

| You want to protect against… | Use |
|---|---|
| too many pods down during your own rollout | `strategy.rollingUpdate.maxUnavailable` / `maxSurge` |
| node drains, node upgrades, autoscaler defrag | `PodDisruptionBudget` |
| kernel panic, node loss, node-pressure eviction | nothing — replicate & spread (topology spread / anti-affinity) |

\* Scheduler preemption treats PDBs as **advisory** — it prefers victims that don't violate a PDB, but will violate one rather than fail to schedule a higher-priority pod.

Bonus gotcha: `maxUnavailable: 0` means `kubectl drain` on a node running that pod **hangs forever**. Documented, intended.

### Q: `kubectl rollout restart` — which component actually deletes the pods?

**A:** The **old ReplicaSet's controller**. `kubectl` deletes nothing and the Deployment controller deletes no pods.

```
kubectl  ── PATCH deployments/api ─────────────────────────┐
            spec.template.metadata.annotations             │ ONE API call,
              kubectl.kubernetes.io/restartedAt: <RFC3339> │ and it's a PATCH
                          │                                 ┘
        new template ⇒ new pod-template-hash
                          │
   deployment-controller ─┤
        ├── CREATE  rs/api-<newhash>
        ├── PATCH   rs/api-<newhash>.spec.replicas: 0 → n
        └── PATCH   rs/api-<oldhash>.spec.replicas: n → 0
                          │
   replicaset-controller ─┤   (the OLD rs, reconciling its own children)
        └── DELETE pods/api-<oldhash>-xxxxx     ◀── THE ACTUAL DELETER
                          │                          identity in audit:
                          │            system:serviceaccount:kube-system:
                          │                        replicaset-controller
   kubelet ───────────────┤
        └── SIGTERM → grace → SIGKILL → DELETE ...?gracePeriodSeconds=0
```

The Deployment controller's *only* write to pod count is `.spec.replicas` on ReplicaSets. It does delete **old ReplicaSet objects** per `revisionHistoryLimit` (default 10), but those already have `replicas: 0` and no children by then.

Identical chain for any template mutation — image bump, env change, resource change. `rollout restart` is just "mutate the template without changing behavior."

### Q: A pod has been `Terminating` for 20 minutes. Diagnose it.

**A:** `Terminating` means Act 1 completed (`deletionTimestamp` is set) and Act 3 never ran. Exactly two causes.

```
kubectl get pod X -o jsonpath='{.metadata.deletionTimestamp}{"\n"}{.metadata.finalizers}'
                                      │
        ┌─────────────────────────────┴───────────────────────────┐
        ▼                                                         ▼
 finalizers NON-EMPTY                                    finalizers EMPTY
        │                                                         │
 A controller owes you a                              Nobody is sending the
 finalizer removal and isn't                          grace-0 finalizing DELETE
 delivering.                                                      │
   • its Deployment is down / crashlooping             • node NotReady / kubelet dead
   • its RBAC lost patch on the resource               • kubelet wedged (PLEG unhealthy,
   • it panics on this object                            container runtime hung)
   • the CRD's owner was uninstalled                   • a container ignoring SIGTERM
     WITHOUT cleaning up finalizers                      past the grace period
        │                                                         │
 FIX: fix or scale up the controller.                  FIX: for a genuinely dead node,
 Last resort: kubectl patch pod X                      taint it
   -p '{"metadata":{"finalizers":null}}'                 node.kubernetes.io/out-of-service
   --type=merge                                        → podgc's gcTerminating force-deletes.
 (leaks whatever the finalizer was                     Or: kubectl delete pod X
  supposed to clean up)                                     --grace-period=0 --force
```

Diagnostic sequence:

```bash
kubectl get pod X -o yaml | grep -A5 'deletionTimestamp\|finalizers'
kubectl get node $(kubectl get pod X -o jsonpath='{.spec.nodeName}')   # Ready?
kubectl describe node <node> | grep -i 'PLEG\|KubeletNotReady\|Pressure'
# and check the audit log: was there ever a SECOND delete (from system:node:<node>)?
```

Never reach for `--force --grace-period=0` as a first move: it removes the API object while the containers may still be **running** on the node — a real split-brain risk for StatefulSets and RWO volumes. That is precisely why the `out-of-service` taint path exists.

### Q: Can a mutating webhook prevent a deletion by removing `deletionTimestamp`?

**A:** No, three times over.

```
① object: null on DELETE          → nothing to patch; response patch IGNORED
② deletionTimestamp is written by  Store.updateForGracefulDeletionAndFinalizers
   → Storage.GuaranteedUpdate      → BELOW admission. Not an UPDATE request.
                                      An UPDATE webhook is never called for it.
③ deletionTimestamp is immutable   → ValidateImmutableField, same class as
                                      uid / creationTimestamp / deletionGracePeriodSeconds
```

The asymmetry in ③ is the interesting bit:

| Direction | What the API server does | What the client sees |
|---|---|---|
| `nil` → set (fake a delete) | `ValidateImmutableField` catches it | `422`: `metadata.deletionTimestamp: field is immutable` |
| set → `nil` (un-delete) | `rest.BeforeUpdate` silently restores the old value *before* validation runs, so new==old | **`200 OK`, no change.** Silent no-op — the dangerous one. |

You also cannot bolt on a finalizer late: `metadata.finalizers: Forbidden: no new finalizers can be added if the object is being deleted, found new finalizers [...]`.

### Q: Finalizer vs. validating webhook — which one blocks a deletion, and what's the difference?

**A:** They operate on opposite sides of the point of no return.

```
      DELETE request
            │
   ┌────────▼─────────┐
   │ VALIDATING       │  ← THE ONLY REAL VETO
   │ WEBHOOK on DELETE│    allowed:false ⇒ 403, request never reaches the
   │                  │    registry. deletionTimestamp NEVER WRITTEN.
   └────────┬─────────┘    Object is completely untouched. Reversible.
            │ allowed
   ┌────────▼─────────┐
   │ registry layer   │
   │ deletionTimestamp│  ◀══ POINT OF NO RETURN ══════════════════
   │ = now            │
   └────────┬─────────┘
            │
   ┌────────▼─────────┐
   │ FINALIZERS       │  ← A DELAY, NOT A VETO
   │ non-empty?       │    Object persists in "Terminating" while controllers
   │  yes → keep      │    do cleanup, then remove their own finalizer.
   └────────┬─────────┘    There is NO path back to alive.
            │ empty
      etcd key removed
```

| | Validating webhook on DELETE | Finalizer |
|---|---|---|
| Prevents deletion? | **Yes** | No — only delays it |
| Object recoverable? | Yes, never modified | **No**, terminal state |
| Added when | any time (webhook config is independent) | **must exist before** the DELETE lands |
| Typical use | policy — "no deleting prod without break-glass" | cleanup — release an S3 bucket, DNS record, cloud LB |
| Failure mode | webhook down + `failurePolicy: Fail` ⇒ **no deletions cluster-wide** for matched resources | controller down ⇒ object **stuck Terminating forever** (same as a wedged namespace) |

Both failure modes are how people wedge clusters. Scope DELETE webhooks with `namespaceSelector` / `matchConditions` and exclude `kube-system`.

### Q: I wrote a DELETE webhook to audit pod removals. Why does it miss `kubectl drain`?

**A:** Because **evictions are not DELETEs.** `kubectl drain` POSTs an `Eviction` object to a subresource:

```
POST /api/v1/namespaces/<ns>/pods/<name>/eviction
Content-Type: application/json
{ "apiVersion": "policy/v1", "kind": "Eviction",
  "metadata": { "name": "<name>", "namespace": "<ns>" } }

  ⇒ AdmissionReview.request:
       operation:   CREATE      ← not DELETE
       resource:    pods
       subResource: eviction
```

So a rule of `operations: ["DELETE"], resources: ["pods"]` never matches. To cover both paths:

```yaml
rules:
  - operations: ["DELETE"]
    apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods"]
  - operations: ["CREATE"]
    apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods/eviction"]     # "*" does NOT match subresources
```

Remember `resources: ["*"]` matches resources but **not** subresources — you need `"*/*"` or `"pods/*"`. And on the eviction path, `oldObject` is `null` while `object` is the tiny `Eviction` object, so your handler must read the pod name from `request.name`, not from the payload.

Other blind spots on the same theme: `deletecollection` fans out to **one AdmissionReview per object** (so `failurePolicy: Fail` + one flake = partial delete), and `objectSelector` / `matchConditions` on DELETE must reference `oldObject.metadata`, because `object` is `null` and a null object never matches.

### Q: `Foreground` vs `Background` cascade — and why does `kubectl delete deployment` return before the pods are gone?

**A:** Because `Background` is the default, and it deletes the owner **first**.

```
BACKGROUND (default)                    FOREGROUND (--cascade=foreground)
────────────────────                    ─────────────────────────────────
t0  DELETE deployment                   t0  DELETE deployment
    → key REMOVED from etcd                 → deletionTimestamp = now
    → kubectl returns ✔ instantly           → finalizers: [foregroundDeletion]
                                            → object STILL VISIBLE, "deleting"
t0+ GC walks the ownership graph
    Deployment gone ⇒ RS orphaned       t1  GC deletes dependents.
      → DELETE ReplicaSet                   Only those with
    RS gone ⇒ Pods orphaned                 ownerReference.blockOwnerDeletion:true
      → DELETE Pods                         hold up the owner.
    each Pod then does the full          t2  last blocker gone
    3-act termination dance                  → GC removes foregroundDeletion
                                             → owner disappears
⇒ pods visible for tens of seconds      ⇒ kubectl blocks until children are gone
  AFTER kubectl says "deleted"
```

| Policy | `deleteOptions.propagationPolicy` | Order | Children survive? |
|---|---|---|---|
| Background | `"Background"` | owner → children (async) | no |
| Foreground | `"Foreground"` | children → owner | no |
| Orphan | `"Orphan"` | owner only | **yes**, `ownerReference` stripped |

Nuance worth stating: Foreground is **best-effort ordering, not a transaction**. Per the docs, the only dependents that block are those with `blockOwnerDeletion: true` **and present in the GC controller's cache** — a resource type the GC can't list/watch (broken aggregated API, CRD with a dead conversion webhook) silently fails to block.

### Q: Why is `Succeeded` essentially impossible for Deployment pods, and why doesn't the 12500 threshold matter for Jobs?

**A:** Two different answers that both explain why terminal pods are rarer than the threshold implies.

**`Succeeded` needs containers to exit 0 and *stay* exited.** Deployment / StatefulSet / DaemonSet all require `restartPolicy: Always` (validation rejects anything else), so kubelet restarts every container on every exit:

```
restartPolicy: Always  ⇒  reachable phases = {Pending, Running, Failed}
                          Succeeded is UNREACHABLE
```

`Succeeded` only happens with `OnFailure` / `Never` → Jobs, CronJobs, bare pods.

**And those are reaped by owner-cascade, not by podgc:**

```
CronJob  successfulJobsHistoryLimit: 3   ← defaults, always set by defaulting
         failedJobsHistoryLimit:     1
    └── cronjob-controller DELETEs excess Job objects
          └── cascading GC: owner GENUINELY GONE → pods deleted   ✔

Job      ttlSecondsAfterFinished: <n>    ← NO default
    └── ttl-after-finished-controller DELETEs the Job → same cascade
```

So the high-volume producers of terminal pods are handled by the *one* GC path that requires the owner to disappear — and their owners really do. **podgc's 12500 is a backstop that almost never engages.** The gap: a bare `Job` with no `ttlSecondsAfterFinished` and no CronJob parent accumulates its pods forever, exactly like RS-owned `Failed` pods.

### Q: Explain the bind→admit race that produces `OutOfpods`, and how you'd actually fix it.

**A:** The scheduler decides placement from a cache; kubelet decides admission from ground truth. When they disagree, kubelet wins and a tombstone is born.

```
 ┌─────────────┐                          ┌──────────────────────┐
 │ kube-        │  node-7: 31/32 pods     │ node-7 (max-pods=32) │
 │ scheduler    │  (per its snapshot,     │ ACTUAL admitted: 32  │
 │              │   plus in-flight        │                      │
 │              │   assumed pods)         │                      │
 └──────┬───────┘                         └──────────┬───────────┘
        │ POST pods/<name>/binding                   │
        │ spec.nodeName = node-7                     │
        ▼                                            │
   ═══ etcd: pod is now BOUND ═══                     │
        │  watch                                     │
        └────────────────────────────────────────────▶
                                          kubelet admit handler:
                                          InsufficientResourceError{
                                            ResourceName: pods,
                                            Requested: 1, Used: 32, Capacity: 32 }
                                                     │
                                          PATCH pods/<name>/status
                                            phase:  Failed
                                            reason: OutOfpods
                                            message: "Node didn't have enough
                                              resource: pods, requested: 1,
                                              used: 32, capacity: 32"
                                                     │
                            ┌────────────────────────▼───────────────────┐
                            │ NO DELETE IS EVER ISSUED.                  │
                            │ Permanent tombstone: live owner, not       │
                            │ IsPodActive, below podgc's threshold.      │
                            └────────────────────────────────────────────┘
                                                     │
                            RS controller: active 2/3 → CREATE replacement
                                          (additive; the tombstone stays)
```

Why it's *chronic* rather than occasional: with 869/1010 nodes capped at ≤32 pods, essentially every node lives permanently at the boundary where the two views can differ by one. Small `max-pods` ⇒ tight boundary ⇒ high race frequency ⇒ steady tombstone minting. 184 `OutOfpods` is accumulated interest.

Note `OutOfpods` is the **admission predicate** rejection, structurally different from the **eviction manager** (`reason: Evicted`, `DiskPressure`/`MemoryPressure`), even though both end at "kubelet wrote `Failed` and deleted nothing." Same family of race as [[notes/K8s/daemonset-pod-race-conditions|DaemonSet pod race conditions]].

Fix, in order of actually-solving-the-problem:

| | Action | Effect |
|---|---|---|
| 1 | Raise `max-pods` / use fewer, larger nodes | **removes the race.** 32 pods on a 32-vCPU node is the real defect |
| 2 | Descheduler `RemoveFailedPods` (`reasons: [OutOfpods, Evicted]`, `minPodLifetimeSeconds: 3600`) | cleans the symptom on a schedule, keeps 1h of forensics |
| 3 | Janitor CronJob | portable fallback |
| 4 | Nothing | tombstones are inert; cost is `kubectl` noise + etcd object count |

You cannot lower `--terminated-pod-gc-threshold` on GKE — it's a kube-controller-manager flag on a managed control plane.

### Q: Two audit entries appear for one pod deletion. Which one tells you who deleted it?

**A:** The **first**.

```
Cloud Logging / audit filter:
  protoPayload.methodName="io.k8s.core.v1.pods.delete"
  protoPayload.resourceName="core/v1/namespaces/prod/pods/api-8545cb-h4k2p"

t=10:02:11  principalEmail: system:serviceaccount:kube-system:replicaset-controller
            request: {}                             ← ACT 1: THE DECISION
                                                       (default grace period)

t=10:02:41  principalEmail: system:node:gke-pool-a-9x7q
            request: { gracePeriodSeconds: 0,
                       preconditions: { uid: "..." } }  ← ACT 3: bookkeeping
```

The second entry is kubelet telling the API server "the containers are gone, you may drop the key." Mistaking it for the cause is how people end up filing bugs against kubelet for a scale-down they configured themselves.

Why the audit log and not Events: `kube-apiserver --event-ttl` defaults to **1h0m0s**, so Events for anything older than an hour are simply gone. The audit log is the only durable record — and it exists precisely because the API server is the universal chokepoint (see [[notes/K8s/kube-apiserver-request-routing|kube-apiserver Request Routing]]).

### Q: Which pod does a ReplicaSet pick when scaling down, and how do you influence it?

**A:** Eight-level comparator (`ActivePodsWithRanks.Less`), delete-from-front:

```
1. unassigned (spec.nodeName == "")        ← cheapest to kill
2. Pending < Unknown < Running
3. not-ready before ready
4. LOWER controller.kubernetes.io/pod-deletion-cost   ← YOUR KNOB
5. on nodes holding MORE ready pods of this same RS   (preserves spread)
6. ready for LESS time            (logarithmic buckets)
7. HIGHER container restart count
8. NEWER creationTimestamp        (logarithmic buckets)
```

The knob:

```yaml
metadata:
  annotations:
    controller.kubernetes.io/pod-deletion-cost: "-100"   # kill me first
    # controller.kubernetes.io/pod-deletion-cost: "1000" # kill me last
```

`int32`, default `0`, negative allowed. Typical use: an app annotates its own pod with its live session/queue count so the RS drains the idlest replica first — this is how you get graceful scale-down for stateful-ish workloads without a StatefulSet.

Two nuances interviewers like: it is best-effort (the annotation is only *one* tier of the comparator — a not-ready pod still dies before your `cost: -100` ready pod, since readiness is tier 3), and it's still a **Beta** feature gate (`PodDeletionCost`, default-on since 1.22, never GA'd). Also, tiers 6 and 8 use logarithmic bucketing with a UID tie-break, which deliberately randomises among similarly-aged pods rather than always killing the newest.
