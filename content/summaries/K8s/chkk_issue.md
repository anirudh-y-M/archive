---
title: "Summary: Chkk Issue - Datadog External Metrics State Collision"
---

> **Full notes:** [[notes/K8s/chkk_issue|Chkk Issue →]]

## Key Concepts

**APIService & Aggregation Layer** -- The `v1beta1.external.metrics.k8s.io` APIService tells the main API server to proxy metric requests to the Datadog Cluster Agent. The "Available: True" status only means TCP connectivity works -- it says nothing about whether metrics are actually fetchable.

**HPA metric flow** -- HPA controller wakes up every 15-30s, sends a GET to the API server for the metric, which proxies it to the Datadog Cluster Agent, which queries Datadog's SaaS backend, and returns the value back up the chain.

**State collision (the bug)** -- The Datadog Cluster Agent has an "autogen" feature (`dcaautogen`) that auto-creates internal `DatadogMetric` mappings when an HPA references a metric before a manual CRD exists. The agent's in-memory cache got stuck pointing to a stale autogen reference instead of the newer manual `DatadogMetric` CRD. Result: "DatadogMetric not found" even though `kubectl get datadogmetrics` showed it as active.

**Fix** -- Restarting the Cluster Agent pod clears the in-memory cache and rebuilds mappings fresh from existing CRDs.

## Quick Reference

```
HPA Controller → API Server → Aggregation Layer → Datadog Cluster Agent → Datadog SaaS
                                                         ↑
                                          In-memory cache (stale autogen ref)
                                          was pointing to dcaautogen-<hash>
                                          instead of the manual DatadogMetric
```

| Diagnostic | What It Shows | Limitation |
|---|---|---|
| `kubectl get apiservice` | Network connectivity to backend | Does NOT verify data fetching works |
| `kubectl get datadogmetrics` | CRD status in etcd | Does NOT reflect the agent's internal cache |
| `kubectl get --raw /apis/external...` | Live fetch through the full pipeline | The real "truth serum" test |

## Key Takeaways

- APIService "Available: True" only means the TCP pipe is open -- it does not validate that the backend can serve real data
- Always deploy `DatadogMetric` CRDs before or alongside HPAs to avoid autogen cache collisions
- Disable autogen in production: `DD_EXTERNAL_METRICS_PROVIDER_ENABLE_DATADOGMETRIC_AUTOGEN=false`
- `kubectl get --raw` is the best diagnostic tool -- it forces a live request through the entire aggregation pipeline
- When in-memory caches go stale, restarting the pod is a valid fix (clears RAM, rebuilds state from etcd)
