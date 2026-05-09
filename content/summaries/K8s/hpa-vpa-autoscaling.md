---
title: "Summary: HPA, VPA, metrics-server, and the Custom/External Metrics Pipeline"
---

> **Full notes:** [[notes/K8s/hpa-vpa-autoscaling|HPA / VPA / Autoscaling -->]]

## Key Concepts

### HPA Control Loop

HPA is a controller inside `kube-controller-manager` (NOT a separate pod). Watches `HorizontalPodAutoscaler` (`autoscaling/v2`) via informers. Tick rate `--horizontal-pod-autoscaler-sync-period` default **15s**.

Algorithm:
```
desiredReplicas = ceil[currentReplicas * (currentMetricValue / desiredMetricValue)]
```

For `Resource` metrics, `currentMetricValue` is averaged across **ready** pods; utilization is computed against `requests` (not limits). Missing requests → `FailedGetResourceMetric`.

- **Tolerance**: `--horizontal-pod-autoscaler-tolerance` default **0.1 (10%)**. Per-HPA tolerance via `behavior.scaleUp.tolerance` / `scaleDown.tolerance` is beta in 1.33 behind `HPAConfigurableTolerance`.
- **Stabilization windows**: scaleDown default **300s** (controller takes MAX recommendation in window); scaleUp default **0s**.
- **Behavior policies**: `Percent` and `Pods` types with `periodSeconds`, `selectPolicy: Min/Max/Disabled`.
- **Multi-metric**: per-metric recommendation, take MAX.
- **Special handling**: missing-metric pods are conservative (100% on scale-down, 0% on scale-up); pods younger than `--horizontal-pod-autoscaler-cpu-initialization-period` (default 5m) with not-yet-ready CPU are discarded.

### Scale subresource

HPA never reads `.spec.replicas` directly — it reads/writes the `Scale` subresource (`autoscaling/v1.Scale`), a virtual projection exposing only `spec.replicas`, `status.replicas`, `status.selector`. CRDs must declare `subresources.scale` with `specReplicasPath`, `statusReplicasPath`, and `labelSelectorPath` (selector required for HPA).

### VPA — three components

VPA is **out-of-tree** (`kubernetes/autoscaler`). CRD: `VerticalPodAutoscaler` (`autoscaling.k8s.io/v1`).

| Component | Role |
|---|---|
| `vpa-recommender` | ~1m loop. Pulls usage from metrics-server (or `--prometheus-address`). Maintains in-memory **histograms** with exponential bucketing + half-life decay (default 24h). Target ≈ P90 + ~15% margin; OOMs bump memory aggressively. Writes `target/lowerBound/upperBound/uncappedTarget` to `vpa.status.recommendation`. |
| `vpa-updater` | Watches VPA + pods. Calls **Eviction API** (respects PDBs); does NOT directly modify pods. Tolerance ~10%. Rate-limited. |
| `vpa-admission-controller` | MutatingAdmissionWebhook on pod CREATE. Looks up VPA via `targetRef`, rewrites `resources.requests`/`limits` via JSON Patch. Without it, evicted pods come back with old requests from the deployment template. |

Update modes: `Off`, `Initial`, `Recreate`, `Auto`, `InPlaceOrRecreate` (alpha 1.33+).

### In-place pod resize (KEP-1287)

`InPlacePodVerticalScaling`. Alpha 1.27, Beta 1.32, GA 1.35. Kubelet patches `spec.containers[*].resources` on a running pod, calls runtime via CRI `UpdateContainerResources` → cgroup write:

- v1: `cpu.shares`, `cpu.cfs_quota_us`, `memory.limit_in_bytes`
- v2: `cpu.weight`, `cpu.max`, `memory.max`

Per-resource `resizePolicy`: CPU `NotRequired`, Memory `RestartContainer` (shrinking memory below usage = OOM). Status surfaced via `PodResizePending` / `PodResizeInProgress` conditions.

### metrics-server pipeline

Single-purpose component. Scrapes every kubelet's `/metrics/resource` endpoint (cAdvisor embedded) every **15s** (`--metric-resolution`). Serves `metrics.k8s.io/v1beta1` (no `v1` exists yet) via the **API aggregation layer**. **In-memory only**, ~60s window — no historical storage.

```
Kubelet (cAdvisor) ──scrape 15s──▶ metrics-server ──serves /apis/metrics.k8s.io/v1beta1──▶ kube-apiserver
                                                                                              │
                                                                                              ▼
                                                                                 HPA, kubectl top, VPA
```

VPA needs *historical* data; the recommender polls metrics-server every minute and accumulates its own histograms in-memory (or read directly from Prometheus via `--prometheus-address`).

### The three metrics APIs and HPA type → API dispatch

| HPA `metrics[].type` | API queried | Implemented by |
|---|---|---|
| `Resource` | `metrics.k8s.io` | metrics-server |
| `ContainerResource` (GA 1.27) | `metrics.k8s.io` (per-container) | metrics-server |
| `Pods` | `custom.metrics.k8s.io` | Prometheus Adapter, KEDA, Datadog |
| `Object` | `custom.metrics.k8s.io` | (same) |
| `External` | `external.metrics.k8s.io` | KEDA, cloud adapters |

Mapping is **hardcoded** in the HPA controller (kube-controller-manager). Internally HPA uses one `MetricsClient` with `GetResourceMetric`, `GetRawMetric` (Pods/Object), `GetExternalMetric`. Cannot be redirected without recompiling Kubernetes.

### custom.metrics.k8s.io

Metrics tied to K8s objects (Pods, Services, Ingresses, CRDs). URL shapes:
```
/apis/custom.metrics.k8s.io/v1beta2/namespaces/<ns>/<resource>/<name>/<metric>
/apis/custom.metrics.k8s.io/v1beta2/namespaces/<ns>/<resource>/*/<metric>?labelSelector=...
```

