---
title: "Summary: Istio Envoy Proxy Internals"
---

> **Full notes:** [[notes/Networking/istio-envoy-internals|Istio Envoy Internals -->]]

## Key Concepts

- **Request pipeline**: Listener -> Filter Chain Match -> Network Filters -> HTTP Filters -> Router -> Cluster -> Load Balancer -> Endpoint. Every VirtualService/DestinationRule maps to these Envoy abstractions.

- **Threading model**: Main thread (xDS, admin API, stats -- no data plane traffic) + N worker threads (each with its own event loop, connections, and connection pools). No cross-thread locking on the hot path. Kernel distributes connections via `SO_REUSEPORT`.

- **Hot restart**: Zero-downtime binary upgrade. New process receives listener sockets from old process via `SCM_RIGHTS`. Shared memory preserves stats counters. Old process drains in-flight requests before exiting.

- **Three filter tiers**: Listener filters (L3/L4, pre-connection: TLS inspector, HTTP inspector), Network filters (L4: tcp_proxy, HCM), HTTP filters (L7: router, RBAC, fault injection, Wasm).

- **Connection pooling**: Per-cluster, per-worker-thread. HTTP/1.1 uses one request per connection (multiple connections for parallelism). HTTP/2 multiplexes many streams over one connection per worker per endpoint.

- **Outlier detection**: Passive health checking -- monitors real traffic, ejects endpoints after consecutive failures. Per-proxy (not global like K8s readiness probes). Exponential backoff on ejection duration.

## Quick Reference

```
Filter Execution Order:
  Request (decode):   CORS -> fault -> RBAC -> ext_authz -> router
  Response (encode):  router -> ext_authz -> RBAC -> fault -> CORS  (REVERSED)
```

| Filter Tier | When | Examples |
|-------------|------|---------|
| Listener | Pre-connection | tls_inspector, http_inspector, proxy_protocol |
| Network | Connection-level (L4) | tcp_proxy, http_connection_manager, rbac |
| HTTP | Request/response (L7) | router, rbac, fault, jwt_authn, wasm |

| Health Mechanism | Scope | Extra Traffic? | Default in Istio? |
|-----------------|-------|---------------|-------------------|
| Active health check | Per-proxy | Yes | No |
| Outlier detection | Per-proxy | No | Configurable via DestinationRule |
| K8s readiness probe | Global | Yes | Yes (affects EDS) |

**Connection pools are per-worker** -- total connections = connections_per_worker x num_workers.

**Circuit breaker overflow** returns 503 with response flag `UO`.

## Key Takeaways

- Envoy's event-loop model handles thousands of connections per worker without blocking -- no thread-per-connection overhead.
- HTTP filters execute in chain order on requests and in REVERSE order on responses. Any filter can short-circuit the chain.
- Hot restart is rarely triggered in Istio sidecars because xDS delivers config changes dynamically -- it matters for binary upgrades and crash recovery.
- Outlier detection is local to each proxy -- one Envoy may eject an endpoint that others still consider healthy (useful for path-dependent failures).
- Access log response flags (UH, UF, UO, NR, URX) are essential for diagnosing Envoy routing issues.
