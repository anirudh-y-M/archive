---
title: "Kubernetes Autoscaling: HPA, VPA, and the metrics-server Pipeline"
---

## Overview

Kubernetes ships three independent autoscalers that operate at different layers of the stack:

- **HPA (Horizontal Pod Autoscaler)** — scales the *number of replicas* of a workload (Deployment, ReplicaSet, StatefulSet) based on observed metrics.
- **VPA (Vertical Pod Autoscaler)** — scales the *CPU/memory `requests` and `limits`* of containers inside pods.
- **Cluster Autoscaler / Karpenter** — scales the *number of nodes*. Out of scope here, but mentioned for completeness in [Interview Prep](#interview-prep).

HPA is in-tree (lives inside `kube-controller-manager`). VPA is **out-of-tree** (separate `kubernetes/autoscaler` repo, installed via three deployments). Both consume metrics from the same pipeline whose canonical entry point is **metrics-server**, an aggregated API server that serves the `metrics.k8s.io` API group.

```
                          ┌─────────────────────────────────────┐
                          │           kube-apiserver             │
                          │     (aggregation layer / proxy)      │
                          └──┬──────────────┬───────────────┬────┘
              metrics.k8s.io │              │ custom.       │ external.
                             ▼              │ metrics.k8s.io │ metrics.k8s.io
                    ┌────────────────┐      ▼               ▼
                    │ metrics-server │   ┌──────────────────────────┐
                    │ (in-memory)    │   │  Prometheus Adapter /    │
                    └──────┬─────────┘   │  KEDA / cloud adapters   │
                           │             └──────────┬───────────────┘
              scrape /metrics/resource              │
              every 15s                             │
                           ▼                        │
                ┌──────────────────────┐            │
                │  Kubelet (cAdvisor)  │            │
                │  on each node        │            │
                └──────────────────────┘            │
                                                    │
            ┌───────────────────────────────────────┴──────────┐
            │                                                  │
            ▼                                                  ▼
    ┌──────────────┐                                 ┌──────────────┐
    │     HPA      │                                 │     VPA      │
    │ (controller- │                                 │  (3 separate │
    │  manager)    │                                 │  components) │
    └──────────────┘                                 └──────────────┘
```

Throughout, the contract is "an aggregated API serving `metrics.k8s.io` (or the custom/external groups), proxied by the kube-apiserver". HPA and VPA never talk to kubelets or Prometheus directly — they always go through the apiserver.

---

## The HPA Control Loop

### Where it Runs

HPA is **not** a separate Deployment or pod. It is a controller embedded in `kube-controller-manager` (the `horizontal-pod-autoscaler` controller). A `HorizontalPodAutoscaler` object is a regular Kubernetes resource (group `autoscaling`, current stable version `autoscaling/v2`).

The controller uses an informer/lister to watch HPA objects, and reconciles each one on every sync tick.

| Flag (kube-controller-manager) | Default | Purpose |
|---|---|---|
| `--horizontal-pod-autoscaler-sync-period` | `15s` | How often the loop ticks per HPA |
| `--horizontal-pod-autoscaler-tolerance` | `0.1` (10%) | Skip scaling if `currentRatio` within this band of 1.0 |
| `--horizontal-pod-autoscaler-cpu-initialization-period` | `5m` | Pods younger than this are excluded from CPU calculations until ready |
| `--horizontal-pod-autoscaler-initial-readiness-delay` | `30s` | Pods not yet ready, but younger than this, are still considered "initializing" |
| `--horizontal-pod-autoscaler-downscale-stabilization` | `5m` | Default scale-down stabilization window |

> **Note:** Older docs (and many blog posts) reference an HPA `autoscaling/v1` API which only supports CPU. `autoscaling/v2` is the current stable version and is what you should always use. `v2beta1` and `v2beta2` were removed in v1.26.

### The Algorithm

Per HPA tick, for each metric:

```
desiredReplicas = ⌈ currentReplicas × ( currentMetricValue / desiredMetricValue ) ⌉
```

The ratio `currentMetricValue / desiredMetricValue` is called the *usage ratio*. If the ratio is within `[1 - tolerance, 1 + tolerance]`, the controller skips scaling entirely (this is the **tolerance band**, 10% by default).

#### Worked examples (target = 80% CPU utilization)

| `currentReplicas` | Average util | Ratio | Pre-tolerance desired | After tolerance check |
|---|---|---|---|---|
| 4 | 90% | 90 / 80 = 1.125 | `⌈4 × 1.125⌉ = 5` | Outside band → scale to 5 |
| 4 | 84% | 84 / 80 = 1.05 | `⌈4 × 1.05⌉ = 5` | Inside ±10% band → no change |
| 4 | 40% | 40 / 80 = 0.5 | `⌈4 × 0.5⌉ = 2` | Outside band → scale down to 2 |
| 4 | 75% | 75 / 80 = 0.9375 | n/a | Inside ±10% band → no change |

Notice the ceiling: the algorithm never returns fractional replicas. That alone provides anti-flap behavior on small workloads — a 4-replica deployment running at 90% util only needs one extra pod, not "4.5".

### Resource Metrics: Utilization is Computed Against `requests`

For `metrics.Type == Resource` (CPU/memory), the HPA reads per-pod usage from `metrics.k8s.io`, averages across **ready pods**, then computes utilization as:

```
utilization = average(usage) / sum(requests) × 100
```

This is why **every container in the targeted pod must have a CPU request set** if you HPA on CPU utilization. If a pod has no CPU request, `metrics-server` will still report usage, but the HPA cannot derive a percentage and reports `FailedGetResourceMetric` on the HPA's `.status.conditions`. The HPA will then refuse to scale on that metric.

For the `AverageValue` target type, the HPA targets a raw value (e.g. `200m` cpu per pod) instead of a percentage — this works without requests being set, but you lose the natural alignment with scheduler decisions.

### Stabilization Windows and Behavior Policies

HPA `behavior` (in `autoscaling/v2`) provides per-HPA control over both stabilization and rate of change.

```yaml
behavior:
  scaleDown:
    stabilizationWindowSeconds: 300        # default
    policies:
    - type: Percent
      value: 10
      periodSeconds: 60
    - type: Pods
      value: 4
      periodSeconds: 60
    selectPolicy: Min                      # most conservative wins
  scaleUp:
    stabilizationWindowSeconds: 0          # default
    policies:
    - type: Percent
      value: 100
      periodSeconds: 15
    - type: Pods
      value: 4
      periodSeconds: 15
    selectPolicy: Max                      # fastest scale-up wins
```

How stabilization works:

```
scaleDown.stabilizationWindowSeconds = 300

  recommended replicas over time (per tick):
   t=0s    9
   t=15s   8   ┐
   t=30s   7   │   window = last 300s
   t=...   ... │   actual replicas = MAX(window) = 9
   t=300s  6   ┘
   t=315s  6              now MAX(window) drops as t=0 falls out
                          → can finally scale down
```

For scale-down, the controller takes the **MAXIMUM recommendation** observed in the stabilization window. For scale-up the default window is `0s`, so spikes are reacted to immediately, but the policy rate limits (`Percent`, `Pods`) still cap how fast it grows.

`selectPolicy`: with multiple policies, `Min` picks the most conservative result and `Max` picks the most aggressive. `Disabled` blocks scaling in that direction entirely.

> **Note:** Kubernetes v1.33 promoted **per-HPA tolerance** to beta (feature gate `HPAConfigurableTolerance`) — `behavior.scaleUp.tolerance` and `behavior.scaleDown.tolerance` override the controller-wide `--horizontal-pod-autoscaler-tolerance`. Before 1.33 (or with the gate disabled), tolerance is cluster-global. Always confirm which version your cluster is running before relying on per-HPA tolerance.

### Multiple Metrics: HPA Takes the Max

When `spec.metrics` lists more than one metric, the controller computes `desiredReplicas` independently for each metric, then picks the **largest** value. The intuition: if any metric says "we need more pods", scale up; only when *all* metrics agree we can shrink, do we shrink.

```yaml
metrics:
- type: Resource
  resource:
    name: cpu
    target: { type: Utilization, averageUtilization: 70 }
- type: Pods
  pods:
    metric: { name: requests_per_second }
    target: { type: AverageValue, averageValue: "1k" }
- type: External
  external:
    metric: { name: sqs_queue_depth }
    target: { type: AverageValue, averageValue: "100" }
```

```
CPU says           → 6 replicas
RPS says           → 8 replicas
SQS queue depth    → 4 replicas
                     ─────────────
final desired      = MAX(6, 8, 4) = 8
```

### Special-Case Pod Handling

The HPA must be conservative with pods whose metrics are unreliable:

| Pod state | Behavior in calculation |
|---|---|
| **Ready, has metric** | Counted normally |
| **Pending / unready** | Excluded from CPU calculations (no usage data) |
| **Younger than `cpu-initialization-period` (5m default) and not yet ready** | Excluded |
| **Younger than `initial-readiness-delay` (30s default), already ready** | Counted normally — the readiness gate is what matters now |
| **Has metric is missing** | Treated **conservatively**: assumed at 100% of target during scale-DOWN (so it cannot push the average down), and at 0% during scale-UP (so it cannot push the average up) |
| **Recently deleted** | Excluded (HPA waits for converging) |

This asymmetry exists so a brief metrics-server outage cannot trick the HPA into either tearing down the deployment or scaling it to the maximum.

### Full Control Loop Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  kube-controller-manager  (HPA controller goroutine)                  │
│                                                                      │
│  every 15s, for each HPA in informer cache:                          │
│                                                                      │
│  ┌─────────┐   1. resolve scaleTargetRef → Deployment / RS           │
│  │ HPA spec│   2. read currentReplicas from Scale subresource        │
│  └────┬────┘   3. fetch metrics:                                     │
│       │             - Resource → metrics.k8s.io                      │
│       │             - Pods/Object → custom.metrics.k8s.io            │
│       │             - External → external.metrics.k8s.io             │
│       │       4. for each metric:                                    │
│       │             ratio = currentValue / targetValue               │
│       │             if |ratio - 1| <= tolerance: skip                │
│       │             else                                             │
│       │                desired_i = ⌈replicas × ratio⌉                │
│       │       5. desired = MAX(desired_i over all metrics)           │
│       │       6. clamp to [minReplicas, maxReplicas]                 │
│       │       7. apply behavior policies + stabilization windows     │
│       │       8. PATCH Scale subresource of the target               │
│       ▼                                                              │
│  HPA.status.desiredReplicas / .currentReplicas / .conditions        │
└──────────────────────────────────────────────────────────────────────┘
```

The `Scale` subresource is a generic "expose `.spec.replicas`" interface that lives on Deployments, ReplicaSets, StatefulSets, and any CRD that opts in via the `scale` subresource. HPA never touches `.spec` directly; it uses `Scale` so it can drive any controller that supports it.

---

## Vertical Pod Autoscaler (VPA)

### Out-of-Tree, Three Components

VPA is maintained in [`kubernetes/autoscaler`](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler), not in `kubernetes/kubernetes`. You install it as three deployments plus a `VerticalPodAutoscaler` CRD (`autoscaling.k8s.io/v1`).

```
┌─────────────────────────────────────────────────────────────────────┐
│                    VerticalPodAutoscaler CR                          │
│  spec:                                                              │
│    targetRef: Deployment/my-app                                     │
│    updatePolicy: { updateMode: Auto }                               │
│    resourcePolicy:                                                  │
│      containerPolicies:                                             │
│      - containerName: '*'                                           │
│        minAllowed: { cpu: 100m, memory: 64Mi }                      │
│        maxAllowed: { cpu: 4,    memory: 4Gi }                       │
│        controlledResources: ["cpu", "memory"]                       │
│        controlledValues: RequestsAndLimits                          │
└─────────────────────────────────────────────────────────────────────┘
                          ▲                              ▲
                  watches │                              │ writes
                          │                              │ status.recommendation
            ┌─────────────┴───────┐            ┌─────────┴────────────┐
            │                     │            │                      │
   ┌────────▼─────────┐   ┌───────▼────────┐   │                      │
   │  vpa-updater     │   │ vpa-admission- │   │                      │
   │  (eviction loop) │   │ controller     │   │                      │
   │                  │   │ (mutating wh)  │   │                      │
   └────────┬─────────┘   └───────┬────────┘   │                      │
            │ Eviction API        │ Mutate     │                      │
            ▼                     ▼            │                      │
        Pod (gets evicted)    Pod CREATE   ┌───┴─────────────────────┐
                              admission    │      vpa-recommender    │
                                           │  - reads metrics.k8s.io │
                                           │  - in-memory histograms │
                                           │  - half-life decay      │
                                           │  - writes recommendation│
                                           └─────────────────────────┘
```

### Recommender

Runs on a ~1-minute loop (configurable via `--recommender-interval`). For every container of every pod matched by a VPA's `targetRef`, it maintains an **in-memory exponentially-bucketed histogram** of resource usage.

Key algorithmic facts (from the recommender source under `pkg/recommender/logic`):

- **Histogram** — separate buckets for CPU (in cores) and memory (in bytes), exponential bucket boundaries so high values don't dominate memory cost.
- **Half-life decay** — each new sample is weighted; older samples decay exponentially. CPU samples decay over a half-life of 24 hours by default; memory peaks are tracked over an aggregation window (8 days by default), since the worry there is "what did we ever need" rather than "what did we just use".
- **Target percentile** — for CPU, the **target recommendation** is roughly the **P90** of the weighted histogram (configurable); for memory, the recommender tracks the **peak** observed over each `MemoryAggregationInterval` (default 24h) for up to 8 windows (configurable), then takes the P90 across those peaks.
- **Safety margin** — the target is multiplied by a small fraction (default ~15%) on top, giving headroom for traffic that exceeds the historical P90.
- **OOM bumps** — if the kubelet records an OOMKill on a container, the recommender bumps memory aggressively (a fixed multiplier on top of last observed memory) so the next recommendation is comfortably above what just killed the pod.
- **Source of truth** — by default it reads metrics from `metrics.k8s.io` via the API aggregation layer. For longer history it can read from Prometheus directly via `--prometheus-address` (and a `metricsForPodResolution` query). It also persists per-VPA aggregated state in `VerticalPodAutoscalerCheckpoint` objects so the histograms survive recommender restarts.

The recommender writes four values into `vpa.status.recommendation`:

| Field | Meaning |
|---|---|
| `target` | What the recommender wants the pod to use. |
| `lowerBound` | Below this, the recommender is highly confident the pod is over-provisioned. |
| `upperBound` | Above this, the recommender is highly confident the pod is under-provisioned. |
| `uncappedTarget` | What the target *would* be without `minAllowed` / `maxAllowed` capping (informational). |

The updater uses `lowerBound`/`upperBound` (with a tolerance) to decide when to act; the admission controller writes `target` into the new pod.

### Updater

Reconciles every minute. For each pod managed by a VPA:

1. Look at the pod's current `requests` vs the latest `target` for that container.
2. If they differ by more than ~10% (the updater's own tolerance, separate from HPA's) and are outside `[lowerBound, upperBound]`, mark the pod for eviction.
3. **Use the Eviction API**, not direct DELETE — this respects PodDisruptionBudgets, so a noisy VPA cannot wipe out an entire Deployment.
4. Apply rate-limiting: only one pod per VPA evicted per loop, with a global cap so the updater can't disrupt the cluster.
5. The owning controller (Deployment/ReplicaSet/etc.) re-creates the pod, and the new pod CREATE goes through the admission webhook, which writes the new resources.

Why the updater **does not patch pods directly**: a Pod's `spec.containers[*].resources` is immutable on a running pod (until the In-Place Resize feature, see below). The only way to change it is to recreate the pod. Eviction is just the polite way to do that.

### Admission Controller

A `MutatingAdmissionWebhook` (`vpa-webhook-config` in the cluster) registered for `pods/CREATE`. Flow:

```
1. kube-apiserver receives POST /api/v1/namespaces/foo/pods (from a controller)
2. Validation/admission chain runs.
3. vpa-admission-controller is called with AdmissionReview{Request: pod}.
4. Webhook looks up VPAs in cache, finds the one whose targetRef owns the pod.
5. Reads vpa.status.recommendation.containerRecommendations[*].target.
6. Caps to minAllowed/maxAllowed and to LimitRange.
7. Builds a JSON Patch ([{"op":"replace","path":"/spec/containers/0/resources/requests/cpu","value":"450m"}, ...]).
8. Returns AdmissionResponse{Patch: ..., PatchType: JSONPatch}.
9. kube-apiserver applies the patch and persists the pod with new resources.
```

If the webhook is unreachable, pods are still created — the webhook is registered with `failurePolicy: Ignore` by default in the standard manifests, so VPA can never block scheduling. (You can change this, but `Fail` mode is risky — a webhook outage stops all pod creation cluster-wide.)

### Update Modes

`spec.updatePolicy.updateMode` controls how VPA acts:

| Mode | Recommender | Admission webhook | Updater |
|---|---|---|---|
| `Off` | runs | no-op | no-op |
| `Initial` | runs | rewrites pod on CREATE only | no-op |
| `Recreate` | runs | rewrites pod on CREATE | evicts pods to apply new recs |
| `Auto` | runs | rewrites pod on CREATE | evicts pods to apply new recs (today behaves like `Recreate`; reserved for future automation) |
| `InPlaceOrRecreate` (alpha, K8s 1.33+) | runs | rewrites on CREATE | first attempts in-place resize via the Pod resize subresource; falls back to eviction if the kubelet returns Infeasible |

For VPA's `InPlaceOrRecreate` to work, the cluster's `InPlacePodVerticalScaling` feature gate must be enabled (which is on by default starting with K8s v1.33 control plane / nodes; the feature itself went stable in v1.35 — see next section).

---

## In-Place Pod Resize (KEP-1287)

Before this feature, changing `spec.containers[*].resources` on a running pod was forbidden — those fields were immutable, and VPA had no choice but to evict.

[KEP-1287](https://github.com/kubernetes/enhancements/tree/master/keps/sig-node/1287-in-place-update-pod-resources) makes them mutable while the pod is running. Timeline:

| K8s version | Status |
|---|---|
| 1.27 | Alpha, feature gate `InPlacePodVerticalScaling` |
| 1.32 | Beta-ish refinements; `pod/resize` subresource added |
| 1.33 | Beta; `kubectl --subresource=resize` available; control plane and nodes both need 1.33 minimum to use it end-to-end |
| 1.35 | **Stable** — feature on by default |

> **Note:** Earlier docs and some prompts described "alpha 1.27, beta 1.32+, with `pod.status.resize: Proposed/InProgress/Deferred/Infeasible`". The status shape changed during beta. In current Kubernetes the resize state is exposed via two **conditions** on `pod.status.conditions`: `PodResizePending` (with `reason: Infeasible | Deferred`) and `PodResizeInProgress` (with optional `reason: Error`). Use `kubectl get pod -o jsonpath='{.status.conditions}'` to inspect, not a top-level `.status.resize` field.

### How it Works at the Kubelet/CRI Level

```
1. Client patches pod via the resize subresource:
     kubectl patch pod my-app --subresource=resize \
       --patch '{"spec":{"containers":[{"name":"app","resources":{"requests":{"cpu":"500m"}}}]}}'

2. kube-apiserver validates and writes the new spec.

3. Kubelet on the node sees the spec change (via its informer).

4. Kubelet calls runtime via CRI:
       UpdateContainerResources(containerID, LinuxContainerResources{...})

5. The container runtime (containerd/CRI-O) writes to the container's cgroup:

   cgroup v1:
     cpu.shares                 (cpu request -> shares = request_in_millicores * 1024 / 1000)
     cpu.cfs_period_us          (always 100000 µs by default)
     cpu.cfs_quota_us           (cpu limit -> quota = limit * cfs_period_us / 1000)
     memory.limit_in_bytes      (memory limit)

   cgroup v2 (modern default):
     cpu.weight                 (proportional, same idea as cpu.shares)
     cpu.max                    ("<quota> <period>", e.g. "200000 100000" = 2 cores)
     memory.max                 (memory limit)
     memory.high                (soft throttle, optional)

6. Kubelet writes back status, surfacing PodResizeInProgress / PodResizePending conditions.
```

The container is **not restarted** for CPU — the kernel scheduler observes new shares/weight on the next scheduling decision. That's why CPU resize defaults to `resizePolicy.restartPolicy: NotRequired`.

### resizePolicy: Why Memory is Different

```yaml
spec:
  containers:
  - name: app
    resources:
      requests: { cpu: 200m, memory: 256Mi }
      limits:   { cpu: 500m, memory: 512Mi }
    resizePolicy:
    - resourceName: cpu
      restartPolicy: NotRequired      # default for cpu
    - resourceName: memory
      restartPolicy: RestartContainer # default for memory in many setups
```

Why memory typically uses `RestartContainer`:

- **Lowering `memory.limit_in_bytes` (cgroup v1) / `memory.max` (v2) below current RSS triggers an OOMKill** at the cgroup level. The kernel doesn't "shrink" a process's allocated memory — it can only kill processes inside the cgroup until usage drops below the limit. So a naive shrink is unsafe.
- Many language runtimes (JVM `-Xmx`, Go's `GOMEMLIMIT`, Node) read the cgroup limit at startup. If you raise the limit in place, they don't notice — only a restart picks it up.
- CPU has neither problem: lowering `cpu.shares`/`cpu.weight` just gives the container fewer CPU slices on contention; lowering `cpu.max` clamps quota for the next period. No process dies.

If you set `restartPolicy: Never` on the pod, every `resizePolicy` entry must be `NotRequired` — otherwise the API server rejects the spec.

### Status Conditions

The Kubelet records resize progress on `pod.status.conditions`:

| Condition | Reason | Meaning |
|---|---|---|
| `PodResizePending` | `Infeasible` | Node lacks the resources requested; resize will not happen unless the node changes. |
| `PodResizePending` | `Deferred` | Currently impossible (e.g. another pod is being resized); kubelet will retry. Higher-priority/Guaranteed-class pending resizes are retried first. |
| `PodResizeInProgress` | (none) | Kubelet accepted the new resources and is applying them. |
| `PodResizeInProgress` | `Error` | The runtime returned an error (e.g. cgroup write failed); see the message for details. |

Memory shrink that would push usage above the new limit is **best-effort** — if the kubelet sees current usage already above the desired new limit, it leaves `PodResizeInProgress` standing rather than triggering a guaranteed OOMKill.

---

## metrics-server and the Resource Metrics Pipeline

### What metrics-server Is

[`kubernetes-sigs/metrics-server`](https://github.com/kubernetes-sigs/metrics-server) is a tiny Go program that:

- Lists nodes via the Kubernetes API.
- Scrapes each kubelet's `/metrics/resource` endpoint at a fixed interval (`--metric-resolution`, default `15s`; minimum recommended `10s`).
- Stores the **most recent two samples** per pod/container in memory only — no disk, no DB, no history.
- Serves the `metrics.k8s.io/v1beta1` API (still beta as of K8s 1.36): `nodes`, `pods` resources with `usage` fields.
- Registers itself with the kube-apiserver's aggregation layer via an `APIService` so kube-apiserver routes incoming `metrics.k8s.io` requests to it.

> **Note:** The `metrics.k8s.io` group is still `v1beta1` despite metrics-server being mature — there is no `metrics.k8s.io/v1`. Don't let that throw you off; the API is stable in practice.

```
                            +-----------------------+
                            |    kubectl top pod    |
                            |    HPA controller     |
                            |    VPA recommender    |
                            +-----------+-----------+
                                        | GET /apis/metrics.k8s.io/v1beta1/...
                                        v
                       +-------------------------------------+
                       |          kube-apiserver             |
                       |   (aggregation layer)               |
                       |   - Resolves APIService for         |
                       |     metrics.k8s.io/v1beta1          |
                       |   - Verifies client cert            |
                       |   - Proxies request to backing svc  |
                       +-----------------+-------------------+
                                         | proxied
                                         v
                              +----------------------+
                              |   metrics-server     |
                              |  (in-memory cache)   |
                              +----+-----------------+
                                   ^
                                   | scrape /metrics/resource
                                   | every 15s (default)
                                   |
                              +----+-------------+
                              |     Kubelet      |
                              |   + cAdvisor     |     reads container cgroups,
                              |   (per node)     |     summarizes per-container
                              +------------------+     CPU & memory
```

### How the Aggregation Layer Routes Requests

The aggregation layer is what makes "extension API servers" feel native. It's enabled by default and works like this:

1. Cluster admin (or the metrics-server install manifests) creates an `APIService` object:
   ```yaml
   apiVersion: apiregistration.k8s.io/v1
   kind: APIService
   metadata:
     name: v1beta1.metrics.k8s.io
   spec:
     group: metrics.k8s.io
     version: v1beta1
     groupPriorityMinimum: 100
     versionPriority: 100
     service:
       name: metrics-server
       namespace: kube-system
     insecureSkipTLSVerify: true   # or, in prod, ship a real CA bundle
   ```
2. kube-apiserver sees an incoming request for `/apis/metrics.k8s.io/v1beta1/...`.
3. It looks up the `APIService` for that group/version. The native handler doesn't serve this group, so the apiserver acts as a **proxy** — it forwards the request over HTTPS to `metrics-server.kube-system.svc:443`.
4. The apiserver authenticates *to* metrics-server using a TLS client cert (the `--proxy-client-cert-file`/`--proxy-client-key-file` flags). metrics-server validates that cert against the `--requestheader-client-ca-file` CA, and trusts the user identity that the apiserver passes in headers (`X-Remote-User`, `X-Remote-Group`, etc.).
5. metrics-server replies; the apiserver returns the response to the original client.

This is exactly the mechanism described in [[notes/K8s/extension_api_server_storage|Extension API Server Storage]] — `metrics.k8s.io` is itself an extension API server, just one that ships with the platform.

### The Three Metrics APIs — and Who Implements Each

There is no single "metrics API" — there are three, all served via aggregation, all consumed by HPA:

| API group | Implemented by | Use case | HPA metric type |
|---|---|---|---|
| `metrics.k8s.io` | metrics-server (canonical) | CPU/memory of pods & nodes | `Resource` |
| `custom.metrics.k8s.io` | Prometheus Adapter, Datadog, KEDA, vendor adapters | Application metrics tied to a K8s object (RPS per pod, queue length on a Service) | `Pods`, `Object` |
| `external.metrics.k8s.io` | KEDA, cloud adapters (CloudWatch, Pub/Sub, etc.) | Metrics not tied to any K8s object (SQS queue depth, BigQuery rows, datadog query) | `External` |

Two pipelines exist conceptually:

- **Resource Metrics Pipeline** — lightweight, mandatory for `kubectl top`, HPA on resources, VPA. Just metrics-server. Memory and CPU only. ~15s window.
- **Full Metrics Pipeline** — anything you'd actually want for observability. Prometheus + a metrics adapter (or KEDA) exposing the custom/external groups. Long retention, alerting, dashboards.

### Why VPA Still Maintains Its Own Histograms

metrics-server holds only the last ~2 samples per container — enough for `kubectl top` and HPA's instantaneous calculations, but useless for "what did this container use over the past 24 hours?". VPA's recommender therefore reads metrics-server every minute and **builds its own decaying histogram in memory**, persisted to `VerticalPodAutoscalerCheckpoint` for resilience. This is also why pointing the recommender at Prometheus (`--prometheus-address`) is desirable in production: it can hydrate from real history at startup instead of warming up for hours.

---

## The Metrics Extension Model: How HPA Type Maps to API

The HPA controller does not invent metrics — it asks the kube-apiserver, which routes the request via the aggregation layer to whatever extension apiserver has registered itself for that group. There are exactly three groups in the extension model, and each HPA `metrics[].type` is hard-wired to one of them.

### The Dispatch Table

| HPA `metrics[].type` | API group queried | Implementer | Common backend |
|---|---|---|---|
| `Resource` | `metrics.k8s.io/v1beta1` | metrics-server | kubelet `/metrics/resource` |
| `ContainerResource` | `metrics.k8s.io/v1beta1` | metrics-server | kubelet `/metrics/resource` (per container) |
| `Pods` | `custom.metrics.k8s.io/v1beta2` | Prometheus Adapter / KEDA / Datadog / vendor | Prometheus, vendor TSDB |
| `Object` | `custom.metrics.k8s.io/v1beta2` | Prometheus Adapter / KEDA / Datadog / vendor | Prometheus, vendor TSDB |
| `External` | `external.metrics.k8s.io/v1beta1` | KEDA / cloud adapters / Datadog | SQS, Kafka, Pub/Sub, Cloudflare, vendor SaaS |

> **Note:** `ContainerResource` was promoted to GA in Kubernetes v1.27 and exposes per-container resource metrics so that HPA can target a specific sidecar's CPU/memory rather than the pod's whole-pod aggregate. It still uses `metrics.k8s.io`. Reference: [HPA Container Resource Metrics](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/#container-resource-metrics).

This mapping is **hard-coded** inside the HPA controller in `kube-controller-manager`. You cannot change it via flags or configuration — you'd have to recompile the binary to alter where each `type` looks. Internally, the HPA controller uses one wrapper interface (`MetricsClient`) with three methods that dispatch the choice:

```go
// k8s.io/kubernetes/pkg/controller/podautoscaler/metrics
type MetricsClient interface {
    GetResourceMetric(ctx, resource, namespace, selector, container) (PodMetricsInfo, ...)  // -> metrics.k8s.io
    GetRawMetric(ctx, metricName, namespace, selector, metricSelector) (PodMetricsInfo, ...) // -> custom.metrics.k8s.io
    GetExternalMetric(ctx, metricName, namespace, selector) ([]int64, ...)                   // -> external.metrics.k8s.io
}
```

The HPA reconciler picks which method to call based on the `metrics[].type` value of the HPA spec it is reconciling.

### Worked URLs the Controller Actually Issues

For a Deployment in namespace `prod` named `web` with 4 ready pods, here is the literal HTTP path issued for each HPA type:

```
type: Resource (cpu)
  GET /apis/metrics.k8s.io/v1beta1/namespaces/prod/pods?labelSelector=app%3Dweb
  → metrics-server returns PodMetricsList with containers[].usage{cpu, memory}

type: ContainerResource (container=app, cpu)
  GET /apis/metrics.k8s.io/v1beta1/namespaces/prod/pods?labelSelector=app%3Dweb
  → same payload; controller filters to containers[name=="app"]

type: Pods (metric=requests_per_second)
  GET /apis/custom.metrics.k8s.io/v1beta2/namespaces/prod/pods/*/requests_per_second?labelSelector=app%3Dweb
  → adapter returns one MetricValue per pod

type: Object (kind=Service, name=web, metric=hits_per_second)
  GET /apis/custom.metrics.k8s.io/v1beta2/namespaces/prod/services/web/hits_per_second
  → adapter returns one MetricValue tied to the Service object

type: External (metric=sqs_queue_depth, selector queue=orders)
  GET /apis/external.metrics.k8s.io/v1beta1/namespaces/prod/sqs_queue_depth?labelSelector=queue%3Dorders
  → adapter returns one or more ExternalMetricValue items
```

The `*` in the `Pods` URL is critical: it means "every pod selected by `labelSelector`". Adapters interpret `*` as a fan-out match.

---

## custom.metrics.k8s.io in Depth

### Concept

`custom.metrics.k8s.io` is for metrics that are **tied to a Kubernetes object**: a Pod, a Service, an Ingress, or even a CRD instance. The metric value belongs to that object: "this pod is doing X requests/second", "this Ingress is averaging Y latency".

Two HPA types map to this group:

- **`Pods`** — fan out to all matching pods, one value each. HPA averages them.
- **`Object`** — single value tied to a single non-pod object. HPA either compares directly or divides by replica count (for `AverageValue` target type).

### URL Shapes (Group `v1beta2`)

```
# All pods in namespace, fan-out
/apis/custom.metrics.k8s.io/v1beta2/namespaces/<ns>/pods/*/<metric>[?labelSelector=...]

# Specific pod
/apis/custom.metrics.k8s.io/v1beta2/namespaces/<ns>/pods/<pod-name>/<metric>

# A single object (Service, Ingress, CRD)
/apis/custom.metrics.k8s.io/v1beta2/namespaces/<ns>/<resource>/<name>/<metric>

# Cluster-scoped resource (e.g. Node)
/apis/custom.metrics.k8s.io/v1beta2/<resource>/<name>/<metric>
```

> **Note:** The custom metrics API has both `v1beta1` and `v1beta2`. `v1beta2` is the current version returned by recent adapters and used by HPA in modern clusters; `v1beta1` is still served by older adapters. Always discover which version the cluster has via `kubectl get apiservices` rather than hard-coding.

### Discovery Calls

```bash
# List the metrics the adapter exposes
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta2 | jq '.resources[].name'

# Read a specific pod metric
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta2/namespaces/prod/pods/*/requests_per_second" \
  | jq

# Read an Object-type metric (Service)
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta2/namespaces/prod/services/web/hits_per_second" \
  | jq
```

### Implementations

| Adapter | Backend | Notes |
|---|---|---|
| [`prometheus-adapter`](https://github.com/kubernetes-sigs/prometheus-adapter) | Prometheus | Reference open-source impl; rule-based config; most common |
| [KEDA](https://keda.sh/) | 70+ scalers (Prom, Kafka, SQS, Redis, ...) | Primarily targets `external.metrics.k8s.io` but can serve custom too |
| Datadog Cluster Agent | Datadog backend | One adapter, can serve `external` and `custom` |
| GCP Stackdriver Adapter | Cloud Monitoring | GKE-specific |
| Azure k8s-metrics-adapter | Azure Monitor | AKS-specific |

**Constraint:** there can only be **one** APIService per group/version. So you cannot have both Prometheus Adapter and Datadog Cluster Agent serving `custom.metrics.k8s.io/v1beta2` at the same time — whichever was applied later wins, and the other's `APIService` is rejected/replaced. Modern Datadog Cluster Agent has a "translator" mode that delegates to Prometheus Adapter, but the underlying single-adapter constraint is intrinsic to the aggregation layer.

### Prometheus Adapter Rules: How URL Paths Become PromQL

The Prometheus Adapter does not store metrics — it translates incoming custom-metrics-API requests into PromQL queries against Prometheus on the fly. The translation is configured by **rules** in the adapter's ConfigMap. Each rule has four sections:

```yaml
rules:
- seriesQuery: 'http_requests_total{kubernetes_namespace!="",kubernetes_pod_name!=""}'
  # 1. discovery: which Prometheus series this rule covers

  resources:
    overrides:
      kubernetes_namespace: {resource: "namespace"}
      kubernetes_pod_name:  {resource: "pod"}
  # 2. association: map Prom labels -> Kubernetes resources

  name:
    matches: "^(.*)_total$"
    as:      "${1}_per_second"
  # 3. naming: rename the Prometheus series for the API
  #    "http_requests_total" -> "http_requests_per_second"

  metricsQuery: |
    sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)
  # 4. querying: Go template that produces the PromQL
```

When HPA queries:

```
GET /apis/custom.metrics.k8s.io/v1beta2/namespaces/prod/pods/*/http_requests_per_second
   ?labelSelector=app%3Dweb
```

the adapter:

1. Looks up the rule whose `name.as` matched `http_requests_per_second` → original series is `http_requests_total`.
2. Resolves `<<.LabelMatchers>>` to `kubernetes_namespace="prod",kubernetes_pod_name=~"web-.*"` (from the resource overrides + label selector).
3. Resolves `<<.GroupBy>>` to `kubernetes_namespace,kubernetes_pod_name`.
4. Issues PromQL: `sum(rate(http_requests_total{...}[2m])) by (kubernetes_namespace, kubernetes_pod_name)`.
5. For each returned series, emits a `MetricValue` keyed to the corresponding pod.

This is why the Prometheus Adapter's data freshness is bounded by Prometheus's scrape interval — typical `[2m]` rate windows mean the adapter cannot react faster than Prometheus's scrape cycle.

### Concrete HPA Using a Custom Metric

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: {name: web-hpa, namespace: prod}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
  minReplicas: 2
  maxReplicas: 50
  metrics:
  - type: Pods
    pods:
      metric: {name: http_requests_per_second}
      target: {type: AverageValue, averageValue: "1k"}
  - type: Object
    object:
      describedObject: {apiVersion: v1, kind: Service, name: web}
      metric: {name: hits_per_second}
      target: {type: Value, value: "10k"}
```

The HPA controller queries:
- `Pods` → `/apis/custom.metrics.k8s.io/v1beta2/namespaces/prod/pods/*/http_requests_per_second`
- `Object` → `/apis/custom.metrics.k8s.io/v1beta2/namespaces/prod/services/web/hits_per_second`

---

## external.metrics.k8s.io in Depth

### Concept

`external.metrics.k8s.io` is for metrics that have **no Kubernetes object to point at**: an SQS queue depth, a Kafka consumer lag, a Cloudflare RPS counter, the size of an S3 prefix, the number of open Datadog incidents. The metric exists outside the cluster.

The HPA `External` metric type is the only one mapped to this group.

### URL Shape

```
/apis/external.metrics.k8s.io/v1beta1/namespaces/<ns>/<metric-name>?labelSelector=...
```

Note the absence of any `<resource>/<name>` segment — there is nothing in the cluster the metric is anchored to. The `labelSelector` is the *only* mechanism for the adapter to know which external thing the caller is asking about.

### Concrete HPA Using External

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: {name: worker-hpa, namespace: prod}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: worker
  minReplicas: 1
  maxReplicas: 100
  metrics:
  - type: External
    external:
      metric:
        name: aws_sqs_approximate_number_of_messages_visible
        selector:
          matchLabels:
            queue_name: orders-prod
            region:     us-east-1
      target:
        type: AverageValue
        averageValue: "30"   # ~30 messages per replica
```

The controller issues:

```
GET /apis/external.metrics.k8s.io/v1beta1/namespaces/prod/aws_sqs_approximate_number_of_messages_visible
    ?labelSelector=queue_name%3Dorders-prod%2Cregion%3Dus-east-1
```

### Implementations

| Adapter | Coverage |
|---|---|
| [KEDA](https://keda.sh/) | The de facto standard. 70+ scalers across cloud queues, Kafka, RabbitMQ, Prometheus, Datadog, NATS, Redis, GCP Pub/Sub, Azure Service Bus, etc. |
| AWS CloudWatch Adapter | AWS metrics |
| GCP Stackdriver Adapter | Cloud Monitoring metrics |
| Datadog Cluster Agent | Datadog queries (`DatadogMetric` CRD) |

### The Single-Adapter Rule and the Label-Selector Dispatch Trick

Because exactly one adapter can register the `APIService` for `external.metrics.k8s.io/v1beta1`, you cannot run "KEDA for Kafka and the AWS adapter for SQS" side by side in the simple sense. KEDA's solution: it serves the entire group itself, then internally dispatches to the right scaler based on the **labelSelector** in the request. That's what `selector.matchLabels: { queue_name: ..., region: ... }` is doing in the HPA above — it's not just metadata, it's KEDA's routing key.

KEDA's `ScaledObject` controller generates the HPA with the right labels so the dispatch always works without humans having to type them.

---

## APIService and Inspecting the Metrics Pipeline

### What an APIService Looks Like

```yaml
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1beta1.metrics.k8s.io          # MUST be "<version>.<group>"
spec:
  group: metrics.k8s.io
  version: v1beta1
  groupPriorityMinimum: 100             # ordering across groups; higher wins
  versionPriority:      100             # ordering within a group
  service:
    name:      metrics-server
    namespace: kube-system
    port:      443                      # default 443
  caBundle: LS0tLS1CRUdJTi...           # PEM CA bundle base64-encoded
  # OR
  # insecureSkipTLSVerify: true         # dev-only; turns off cert check
status:
  conditions:
  - type: Available
    status: "True"
    reason: Passed
    message: all checks passed
```

Key fields:

- `metadata.name` **must** equal `<version>.<group>`. The apiserver derives the routed path from this name; rename it and discovery breaks.
- `groupPriorityMinimum` orders this group relative to other groups in the discovery doc. The native Kubernetes groups use values from 17000-20000; extension APIs like `metrics.k8s.io` typically use 100. Higher numeric value = listed first.
- `versionPriority` orders versions within the same group (e.g. `v1` vs `v1beta1`); higher wins as the "preferred" version.
- `service.{name, namespace}` is the backing Service. Set both fields; if `service` is omitted, the apiserver assumes the API is served locally (built-in handlers; not relevant for normal extensions).
- `caBundle` is the trust anchor used by kube-apiserver to verify the backing service's serving cert. Production: ship a real CA bundle (typically auto-injected by a controller like cert-manager or the cluster's CA injector). Dev: use `insecureSkipTLSVerify: true`.

### Inspection Commands

```bash
# Which APIServices exist? Are they all healthy?
kubectl get apiservices
kubectl get apiservices | grep -E 'metrics|custom|external'

# Find which APIServices are aggregated (have a backing Service)
# Local=true ⇒ served by kube-apiserver itself (built-in or CRD)
# Local=false ⇒ proxied to a Service (true aggregated apiserver)
kubectl get apiservices -o custom-columns=NAME:.metadata.name,SERVICE:.spec.service.name,AVAILABLE:.status.conditions[0].status

# Discovery: what resources does the metrics group expose?
kubectl get --raw /apis/metrics.k8s.io/v1beta1            | jq
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta2     | jq '.resources | length'
kubectl get --raw /apis/external.metrics.k8s.io/v1beta1   | jq '.resources | length'

# Hit a specific metric
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/namespaces/kube-system/pods" | jq
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta2/namespaces/prod/pods/*/http_requests_per_second" | jq
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/prod/sqs_queue_depth?labelSelector=queue%3Dorders" | jq

# What is HPA actually seeing? Status conditions explain failures.
kubectl describe hpa web-hpa
```

### When Wiring Breaks: HPA Conditions

`kubectl describe hpa` translates aggregation-layer failures into human-readable reasons:

| HPA condition reason | Means |
|---|---|
| `FailedGetResourceMetric` | `metrics.k8s.io` unreachable or returned no data for the pod (missing `requests`, no metrics-server APIService, metrics-server pod down) |
| `FailedGetPodsMetric` | `custom.metrics.k8s.io` unreachable or adapter returned 404 for the requested metric (rule mismatch, no series in Prometheus) |
| `FailedGetObjectMetric` | Same as above but for `Object` type |
| `FailedGetExternalMetric` | `external.metrics.k8s.io` unreachable or selector matched no scaler in KEDA |
| `InvalidMetricSourceType` | HPA spec references a `type` that the controller cannot resolve |
| `ScalingActive=False` reason `FailedGetResourceMetric` | At least one metric is broken and HPA is refusing to scale on it |

**Single-point-of-failure caution:** the aggregation layer registers the APIService as a *catch-all* for that group/version. If the backing Service goes down, **every** GET on that group fails. So a broken `metrics-server` doesn't just stop HPA — it also breaks `kubectl top`, the dashboard's CPU/memory charts, the VPA recommender's data source, and any controller subscribed to the group. Always run metrics-server as a Deployment with at least 2 replicas behind the Service.

---

## KEDA's ScaledObject: the Highest-Level Abstraction

KEDA's `ScaledObject` CRD sits **above** HPA and effectively delegates the type→API routing decision to KEDA. You declare event sources; KEDA generates an HPA whose `metrics[].type: External` entries are pre-wired with the right metric name and label selectors so the underlying KEDA adapter routes correctly.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-scaler
  namespace: prod
spec:
  scaleTargetRef:
    name: worker          # Deployment name
  pollingInterval: 30     # seconds
  cooldownPeriod:  300
  minReplicaCount: 0      # KEDA can scale to zero
  maxReplicaCount: 100
  triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123/orders
      queueLength: "30"
      awsRegion:  us-east-1
    authenticationRef:
      name: keda-aws-credentials
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.observability:9090
      metricName:    http_requests_per_second
      query:         sum(rate(http_requests_total{deployment="worker"}[2m]))
      threshold:     "1000"
```

Internally:

```
                      ┌─────────────────────────────────┐
                      │         ScaledObject CR         │
                      └──────────────┬──────────────────┘
                                     │ KEDA operator reconciles
                                     ▼
                      ┌─────────────────────────────────┐
                      │     auto-generated HPA          │
                      │  metrics:                       │
                      │  - type: External               │
                      │    external:                    │
                      │      metric: {name: s0-aws-sqs} │
                      │      target: 30                 │
                      │  - type: External               │
                      │    external:                    │
                      │      metric: {name: s1-prom}    │
                      │      target: 1000               │
                      └──────────────┬──────────────────┘
                                     │ HPA queries
                                     ▼
                      external.metrics.k8s.io served by KEDA
                                     │
                       label-selector-based dispatch
                ┌────────────────────┴───────────────────┐
                ▼                                        ▼
          KEDA SQS scaler                        KEDA Prom scaler
          (calls AWS SDK)                        (HTTP to Prometheus)
```

KEDA also does what HPA cannot: **scale to zero**. When all triggers report idle, KEDA suspends the underlying Deployment (`replicas: 0`) and removes the HPA from active duty. On the next event, KEDA scales the Deployment to the activation level, recreates the HPA, and lets HPA take over normal scaling. This is the closest thing in the ecosystem to "modifying the type→API routing" — you don't change the routing, you put a smarter abstraction on top.

For more on routing internals, see [[notes/K8s/kube-apiserver-request-routing|kube-apiserver Request Routing]].

---

## HPA + VPA: When They Conflict

### The Same-Resource Oscillation

If you put **both** HPA and VPA on the same resource (e.g. CPU), they enter a feedback loop:

```
 Step 1: traffic spike → average CPU goes up
 Step 2: HPA reacts:  ratio > 1+tol → adds 2 replicas
                       average CPU now drops (load is spread)
 Step 3: VPA recommender notices lower per-pod CPU usage
         → recommends LOWER cpu requests
         → updater evicts pods, admission webhook bakes lower requests
 Step 4: pods come back with lower requests; with the same usage
         the *utilization* (= usage / request) shoots up
 Step 5: HPA sees ratio > 1+tol again → adds MORE replicas
 Step 6: VPA sees per-pod usage even lower → recommends LOWER again
         → pods evicted, replaced with even smaller requests
   ... unbounded oscillation, replicas climbing, requests shrinking ...
```

The root cause: HPA's `Resource` utilization is `usage / request × 100`. If VPA shrinks the denominator while HPA scales horizontally on the ratio, both autoscalers reinforce each other in opposite directions.

### Approved Patterns

The official guidance (Kubernetes docs, KEP-302, SIG-Autoscaling) is: **do not run HPA and VPA on the same resource** in `Auto`/`Recreate`. Acceptable patterns:

1. **HPA on app metrics, VPA on resources (cleanest).** HPA scales replicas based on RPS, queue depth, latency, etc. VPA right-sizes CPU/memory. They don't share a knob.
2. **VPA `Off` mode.** VPA recommends but never acts. Operators read `vpa.status.recommendation` and apply it manually (or via GitOps). HPA can run on anything safely.
3. **Resource split.** VPA controls memory only (`controlledResources: ["memory"]`), HPA on CPU; or vice versa. Each autoscaler owns one axis.
4. **VPA `InPlaceOrRecreate` + careful tuning.** With in-place resize, VPA can change requests without eviction, but the oscillation problem is unchanged. Still risky on the same resource.

### Always Set Bounds

Both autoscalers should always have hard bounds:

```yaml
# HPA
spec:
  minReplicas: 2
  maxReplicas: 50

# VPA
spec:
  resourcePolicy:
    containerPolicies:
    - containerName: '*'
      minAllowed: { cpu: 100m, memory: 128Mi }
      maxAllowed: { cpu: 4,    memory: 8Gi }
```

Without these, a metric outage or a VPA bug can produce truly absurd recommendations (millicores for a JVM, dozens of replicas for a singleton job). KEP-related work on a **MultiDimensional Pod Autoscaler (MPA)** in SIG-Autoscaling aims to coordinate the two correctly, but it is not yet a stable in-cluster feature as of K8s 1.36.

---

## See also

- [[notes/K8s/kubernetes|Kubernetes Concepts]] — DaemonSets, taints, node pools, pod scheduling primitives.
- [[notes/K8s/kube-apiserver-request-routing|kube-apiserver Request Routing]] — built-in vs CRD vs aggregated APIs and how `metrics.k8s.io` is dispatched.
- [[notes/K8s/extension_api_server_storage|Extension API Server / Aggregation Layer Storage]] — storage choices once you go the aggregated route.
- [[notes/K8s/daemonset-pod-race-conditions|DaemonSet Pod Race Conditions]] — operational pattern relevant when running metrics-server-like components.
- Official: [HPA Walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- Official: [Autoscaling concepts](https://kubernetes.io/docs/concepts/workloads/autoscaling/)
- Official: [Resize CPU and memory resources](https://kubernetes.io/docs/tasks/configure-pod-container/resize-container-resources/)
- Repo: [`kubernetes/autoscaler` — VPA](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
- Repo: [`kubernetes-sigs/metrics-server`](https://github.com/kubernetes-sigs/metrics-server)
- KEP: [1287 — In-place update of Pod resources](https://github.com/kubernetes/enhancements/tree/master/keps/sig-node/1287-in-place-update-pod-resources)
- KEP: [HPA per-target tolerance (1.33)](https://github.com/kubernetes/enhancements/tree/master/keps/sig-autoscaling/4951-configurable-tolerance)
- Official: [API Aggregation Layer](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/apiserver-aggregation/)
- Repo: [`kubernetes-sigs/prometheus-adapter`](https://github.com/kubernetes-sigs/prometheus-adapter) — config reference for custom-metrics rules
- Repo: [`kubernetes-sigs/custom-metrics-apiserver`](https://github.com/kubernetes-sigs/custom-metrics-apiserver) — library for building adapters
- Repo: [`kedacore/keda`](https://github.com/kedacore/keda) — `ScaledObject`, 70+ scalers, scale-to-zero
- Docs: [keda.sh — Concepts](https://keda.sh/docs/concepts/)

---

## Interview Prep

### Q: Walk me through what happens from a CPU spike on a pod to HPA scaling up.

**A:**
```
T=0      Workload starts taking heavier traffic.
         Inside each pod, app code runs more, kernel scheduler hands
         the container's cgroup more CPU slices until quota is hit.

T+~1s    cAdvisor (built into kubelet) reads cgroup cpuacct/cpu.stat,
         exposes /metrics/resource.

T+0–15s  metrics-server's next scrape runs (default 15s). It pulls
         CPU usage for every pod from every kubelet, replaces the
         per-pod entry in its in-memory cache. No persistence.

T+~15s   HPA controller's next sync tick (15s default). It:
            1. Lists targets via informer.
            2. GETs metrics.k8s.io/v1beta1/pods/.../usage via apiserver.
               apiserver, via aggregation layer, proxies to metrics-server.
            3. Filters to ready pods, drops pods younger than 5min that
               aren't ready.
            4. average_usage = sum(usage) / count(ready_pods)
            5. utilization = average_usage / per-pod-cpu-request × 100
            6. ratio = utilization / target. If outside ±10% tolerance:
                 desired = ceil(currentReplicas * ratio)
            7. Multi-metric: max across all metrics.
            8. Apply behavior: scaleUp policies cap rate of change;
               stabilization=0s by default so it acts immediately.
            9. PATCH Scale subresource of the Deployment.

T+~16s   Deployment controller sees new .spec.replicas, creates new
         ReplicaSet revision (or updates existing) and creates pods.

T+~17s   kube-scheduler binds pods to nodes; kubelets pull images
         and start containers.

T+30–60s New pods become Ready. They start sharing load. Average
         per-pod CPU drops. Next HPA tick may scale further or not.
```

### Q: Why does HPA compute utilization against `requests`, not `limits`?

**A:** Because `requests` is what the scheduler used to place the pod. Utilization tells the HPA "how full is the box you reserved for me?". Targeting against limits would conflate two unrelated decisions: the scheduler reservation (`request`) and the QoS ceiling (`limit`). They are often very different — a 200m/2000m container would look 90% used at 1800m if you use the limit, but it's actually using 9× its reservation, which means it's *under-requested* for its actual load and the cluster's bin-packing assumptions are wrong. Targeting requests aligns autoscaling with scheduling.

### Q: What happens if I forget to set a CPU request and create an HPA on CPU utilization?

**A:** The HPA's `.status.conditions` will report:
```
- type: ScalingActive
  status: "False"
  reason: FailedGetResourceMetric
  message: 'failed to get cpu utilization: missing request for cpu'
```
The HPA cannot derive a percentage without a denominator. It refuses to scale on that metric (other metrics in the same HPA still work). Workaround: either set a CPU request on every container of every pod the HPA targets, or switch the metric `target.type` to `AverageValue` and target a raw cpu value (e.g. `200m`).

### Q: How does HPA prevent flapping?

**A:** Three mechanisms stack:

```
┌────────────────────────────────────────────────────────────────┐
│ 1. Tolerance band (±10% by default)                            │
│      |ratio - 1| <= tolerance → no scaling                     │
│                                                                │
│ 2. Stabilization windows                                       │
│      scaleDown (default 300s): take MAX of recommendations     │
│        in window. A brief drop in metrics doesn't shrink.      │
│      scaleUp (default 0s): act immediately, but rate-limited   │
│        by policies.                                            │
│                                                                │
│ 3. Behavior policies (rate limits)                             │
│      Percent 100% per 15s, Pods 4 per 15s, etc.                │
│      selectPolicy: Min/Max combines them.                      │
│                                                                │
│ 4. Special-case handling                                       │
│      Missing-metric pods are 100% on scale-down (so they       │
│      can't trick the controller into a downscale spiral)       │
│      and 0% on scale-up.                                       │
└────────────────────────────────────────────────────────────────┘
```

### Q: Why does HPA need metrics-server but not Prometheus?

**A:** The HPA controller is wired against the Kubernetes API only — specifically the `metrics.k8s.io`, `custom.metrics.k8s.io`, and `external.metrics.k8s.io` API groups. metrics-server is the canonical implementation of `metrics.k8s.io` for CPU/memory. Prometheus does not natively serve any of those API groups — you need an adapter (Prometheus Adapter, KEDA) that translates Prometheus queries into `custom.metrics.k8s.io` results and registers itself via APIService aggregation. The HPA never knows whether the data on the other end is metrics-server or Prometheus; it just knows about the K8s API.

### Q: Walk me through how `metrics.k8s.io` actually reaches metrics-server.

**A:**
```
$ kubectl top pod -n kube-system

  ↓ kubectl issues:
  GET /apis/metrics.k8s.io/v1beta1/namespaces/kube-system/pods

  ↓ kube-apiserver receives the request.
  ↓ Native handler doesn't serve metrics.k8s.io.
  ↓ Aggregation layer: looks up APIService(v1beta1.metrics.k8s.io)
    points to Service(kube-system/metrics-server:443).

  ↓ kube-apiserver opens an HTTPS connection to metrics-server,
    presenting client cert (--proxy-client-cert-file).
  ↓ It forwards the original URL/verb/body, with extra headers:
       X-Remote-User: <original requester>
       X-Remote-Group: <original groups>
       X-Remote-Extra-...: <arbitrary>

  ↓ metrics-server validates the client cert against the
    requestheader-client-ca it trusts.
  ↓ metrics-server checks RBAC of the original user against its
    own SubjectAccessReview (proxied back through the apiserver).

  ↓ metrics-server reads its in-memory cache and returns JSON.

  ↓ kube-apiserver pipes the response back to kubectl unchanged
    (status, body, headers).
```

### Q: Why are VPA's three components separated?

**A:** Single-responsibility plus blast-radius isolation:

| Component | Job | Why separate |
|---|---|---|
| Recommender | Build histograms, write recommendations. CPU-heavy, stateful. | Crashing/restarting it doesn't disrupt running pods — recommendations just go stale. |
| Updater | Decide when to evict. Holds the eviction rate-limit budget. | Bug here at worst over-evicts; without it the cluster still functions normally. |
| Admission Controller | Webhook on every pod CREATE. Latency-critical, must be highly available. | Crashes or slowness here delays pod creation cluster-wide. Kept tiny and stateless so it can be scaled and made HA without touching the heavy recommender. |

If they were one binary, a recommender memory leak would kill the admission webhook and stop scheduling. Decomposing them is a deliberate operability choice.

### Q: Why doesn't the VPA updater patch pods directly?

**A:** Until KEP-1287, `pod.spec.containers[*].resources` was strictly **immutable** on a running pod. The only way to apply new resources was to delete and recreate the pod. The updater issues an **Eviction** (not a delete) so PDBs are honoured: the API server denies the eviction with `429 Too Many Requests` if it would breach a PDB, and the updater backs off. Now that in-place resize is stable, VPA's `InPlaceOrRecreate` mode tries the resize subresource first and only falls back to eviction if the kubelet reports `Infeasible`.

### Q: Walk me through how an evicted pod ends up with new resources.

**A:**
```
1. vpa-recommender writes recommendation.target = { cpu: 600m, memory: 768Mi }
   into VPA.status.

2. vpa-updater scan: pod's current request (300m, 512Mi) is below
   recommendation.lowerBound (450m, 600Mi). Mark for eviction.

3. vpa-updater POSTs to /api/v1/namespaces/.../pods/<name>/eviction
   (Eviction subresource).
   - apiserver evaluates PDBs.
   - If allowed: proceed; kubelet later calls graceful shutdown.
   - If not allowed: 429, updater retries next loop.

4. Owner controller (Deployment → ReplicaSet) notices missing replica,
   creates a new pod with the original spec (still 300m/512Mi).

5. apiserver runs admission chain on the CREATE.
   vpa-admission-controller webhook fires:
     - Looks up VPA by ownerReferences.
     - Reads VPA.status.recommendation.containerRecommendations.
     - Builds a JSONPatch replacing requests (and limits if controlled).
     - Returns AdmissionResponse{patch, patchType: JSONPatch}.

6. apiserver applies the patch and persists the pod with new requests.

7. scheduler bins it. New container gets the new cgroup limits at
   start (set by runtime via CRI when launching the container).
```

### Q: What's the difference between metrics-server's 15s window and VPA's histograms?

**A:**
- **metrics-server** retains only the last ~2 samples per pod, ~15s apart. It's a "what is happening *right now*" cache. No history. Perfect for HPA's instantaneous ratio computation and `kubectl top`.
- **VPA recommender** scrapes metrics-server every ~60s and feeds samples into per-container exponentially-bucketed histograms with **half-life decay** — older samples lose weight over a 24h CPU half-life. The histogram lets it answer "what was the P90 over the last day, weighted toward recent days?". The recommender persists these aggregates in `VerticalPodAutoscalerCheckpoint` so a restart doesn't lose history. Optionally, it bootstraps from Prometheus for genuinely long-term retention.

### Q: Can I run HPA and VPA together? Under what conditions?

**A:** Yes, **provided they don't share a knob**:

```
                  Same resource?
                        │
          ┌─────────────┴─────────────┐
          │                           │
         YES                          NO
          │                           │
   AVOID (oscillation)         SAFE
   ─ unless VPA is Off          ─ HPA on RPS / queue depth
   ─ or controlledResources     ─ VPA on CPU & memory
     splits CPU vs memory
     between them
```

Standard production pattern: HPA on application-level metrics (custom or external), VPA on CPU/memory. They scale on orthogonal axes (replica count vs. per-pod size).

### Q: What's the in-place pod resize feature, and which K8s version brought it?

**A:** KEP-1287, feature gate `InPlacePodVerticalScaling`. Alpha in v1.27, iterated through betas, stable in **v1.35** (on by default). It makes `pod.spec.containers[*].resources` mutable on a running pod through a dedicated `pod/resize` subresource. The kubelet calls CRI `UpdateContainerResources` to write new cgroup values without restarting the container (for CPU; memory typically still wants `restartPolicy: RestartContainer`). Resize state surfaces on `pod.status.conditions` as `PodResizePending` (Infeasible/Deferred) and `PodResizeInProgress` (with optional Error reason).

### Q: Why does memory typically need `RestartContainer` but CPU doesn't?

**A:** Two reasons:

1. **Kernel semantics.** Lowering `memory.limit_in_bytes`/`memory.max` below current RSS causes the kernel to OOM-kill processes inside the cgroup until usage drops. The kernel cannot reclaim already-allocated anonymous memory from a running process. Lowering CPU shares/weight just changes scheduling proportions — no process dies.
2. **Userspace runtimes.** JVM `-Xmx`, Go's `GOMEMLIMIT`, Node's V8 heap size, etc., are typically read at startup from the cgroup limit. Raising the limit in place doesn't make the runtime use more heap until restart. CPU autoscaling, by contrast, is something the kernel applies live.

Hence the safe defaults: CPU `NotRequired`, Memory `RestartContainer`.

### Q: How does KEDA fit into this picture?

**A:** KEDA is an event-driven autoscaler. It doesn't replace HPA; it **drives** HPA by:

1. Acting as an **external metrics adapter** registering itself for `external.metrics.k8s.io` via APIService aggregation.
2. Each `ScaledObject` CR creates an HPA under the hood whose metric source is `External` and whose target is "depth of this Kafka topic", "length of this SQS queue", "result of this Prometheus query", etc.
3. KEDA additionally implements **scale-to-zero** by suspending the Deployment when the metric is idle, then unsuspending and letting the HPA take over once events arrive. Vanilla HPA cannot scale to zero (`minReplicas >= 1`).

```
              Event source (SQS/Kafka/Prometheus/...)
                          │
                          │ KEDA scaler polls (every 30s by default)
                          ▼
                ┌────────────────────┐
                │       KEDA         │  ScaledObject reconciler
                │  - exposes metrics │  + external.metrics.k8s.io adapter
                │  - drives HPA      │
                └─────────┬──────────┘
                          │ creates / updates
                          ▼
                ┌────────────────────┐
                │    HPA (autogen)   │
                └─────────┬──────────┘
                          │ Scale subresource
                          ▼
                    Deployment / Job
```

### Q: Cluster Autoscaler vs HPA vs VPA — distinguish them.

**A:**

| | HPA | VPA | Cluster Autoscaler / Karpenter |
|---|---|---|---|
| What scales | Replica count of a workload | Per-container `requests`/`limits` | Number of cluster nodes |
| Trigger | Pod-level metrics (CPU, memory, custom, external) | Historical container resource usage | Pending pods that can't be scheduled / underused nodes |
| Where it runs | `kube-controller-manager` (in-tree) | 3 separate deployments (out-of-tree) | Standalone deployment (in `kubernetes/autoscaler`) or Karpenter (CNCF, AWS-origin) |
| Disrupts pods? | No (creates/deletes whole pods) | Yes — evicts to recreate (or in-place since 1.35) | Yes — drains nodes during scale-down |
| Touches | `Scale` subresource | Pod admission + Eviction API + Pod resize subresource | Cloud node groups / instance API |

They compose: VPA right-sizes individual pods → HPA chooses how many of them to run → CA/Karpenter ensures there are enough nodes to fit them. Misconfigure any one and the others suffer.

### Q: A teammate enabled HPA on `cpu` and VPA `Auto` on `cpu` for the same Deployment. Production starts oscillating. What do you change first?

**A:** The fastest fix is to flip the VPA's `updateMode` to `Off` and rely on it for recommendations only. That breaks the feedback loop immediately because the updater stops evicting. Then plan a structural change: either move HPA to a non-resource metric (RPS, queue depth) or restrict VPA via `controlledResources: ["memory"]` so the two autoscalers share no axis. Don't forget to set both `minAllowed`/`maxAllowed` on the VPA and `minReplicas`/`maxReplicas` on the HPA — without those guardrails an oscillation can scale a deployment to absurd sizes before anyone notices.

### Q: How does HPA decide which metrics API to query?

**A:** It is hard-coded by the value of `metrics[].type` in the HPA spec. The dispatch is not configurable:

```
type ──────────────────────► API queried
─────────────────────────────────────────────────────────
Resource          ─────────► metrics.k8s.io/v1beta1
ContainerResource ─────────► metrics.k8s.io/v1beta1   (per-container view)
Pods              ─────────► custom.metrics.k8s.io/v1beta2
Object            ─────────► custom.metrics.k8s.io/v1beta2
External          ─────────► external.metrics.k8s.io/v1beta1
```

Internally the HPA controller has a `MetricsClient` with three methods (`GetResourceMetric`, `GetRawMetric`, `GetExternalMetric`) and switches on `type` to pick which one. Whichever extension apiserver currently owns the `APIService` for that group/version is what the kube-apiserver will proxy the request to. You don't get to "redirect" `Resource` to a custom adapter — only metrics-server (or a drop-in replacement) can serve `metrics.k8s.io`.

### Q: Why isn't `metrics.k8s.io` implemented as a CRD?

**A:** Three reasons, all stemming from the same constraint: **etcd is the wrong store for metrics**.

```
                CRD                          Aggregated apiserver
─────────────────────────────────────────────────────────────────────────
Storage         etcd (forced)                whatever you want (RAM!)
Read pattern    GET object by name           computed-on-demand list/get
Write pattern   create/update/delete         no writes (read-only API)
Watch?          yes, etcd-backed             yes, but the "stream" is
                                             generated, not stored
Cardinality     1 row per object             N pods × M containers ×
                                             refresh every 15s = huge
```

Metrics are **ephemeral, high-cardinality, computed values**. metrics-server keeps the latest two samples per pod in RAM and recomputes on every request. Storing every sample in etcd would burn IOPS, balloon snapshot size, and provide no benefit (you don't want history at the API layer — Prometheus does that). That's exactly the use case the aggregation layer was designed for: a binary that owns its own storage strategy and registers itself as if it were native. CRDs cannot escape etcd; aggregated apiservers can.

### Q: Walk me through the lifecycle of a custom metric request from HPA to Prometheus.

**A:**
```
1. HPA controller tick (every 15s in kube-controller-manager).
   Sees metrics[]: type=Pods, name=http_requests_per_second, target=1k AverageValue.

2. Calls MetricsClient.GetRawMetric(...) → maps to:
     GET /apis/custom.metrics.k8s.io/v1beta2/namespaces/prod/pods/*/http_requests_per_second
         ?labelSelector=app%3Dweb

3. kube-apiserver receives the request.
   - Authn: bearer token / mTLS of kube-controller-manager.
   - Authz: SAR for hpa-controller SA against the metric URL.
   - Looks up APIService(v1beta2.custom.metrics.k8s.io) → backing Service:
       prometheus-adapter.monitoring.svc:443.
   - Aggregation layer: opens HTTPS to that Service, presenting
     --proxy-client-cert, with X-Remote-User / X-Remote-Group set to
     the controller's identity.

4. prometheus-adapter pod receives the request.
   - Validates the proxy-client cert against requestheader-client-ca.
   - Trusts X-Remote-User / X-Remote-Group as the caller identity.
   - Looks up the rule whose name.as matches "http_requests_per_second":
       seriesQuery: http_requests_total{...}
       name.matches: ^(.*)_total$  → http_requests
       name.as:      ${1}_per_second
   - Resolves resources.overrides + labelSelector to PromQL label matchers:
       {kubernetes_namespace="prod", kubernetes_pod_name=~"web-.*"}
   - Renders metricsQuery template:
       sum(rate(http_requests_total{ns="prod",pod=~"web-.*"}[2m]))
        by (kubernetes_namespace, kubernetes_pod_name)

5. adapter HTTP-GETs Prometheus /api/v1/query.
   Prometheus returns one vector sample per pod.

6. adapter shapes the result into a custom-metrics MetricValueList:
     items:
     - describedObject: {kind: Pod, namespace: prod, name: web-abc}
       metric: {name: http_requests_per_second}
       value: "850m"
       timestamp: 2026-05-09T...

7. Response flows back: adapter → kube-apiserver (proxy hop) → HPA controller.

8. HPA averages across pods, computes ratio, applies tolerance + behavior,
   PATCHes Scale subresource of the Deployment.
```

Latency budget at each hop: HPA tick is 15s, scrape interval is 15-30s, Prometheus rate window is 2m → end-to-end reaction time is roughly 30s-2m, dominated by Prometheus's scrape and rate window, not the API hops.

### Q: If both Datadog Cluster Agent and Prometheus Adapter want to serve `custom.metrics.k8s.io`, what happens?

**A:** They fight, and only one wins. The aggregation layer enforces **exactly one APIService per group/version**:

```
$ kubectl get apiservices v1beta2.custom.metrics.k8s.io -o yaml
spec:
  service:
    name: prometheus-adapter   # ← only one Service can be here
    namespace: monitoring
```

If you `helm install` Datadog Cluster Agent's external metrics provider after Prometheus Adapter, Datadog's chart will **overwrite** the APIService to point at its own Service (or its install will fail, depending on how the chart is written). Either way: only one adapter is reachable through that group at a time. The losing adapter's metrics simply disappear from the cluster's view.

Workarounds:
1. **Pick one and make it the umbrella.** Datadog Cluster Agent has a "translator" mode (`externalMetricsProvider.useDatadogMetric: true`) that lets it serve metrics that come from Datadog *and* proxy others.
2. **Use KEDA as the umbrella.** KEDA's `external.metrics.k8s.io` adapter can hold the APIService for that group and dispatch internally to Prometheus, Datadog, AWS, etc. via its scalers, then `ScaledObject` configures everything declaratively.
3. **Use different groups for different sources.** Custom for Prom, External for Datadog (or vice versa) — they have separate APIServices and can coexist.

### Q: What goes wrong if the metrics-server APIService is broken — only HPA, or other things too?

**A:** Far more than HPA, because the APIService is a global routing entry. A broken `v1beta1.metrics.k8s.io` APIService (Service down, cert mismatch, pod CrashLoopBackOff) cascades to:

```
Component                      Effect
─────────────────────────────────────────────────────────────────────
kubectl top node/pod           "Error from server: ServiceUnavailable"
HPA on Resource type           FailedGetResourceMetric, no scaling
                               on that metric (other metrics still work
                               if they use different groups)
VPA recommender                stops getting fresh samples; over time
                               recommendations drift
Dashboard / Lens / k9s         CPU/memory columns blank or stale
Custom controllers using the   broken; any client of metrics.k8s.io is
metrics API                    affected
kubectl api-resources          Lists v1beta1.metrics.k8s.io as
                               "APIService not available" and the call
                               can hang for the discovery timeout
```

The discovery hang is the gnarliest one — `kubectl get all` and similar commands wait on per-group discovery, so a broken APIService can make every kubectl command sluggish. That's why metrics-server is always run with `replicas: 2`, a PDB, and proper resource requests.

### Q: How does KEDA's ScaledObject relate to HPA?

**A:** ScaledObject is a higher-level CRD that **generates** an HPA for you. KEDA's controller watches ScaledObjects and reconciles a backing HPA whose metrics are all `type: External`, with metric names + label selectors that route through KEDA's own `external.metrics.k8s.io` adapter.

```
You write:                      KEDA generates:                 At runtime:
─────────────────────────────────────────────────────────────────────────
ScaledObject                    HPA (managed)                   HPA queries:
  scaleTargetRef: worker     →    metrics:                        external.metrics.k8s.io
  triggers:                  →    - type: External            →   adapter is KEDA itself
  - aws-sqs                  →      external:                     dispatches per labelSelector
  - prometheus                       metric: {name: s0-aws-sqs}   to right scaler
                                     target: 30
                                   - type: External
                                     external:
                                       metric: {name: s1-prom}
                                       target: 1000
                                 minReplicas: <KEDA computed>
                                 maxReplicas: <from spec>
```

ScaledObject also adds two capabilities HPA cannot do alone:
1. **Scale to zero.** When all triggers report no work, KEDA suspends the Deployment by patching `replicas: 0` directly and removes the HPA from the loop. Vanilla HPA requires `minReplicas >= 1`.
2. **Activation thresholds.** A separate threshold (lower than `target`) triggers the wake-up from zero, decoupling activation sensitivity from scaling sensitivity.

In short: KEDA delegates the hard parts (event-source SDKs, per-trigger auth, scale-to-zero) to itself, then drives standard HPA for the actual replica math.
