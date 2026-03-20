---
title: "Summary: Istio Envoy Proxy Internals"
---

> **Full notes:** [[notes/Networking/istio-envoy-internals|Istio Envoy Internals -->]]

## Key Concepts

### Envoy Request Processing Pipeline

Every request flows through: **Listener** (binds IP:port, e.g., 0.0.0.0:15006) -> **Filter Chain Match** (selects chain based on dest IP, port, SNI, ALPN) -> **Network Filters** (tcp_proxy, HttpConnectionManager) -> **HTTP Filters** (CORS, fault, RBAC, ext_authz, router) -> **Cluster** (logical upstream group, e.g., `outbound|8080||reviews.default.svc.cluster.local`) -> **Load Balancer** (round-robin, least-request, ring-hash, Maglev) -> **Endpoint** (actual pod IP:port from EDS).

**VirtualOutbound (15001)**: Uses `useOriginalDst: true` -- inspects the original destination (before iptables redirect) and hands off to the matching listener. If no match, uses passthrough cluster (direct connection).

**VirtualInbound (15006)**: Multiple filter chains, each matching a specific destination port with protocol-specific filters (HTTP or TCP).

### How Envoy Processes a Request (Step by Step)

1. Listener accepts the redirected connection
2. Filter chain selected based on original dest IP/port (from `SO_ORIGINAL_DST`)
3. Network filters execute (HCM parses HTTP, runs HTTP filter chains)
4. Router filter matches request against RDS route config
5. Matched route points to a cluster with LB policy
6. EDS provides healthy endpoints, LB picks one
7. Envoy opens (or reuses) connection to endpoint, performs mTLS if configured

### Threading Model

Three thread categories: **Main thread** handles xDS updates, admin API (port 15000), stats flushing, cluster/listener management -- never touches data-plane traffic. **Worker threads** (one per core) each run an independent libevent event loop, own their connections and connection pools. **File flush threads** write access logs to disk without blocking workers.

Key design: non-blocking event loops (thousands of connections per worker), connection affinity (one worker for entire connection lifetime), Thread-Local Storage (main thread pushes config snapshots to workers via read-copy-update -- no shared mutable state). Kernel distributes connections via `SO_REUSEPORT`. Worker count defaults to CPU cores; Istio's `pilot-agent` typically sets `--concurrency` to match the CPU limit (or 2 if no limit).

### Hot Restart

Zero-downtime binary upgrade sequence: pilot-agent launches new Envoy with incremented epoch -> new process connects to old via Unix domain socket -> old transfers listener sockets via `SCM_RIGHTS` -> both share a shared-memory stats region (counters persist) -> old process drains (stops accepting, finishes in-flight, default 600s) -> old exits.

In Istio sidecar mode, hot restart is rare because xDS delivers config dynamically. More relevant for Envoy binary upgrades or crash recovery.

### Filter Types in Depth

Three-tier model:

**Listener filters** (L3/L4, pre-connection): Execute before filter chain selection. Inspect raw bytes. Examples: `tls_inspector` (reads SNI + ALPN from ClientHello without decrypting), `http_inspector` (sniffs for HTTP vs non-HTTP), `proxy_protocol`, `original_dst`.

**Network filters** (L4, connection-level): Operate on TCP byte streams after chain selection. Last filter must be terminal (e.g., `tcp_proxy` or `http_connection_manager`). Other examples: `mongo_proxy`, `mysql_proxy`, `redis_proxy`, `rbac` (L4), `ext_authz` (L4).

**HTTP filters** (L7, request/response): Only active when HCM is the network filter. Each filter has `decodeHeaders`/`decodeData` (request path) and `encodeHeaders`/`encodeData` (response path). Request path executes in chain order; response path executes in **reverse** order. Any filter can short-circuit (e.g., RBAC returning 403 skips the router). Router filter must be last (terminal).

```
Request (decode):   CORS -> fault -> RBAC -> ext_authz -> router
Response (encode):  router -> ext_authz -> RBAC -> fault -> CORS  (REVERSED)
```

### Built-in HTTP Filters Used by Istio

| Filter | Purpose | Istio CRD |
|--------|---------|-----------|
| Router | Routes to upstream cluster (terminal) | VirtualService |
| RBAC | Allow/deny based on source, path, headers, JWT claims | AuthorizationPolicy |
| Fault Injection | Inject delays or aborts for chaos testing | VirtualService `fault` |
| ext_authz | Delegate authz to external service | AuthorizationPolicy (CUSTOM) |
| CORS | CORS preflight and response headers | VirtualService `corsPolicy` |
| Lua | Inline scripting for custom manipulation | EnvoyFilter |
| Wasm | WebAssembly plugins for custom logic | WasmPlugin CRD |
| JWT Authentication | Validate JWT against JWKS endpoints | RequestAuthentication |
| gRPC Stats | gRPC-specific metrics | Automatic |