Prometheus Adapter rule example:
```yaml
- seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
  resources:
    overrides:
      namespace: { resource: namespaces }
      pod: { resource: pods }
  name: { matches: "^(.*)_total$", as: "${1}_per_second" }
  metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)'
```

### external.metrics.k8s.io

Metrics not tied to any K8s object (SQS depth, Kafka lag, Cloudflare RPS). URL: `/apis/external.metrics.k8s.io/v1beta1/namespaces/<ns>/<metric>?labelSelector=...`. **Only ONE adapter per APIService group/version** — KEDA + cloud adapters fight over the registration.

### KEDA's ScaledObject — higher-level abstraction

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
spec:
  scaleTargetRef: { name: api }
  triggers:
    - type: prometheus
      metadata: { serverAddress: ..., query: ..., threshold: "100" }
    - type: aws-sqs-queue
      metadata: { queueURL: ..., queueLength: "30" }
```

KEDA reads this, **generates an HPA** with `type: External` entries, registers each metric uniquely under its own external-metrics adapter. Closest you get to "modifying" the type→API routing in practice.

### HPA + VPA conflict

Same-resource oscillation: traffic spike → CPU rises → HPA adds replicas → per-pod CPU drops → VPA recommends smaller requests → updater evicts → utilization vs smaller requests looks high again → HPA adds more replicas. Loop.

Official: don't run both on CPU/memory unless one of:
1. HPA on custom/external metrics + VPA on resources (cleanest)
2. VPA in `Off` mode (advice only)
3. Split resources: VPA `controlledResources: ["memory"]`, HPA on CPU
4. Future: SIG-Autoscaling MultiDimensional Pod Autoscaler (MPA), not GA

Always set `minAllowed`/`maxAllowed` on VPA and `min`/`maxReplicas` on HPA.

## Quick Reference

### Pipeline architecture

```
                    metrics-server (15s scrape, in-RAM)
                              │
                              ▼  /apis/metrics.k8s.io/v1beta1
   ┌─────────────────────────────────────────────────────┐
   │                kube-apiserver (aggregation layer)    │
   └─────────────────────────────────────────────────────┘
       ▲                    ▲                       ▲
       │ Resource           │ Pods/Object           │ External
       │                    │                       │
   ┌───┴───┐         ┌──────┴──────┐         ┌──────┴──────┐
   │  HPA  │────────▶│ prom-adapter │         │    KEDA      │
   │ (KCM) │         │  (custom.    │         │  (external.  │
   └───────┘         │  metrics)    │         │  metrics)    │
       │             └──────────────┘         └──────────────┘
       │ writes
       ▼
   /scale subresource → Deployment/StatefulSet/CRD
```

### HPA defaults

| Knob | Default |
|---|---|
| Sync period | 15s |
| Tolerance | 0.10 (10%) |
| scaleDown stabilization | 300s |
| scaleUp stabilization | 0s |
| CPU initialization period | 5m (300s) |
| metrics-server scrape | 15s |
| metrics-server window | ~60s |

### scaleDown vs scaleUp behavior defaults

```
scaleDown:   take MAX recommendation in last 300s window
             rate ≤ 100% per minute (selectPolicy: Max)
scaleUp:     react immediately (0s window)
             rate ≤ 100% per 15s OR ≤ 4 pods per 15s, whichever is more
```

### Inspection

```bash
kubectl get apiservices | grep metrics
kubectl get --raw /apis/metrics.k8s.io/v1beta1 | jq
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta2 | jq
kubectl get --raw /apis/external.metrics.k8s.io/v1beta1 | jq
kubectl describe hpa <name>          # ScalingActive / AbleToScale conditions
kubectl get vpa <name> -o yaml       # .status.recommendation
kubectl get deployment X --subresource=scale
```

## Key Takeaways

- HPA lives in `kube-controller-manager`, ticks every 15s, and uses one ratio formula: `ceil[currentReplicas * (current/target)]`. Utilization is always against `requests`, never `limits`.
- A 10% tolerance band suppresses noise; stabilization windows (default 0s up, 300s down) prevent flapping.
- HPA always reads/writes `/scale` — never `.spec.replicas` directly. CRDs need a `scale` subresource (with `labelSelectorPath`) to be HPA-targets.
- VPA is three out-of-tree components: histogram-based recommender (P90 + margin), eviction-driven updater, and a mutating admission webhook that rewrites requests on pod CREATE.
- In-place pod resize (KEP-1287) went GA in v1.35 — kubelet writes cgroups directly. CPU usually `NotRequired`; memory typically `RestartContainer` to avoid OOM on shrink.
- metrics-server is in-RAM, ~60s window, served via API aggregation. It's mandatory for HPA Resource type and VPA but cannot be Prometheus-replaced for those uses (the API contract is hardcoded).
- HPA's `metrics[].type` field is the ONLY thing that picks the API group — `Resource` → metrics.k8s.io, `Pods`/`Object` → custom.metrics.k8s.io, `External` → external.metrics.k8s.io. Mapping is hardcoded in the controller.
- `custom.metrics.k8s.io` requires an adapter (Prometheus Adapter most common); `external.metrics.k8s.io` typically uses KEDA. Only one adapter per APIService group — KEDA usually subsumes cloud adapters.
- KEDA's `ScaledObject` is a layer above HPA that auto-generates HPAs with the right `type: External` entries — practical "indirection" over routing.
- HPA + VPA on the same resource oscillates. Approved patterns: HPA on custom metric + VPA on resources, VPA `Off` mode, or split resources.
- Always bound autoscalers (`min`/`maxReplicas`, `minAllowed`/`maxAllowed`) — unbounded VPA can recommend pod sizes no node can fit.
