---
title: "Summary: Chkk Issue - Datadog External Metrics State Collision"
---

> **Full notes:** [[notes/K8s/chkk_issue|Chkk Issue →]]

## Key Concepts

### Part 1: Core Architecture -- What is `v1beta1.external.metrics.k8s.io`?

It is a Kubernetes `APIService` -- a resource that tells the main API server to proxy requests for an API group to a backend service instead of handling them itself. In this case, requests for `external.metrics.k8s.io` are forwarded to the Datadog Cluster Agent. The "Available: True" status on the APIService only confirms TCP connectivity (can the aggregation layer reach the backend on port 8443 and get a 200 from `/healthz`?). It does NOT verify that metrics can actually be fetched, that API keys are valid, or that metric definitions are correct. The pipe being open says nothing about the water quality.

### Part 2: The Workflow -- HPA Metric Request Flow

The HPA controller (part of `kube-controller-manager`) wakes up every 15-30 seconds. It sends a GET to the main API server for the metric (e.g., `/apis/external.metrics.k8s.io/v1beta1/namespaces/.../proxy-dynamic-min-replicas`). The aggregation layer looks up the APIService table and proxies the request to the Datadog Cluster Agent pod on port 8443. The agent translates the Kubernetes metric name into a Datadog query, fetches the value from Datadog's SaaS backend using its API key, and returns the value back up the chain to the HPA controller.

```
HPA Controller ──→ kube-apiserver ──→ Aggregation Layer ──→ Datadog Cluster Agent
                                                                    │
                                                           translates metric name
                                                                    │
                                                                    ▼
                                                            Datadog SaaS API
                                                                    │
                                                           value (e.g., 0.5)
                                                                    │
                                              returns back through the full chain
```

### Part 3: The Problem -- State Collision with dcaautogen

The Datadog Cluster Agent has an "autogen" feature: when an HPA references an external metric before a manual `DatadogMetric` CRD exists, the agent auto-generates an internal `DatadogMetric` object named `dcaautogen-<hash>`. The agent maintains an in-memory cache mapping `metric_name -> internal_object_id`. The bug: when a manual `DatadogMetric` CRD was later deployed, the agent's cache was "sticky" -- it kept pointing to the old `dcaautogen` ID instead of the new manual object. Since the old autogen object was stale/invalid, lookups failed with "DatadogMetric not found" even though `kubectl get datadogmetrics` showed the manual CRD as Active.

The `kubectl get datadogmetrics` command only queries etcd -- it shows the CRD's status as managed by the operator. But the metrics server component (the part answering HPA queries) was using a different, stale reference pointer in its own memory.

### Part 4: The Solution

Restarting the `datadog-cluster-agent` pod clears RAM, forcing a fresh scan of all existing `DatadogMetric` objects in the cluster. The new pod builds a clean mapping table, correctly mapping the metric name to the manual CRD. The stale `dcaautogen` reference is gone.

**Prevention:** (1) Always deploy `DatadogMetric` CRDs before or alongside HPAs -- never let an HPA reference a metric that doesn't exist yet. (2) Disable autogen entirely in production by setting `DD_EXTERNAL_METRICS_PROVIDER_ENABLE_DATADOGMETRIC_AUTOGEN=false`.

### Part 5: Verification with `kubectl get --raw`

`kubectl get --raw "/apis/external.metrics.k8s.io/..."` acts like a `curl` directly to the API endpoint. Unlike `kubectl get hpa` (which shows the HPA controller's cached status) or `kubectl get datadogmetrics` (which shows etcd state), `--raw` forces a live fetch through the full aggregation pipeline. If it returns JSON, the pipe works end-to-end. If it returns an error, the problem is in the backend (Datadog Agent), not in the HPA configuration.

## Quick Reference

```
The state collision:

  HPA requests metric "proxy-dynamic-min-replicas"
         │
         ▼
  Datadog Cluster Agent in-memory cache
  ┌──────────────────────────────────────────────┐
  │ "proxy-dynamic-min-replicas" → dcaautogen-54b│ ← STALE pointer
  │                                               │
  │ Manual DatadogMetric CRD exists in etcd      │ ← IGNORED by cache
  └──────────────────────────────────────────────┘
         │
         ▼
  "DatadogMetric not found" (the autogen object is gone/invalid)
```

| Diagnostic Command | What It Shows | Limitation |
|---|---|---|
| `kubectl get apiservice` | Network connectivity to backend | Does NOT verify data fetching works |
| `kubectl get datadogmetrics` | CRD status in etcd | Does NOT reflect the agent's internal cache |
| `kubectl get --raw /apis/external...` | Live fetch through the full pipeline | The real "truth serum" test |

## Key Takeaways

- APIService "Available: True" only means the TCP pipe is open -- it does not validate that the backend can serve real data
- The HPA metric flow involves 4 hops: HPA controller -> API server -> aggregation layer -> Datadog Agent -> Datadog SaaS
- The "DatadogMetric not found" error was caused by a stale in-memory cache pointing to an old `dcaautogen` reference instead of the manual CRD
- `kubectl get datadogmetrics` queries etcd, not the agent's internal cache -- they can disagree
- Always deploy `DatadogMetric` CRDs before or alongside HPAs to avoid autogen cache collisions
- Disable autogen in production: `DD_EXTERNAL_METRICS_PROVIDER_ENABLE_DATADOGMETRIC_AUTOGEN=false`
- `kubectl get --raw` is the best diagnostic tool -- it forces a live request through the entire aggregation pipeline, bypassing all caches
- Restarting the Cluster Agent pod is a valid fix for stale cache issues (clears RAM, rebuilds state from etcd)