### Connection Pooling

Managed per-cluster, per-worker-thread. **HTTP/1.1**: one request per connection, Envoy opens multiple connections for parallelism (bounded by `max_connections` circuit breaker). **HTTP/2**: multiple concurrent streams multiplexed over one connection per worker per endpoint (bounded by `max_concurrent_streams`). Pools are **not shared across workers** -- total connections = connections_per_worker x num_workers.

Circuit breaker integration: when thresholds are hit (`maxConnections`, `maxPendingRequests`, `maxRequestsPerConnection`), Envoy immediately returns 503 with response flag `UO` (upstream overflow).

### Health Checking

**Active health checking**: Envoy sends periodic probes (HTTP GET, TCP connect, or gRPC health). Configurable interval, timeout, unhealthy/healthy thresholds. **Not enabled by default in Istio sidecar mode** -- Istio relies on K8s readiness probes propagated via EDS.

**Passive health checking (outlier detection)**: Monitors real traffic, ejects endpoints after consecutive failures (5xx, gateway errors, local-origin failures) or low success rate. Configured via DestinationRule `outlierDetection`. Each ejection doubles the duration (exponential backoff). Safety valve: `maxEjectionPercent` (default 10%) prevents ejecting too many endpoints at once.

Key difference from K8s probes: K8s readiness probes are **global** (removed from Endpoints for all consumers). Outlier detection is **per-proxy** -- one Envoy may eject an endpoint others still consider healthy (useful for path-dependent failures like network partitions between specific nodes).

### Access Logging

Configured globally via MeshConfig (`accessLogFile: /dev/stdout`, `accessLogEncoding: JSON/TEXT`) or per-workload via Telemetry API. Default format includes timestamp, method, path, response code, response flags, upstream host, cluster name, latency.

Key response flags: `UH` (no healthy upstream), `UF` (upstream connection failure), `UO` (circuit breaker tripped), `NR` (no route), `URX` (retry limit exceeded), `DC` (downstream terminated), `RL` (rate limited), `UAEX` (ext_authz denied).

**gRPC ALS** (Access Log Service): Envoy streams logs to a remote gRPC service instead of files, enabling centralized collection without sidecar log shippers.

## Quick Reference

```
Request Pipeline:
  Listener -> Filter Chain Match -> Network Filters -> HTTP Filters -> Router -> Cluster -> LB -> Endpoint

Threading:
  Main Thread (xDS, admin, stats) -> RCU -> Worker 0..N (event loop, connections, pools)
  Connections: kernel SO_REUSEPORT distributes, each worker owns for lifetime

Hot Restart:
  New process -> UDS to old -> SCM_RIGHTS socket transfer -> shared memory stats -> old drains -> exits

Filter Execution:
  Request (decode):   filter_1 -> filter_2 -> ... -> router (terminal)
  Response (encode):  router -> ... -> filter_2 -> filter_1 (REVERSED)
```

| Health Mechanism | Scope | Extra Traffic? | Default in Istio? |
|-----------------|-------|---------------|-------------------|
| Active health check | Per-proxy | Yes (probes) | No |
| Outlier detection | Per-proxy | No (real traffic) | Configurable via DestinationRule |
| K8s readiness probe | Global (all consumers) | Yes | Yes (affects EDS) |

| Connection Pool | HTTP/1.1 | HTTP/2 |
|----------------|----------|--------|
| Concurrency | 1 request/connection | Many streams/connection |
| Connections | Multiple per endpoint | Typically 1 per worker per endpoint |
| Bounded by | `max_connections` | `max_concurrent_streams` + `max_requests` |

## Key Takeaways

- Envoy's event-loop model handles thousands of connections per worker without blocking -- no thread-per-connection overhead. No cross-thread locking on the hot path.
- HTTP filters execute in chain order on requests and in REVERSE order on responses. Any filter can short-circuit (RBAC returning 403 skips the router).
- Hot restart preserves listener sockets (`SCM_RIGHTS`) and stats (shared memory) across binary upgrades. Rarely needed in Istio because xDS delivers config dynamically.
- Connection pools are per-worker, per-cluster. Total connections = per_worker x num_workers. Circuit breaker overflow returns 503 with flag `UO`.
- Outlier detection is local to each proxy -- one Envoy may eject an endpoint that others still consider healthy. K8s readiness probes are global (affect all consumers).
- Active health checking is not default in Istio sidecars. Primary health signals come from K8s readiness probes (via EDS) + outlier detection (via DestinationRule).
- Access log response flags (UH, UF, UO, NR, URX, UAEX) are essential for diagnosing Envoy routing issues.
- gRPC ALS enables centralized access log collection without file-based sidecar log shippers.
