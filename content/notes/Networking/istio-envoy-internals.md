---
title: "Istio Envoy Proxy: Internals, Threading, Filters, Connection Pooling, and Health Checking"
---

## Overview

Envoy is the high-performance L4/L7 proxy (written in C++) that forms the data plane of Istio. Every meshed pod runs an Envoy instance as a sidecar (`istio-proxy` container). This note covers Envoy's internal architecture in depth: the request processing pipeline, threading model, hot restart mechanism, filter system, connection pooling, health checking, and access logging.

For the Istio control plane architecture (istiod, xDS, sidecar injection, iptables interception), see [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]]. For traffic management CRDs (VirtualService, DestinationRule, Gateway API), see [[notes/Networking/istio-traffic-management|Istio Traffic Management]].

---

## Envoy Request Processing Pipeline

Envoy processes every request through a pipeline of four core abstractions: **Listener -> Filter Chain -> Router -> Cluster -> Endpoint**. Understanding this model is essential for debugging Istio because every VirtualService and DestinationRule maps directly to these Envoy concepts.

```
                    Incoming Connection
                           │
                           ▼
                   ┌───────────────┐
                   │   LISTENER    │  Binds to IP:port
                   │  (LDS config) │  e.g., 0.0.0.0:15006
                   └───────┬───────┘
                           │
                           ▼
                ┌─────────────────────┐
                │  FILTER CHAIN MATCH │  Match on dest IP, port, SNI,
                │                     │  ALPN, transport protocol
                └──────────┬──────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  Filter  │ │  Filter  │ │  Filter  │  Network filters:
        │  Chain 1 │ │  Chain 2 │ │  Chain N │  - TCP proxy
        └────┬─────┘ └──────────┘ └──────────┘  - HTTP conn manager
             │                                    - Authz filter
             ▼                                    - RBAC filter
     ┌───────────────┐                            - WASM filters
     │ HTTP FILTERS  │
     │               │
     │ - Router      │ ◄── Uses RDS route config
     │ - Fault       │
     │ - CORS        │
     │ - Lua/WASM    │
     └───────┬───────┘
             │  Route match (host + path + headers)
             ▼
     ┌───────────────┐
     │   CLUSTER     │  Logical group of endpoints
     │  (CDS config) │  e.g., "outbound|8080||reviews.default.svc.cluster.local"
     └───────┬───────┘
             │
             ▼
     ┌───────────────┐
     │  LOAD BALANCER│  Round-robin, least-request,
     │               │  random, ring-hash, Maglev
     └───────┬───────┘
             │
             ▼
     ┌───────────────┐
     │   ENDPOINT    │  Actual pod IP:port
     │  (EDS config) │  e.g., 10.48.2.15:8080
     └───────────────┘
```

### How Envoy Processes a Request (Step by Step)

1. **Listener accepts connection** -- The VirtualInbound (15006) or VirtualOutbound (15001) listener accepts the redirected connection
2. **Filter chain selection** -- Envoy examines the original destination IP/port (preserved by iptables REDIRECT via `SO_ORIGINAL_DST`) and selects the matching filter chain
3. **Network filters execute** -- For HTTP traffic, the `HttpConnectionManager` (HCM) filter parses HTTP and runs HTTP filter chains
4. **Route matching** -- The Router filter matches the request against route configurations (from RDS). A route entry specifies which cluster to forward to
5. **Cluster selection** -- The matched route points to a cluster. The cluster has a load balancing policy and health check configuration
6. **Endpoint selection** -- EDS provides the list of healthy endpoints. The load balancer picks one
7. **Connection to upstream** -- Envoy opens (or reuses) a connection to the selected endpoint. If mTLS is configured, Envoy performs a TLS handshake using certificates from SDS

### The VirtualOutbound Listener (Port 15001)

This listener uses a special `useOriginalDst: true` setting. Instead of handling traffic itself, it inspects the original destination (before iptables redirected it) and hands the connection off to the listener that matches that destination. If no specific listener exists, it forwards through a passthrough cluster (direct connection to the original destination).

### The VirtualInbound Listener (Port 15006)

This listener has multiple filter chains, each matching a specific destination port. For example, if the application listens on port 8080, there will be a filter chain matching destination port 8080 with the appropriate protocol-specific filters (HTTP or TCP).

---

## Threading Model

Envoy uses a multi-threaded architecture with a strict thread-local design that avoids locks on the hot path. There are three categories of threads:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ENVOY THREADING MODEL                                 │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        MAIN THREAD                                      │  │
│  │                                                                         │  │
│  │  - Startup / shutdown coordination                                      │  │
│  │  - xDS API processing (receives config from istiod)                     │  │
│  │  - Runtime config reloads                                               │  │
│  │  - Stats flushing (periodic aggregation from workers)                   │  │
│  │  - Admin API server (port 15000)                                        │  │
│  │  - Cluster / listener management (creates, updates, drains)             │  │
│  │                                                                         │  │
│  │  Does NOT handle any data-plane traffic                                 │  │
│  └────────────────────────────┬────────────────────────────────────────────┘  │
│                               │                                              │
│                    ┌──────────┴──────────┐                                   │
│                    │  Thread-Local Store  │  Config snapshots pushed          │
│                    │   (TLS mechanism)    │  from main → workers via          │
│                    └──────────┬──────────┘  read-copy-update (RCU)           │
│                               │                                              │
│          ┌────────────────────┼────────────────────┐                         │
│          ▼                    ▼                    ▼                          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │  WORKER       │    │  WORKER       │    │  WORKER       │                  │
│  │  THREAD 0     │    │  THREAD 1     │    │  THREAD N     │                  │
│  │               │    │               │    │               │                  │
│  │  - Own event  │    │  - Own event  │    │  - Own event  │                  │
│  │    loop       │    │    loop       │    │    loop       │                  │
│  │    (libevent) │    │    (libevent) │    │    (libevent) │                  │
│  │               │    │               │    │               │                  │
│  │  - Owns its   │    │  - Owns its   │    │  - Owns its   │                 │
│  │    connections│    │    connections│    │    connections│                  │
│  │               │    │               │    │               │                  │
│  │  - Listener   │    │  - Listener   │    │  - Listener   │                 │
│  │    filter     │    │    filter     │    │    filter     │                  │
│  │    chains     │    │    chains     │    │    chains     │                  │
│  │               │    │               │    │               │                  │
│  │  - Upstream   │    │  - Upstream   │    │  - Upstream   │                 │
│  │    conn pools │    │    conn pools │    │    conn pools │                  │
│  │  (per-worker) │    │  (per-worker) │    │  (per-worker) │                 │
│  └──────────────┘    └──────────────┘    └──────────────┘                   │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                     FILE FLUSH THREAD(S)                                │  │
│  │  - Writes access logs to disk                                           │  │
│  │  - Separate from workers to avoid blocking on I/O                       │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

Key design principles:

- **Non-blocking event loop**: Each worker thread runs a libevent-based event loop. All I/O (socket reads/writes, DNS, TLS handshakes) is asynchronous. A single worker can handle thousands of concurrent connections without blocking.
- **Connection affinity**: Once the kernel accepts a connection on a listener socket, it is assigned to one worker thread for its entire lifetime. All downstream and corresponding upstream processing happen on that same thread -- no cross-thread locking needed.
- **Thread-Local Storage (TLS)**: The main thread distributes configuration updates (new clusters, routes, secrets) to workers using a read-copy-update mechanism. Each worker holds a thread-local read-only snapshot of the config. Workers never contend on shared mutable state.
- **Worker count**: Defaults to the number of hardware threads (cores). In Istio sidecar mode, `pilot-agent` typically sets `--concurrency` to match the CPU limit of the `istio-proxy` container (or 2 by default if no limit is set).

The kernel distributes new connections across worker threads using `SO_REUSEPORT` -- each worker has its own listener socket bound to the same address, and the kernel load-balances incoming SYN packets across them.

---

## Hot Restart

Envoy supports zero-downtime binary upgrades and config reloads through a **hot restart** mechanism. This is how `pilot-agent` can restart Envoy without dropping connections:

```
┌───────────────────────────────────────────────────────────────┐
│                    HOT RESTART SEQUENCE                         │
│                                                                │
│  Time ──────────────────────────────────────────────────►      │
│                                                                │
│  ┌─────────────────────────────────────────────────┐          │
│  │  Old Envoy Process (epoch N)                     │          │
│  │                                                   │          │
│  │  Accepting ──► Draining ──────────────► Exit      │          │
│  │  connections    (stops accepting new    (after     │          │
│  │                  connections, finishes  drain      │          │
│  │                  in-flight requests)    period)    │          │
│  └──────────┬──────────────────────────────────────┘          │
│             │                                                  │
│             │  1. New process starts                           │
│             │  2. Connects to old process via                  │
│             │     Unix domain socket                           │
│             │  3. Shared memory region for                     │
│             │     stats counters (so counters                  │
│             │     don't reset across restarts)                 │
│             │  4. Old process transfers listen                 │
│             │     sockets via SCM_RIGHTS                       │
│             ▼                                                  │
│  ┌─────────────────────────────────────────────────┐          │
│  │  New Envoy Process (epoch N+1)                   │          │
│  │                                                   │          │
│  │  Initializing ──► Accepting connections           │          │
│  │  (receives        (takes over listener            │          │
│  │   sockets,         sockets, serves                │          │
│  │   loads config)    new connections)                │          │
│  └─────────────────────────────────────────────────┘          │
└───────────────────────────────────────────────────────────────┘
```

The hot restart process in detail:

1. `pilot-agent` launches a new Envoy process with an incremented **restart epoch**.
2. The new process connects to the old process over a Unix domain socket (the "hot restart RPC" channel).
3. The old process transfers its **listener sockets** to the new process using Unix `SCM_RIGHTS` (file descriptor passing). This allows the new process to immediately begin accepting connections on the same addresses.
4. Both processes share a **shared memory region** that holds stats counters. This ensures metric counters (e.g., total requests served) are not reset across restarts.
5. The old process enters a **drain period** (configurable via `--drain-time-s`, default 600s in Istio). During draining, the old process stops accepting new connections but continues processing existing in-flight requests to completion.
6. Once the drain period expires (or all connections close), the old process exits.

> **Note:** In Istio sidecar mode, hot restart is less commonly triggered because Envoy receives configuration changes dynamically via xDS without needing a restart. Hot restart is more relevant when the Envoy binary itself is upgraded or when `pilot-agent` detects a crash and relaunches Envoy.

---

## Filter Types in Depth

Envoy's extensibility is built around a three-tier filter model. Filters execute in a chain, and each filter can inspect, modify, or terminate the request/response at its stage.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       ENVOY FILTER PIPELINE                               │
│                                                                           │
│  Connection arrives at listener                                           │
│         │                                                                 │
│         ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  LISTENER FILTERS  (L3/L4, pre-connection)                          │ │
│  │                                                                      │ │
│  │  Execute BEFORE a filter chain is selected.                          │ │
│  │  Can inspect raw bytes, TLS ClientHello, proxy protocol header.      │ │
│  │                                                                      │ │
│  │  Examples:                                                            │ │
│  │  - tls_inspector: reads SNI + ALPN from ClientHello (no decryption) │ │
│  │  - http_inspector: sniffs first bytes to detect HTTP vs non-HTTP    │ │
│  │  - proxy_protocol: reads PROXY protocol header (HAProxy format)      │ │
│  │  - original_dst: recovers original destination (iptables redirect)   │ │
│  └─────────────────────────────────────┬───────────────────────────────┘ │
│                                        │                                  │
│         Filter chain selected based on SNI/port/protocol                 │
│                                        │                                  │
│                                        ▼                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  NETWORK FILTERS  (L4, connection-level)                             │ │
│  │                                                                      │ │
│  │  Operate on raw TCP byte streams. Read/write data on the             │ │
│  │  downstream connection. Can be read, write, or read/write filters.   │ │
│  │                                                                      │ │
│  │  Examples:                                                            │ │
│  │  - tcp_proxy: forwards TCP to upstream cluster (terminal filter)     │ │
│  │  - http_connection_manager (HCM): parses HTTP, runs HTTP filters    │ │
│  │  - mongo_proxy: MongoDB wire protocol aware proxy                    │ │
│  │  - mysql_proxy: MySQL wire protocol aware proxy                      │ │
│  │  - redis_proxy: Redis protocol aware proxy                           │ │
│  │  - rbac: L4 RBAC enforcement (source IP, port)                      │ │
│  │  - ext_authz: L4 external authorization                             │ │
│  │                                                                      │ │
│  │  The last network filter in the chain must be a TERMINAL filter      │ │
│  │  (e.g., tcp_proxy or http_connection_manager).                       │ │
│  └─────────────────────────────────────┬───────────────────────────────┘ │
│                                        │                                  │
│         (Only if HCM is in the chain)  │                                  │
│                                        ▼                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  HTTP FILTERS  (L7, request/response-level)                          │ │
│  │                                                                      │ │
│  │  Operate on decoded HTTP requests/responses. Each filter has         │ │
│  │  decodeHeaders/decodeData (request path) and                         │ │
│  │  encodeHeaders/encodeData (response path) callbacks.                 │ │
│  │                                                                      │ │
│  │  Request flow (decode):                                               │ │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐       │ │
│  │  │ CORS   ├─►│ fault  ├─►│ RBAC   ├─►│ext_    ├─►│ router │       │ │
│  │  │        │  │ inject │  │        │  │authz   │  │(terminal│       │ │
│  │  └────────┘  └────────┘  └────────┘  └────────┘  └────────┘       │ │
│  │                                                                      │ │
│  │  Response flow (encode):  ◄── reverse order ──                       │ │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐       │ │
│  │  │ router ├─►│ext_    ├─►│ RBAC   ├─►│ fault  ├─►│ CORS   │       │ │
│  │  │        │  │authz   │  │        │  │ inject │  │        │       │ │
│  │  └────────┘  └────────┘  └────────┘  └────────┘  └────────┘       │ │
│  │                                                                      │ │
│  │  The router filter MUST be the last HTTP filter (terminal).          │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

**Decode vs Encode execution model**: HTTP filters implement two callback paths. During the **decode** (request) phase, filters execute in the order they appear in the chain. During the **encode** (response) phase, filters execute in **reverse** order. Any filter can stop the chain -- for example, the RBAC filter can return a 403 during decode and skip all downstream filters, including the router. The router filter initiates the upstream connection and is always last in the decode path.

### Built-in HTTP Filters Used by Istio

| Filter | Envoy Name | Purpose | Istio CRD Mapping |
|--------|-----------|---------|-------------------|
| **Router** | `envoy.filters.http.router` | Routes request to upstream cluster based on RDS. Terminal filter. | VirtualService routes |
| **RBAC** | `envoy.filters.http.rbac` | Evaluates allow/deny rules based on source, path, headers, JWT claims | AuthorizationPolicy |
| **Fault Injection** | `envoy.filters.http.fault` | Injects delays or aborts (HTTP errors) for chaos testing | VirtualService `fault` |
| **ext_authz** | `envoy.filters.http.ext_authz` | Delegates authz decision to external gRPC/HTTP service | AuthorizationPolicy (CUSTOM action) |
| **CORS** | `envoy.filters.http.cors` | Handles CORS preflight and response headers | VirtualService `corsPolicy` |
| **Lua** | `envoy.filters.http.lua` | Inline Lua scripting for custom request/response manipulation | EnvoyFilter |
| **Wasm** | `envoy.filters.http.wasm` | Runs WebAssembly plugins for custom logic | WasmPlugin CRD |
| **Rate Limit** | `envoy.filters.http.ratelimit` | External rate limit service integration | EnvoyFilter (or Istio rate limit API) |
| **Compressor** | `envoy.filters.http.compressor` | Response body compression (gzip, brotli, zstd) | EnvoyFilter |
| **JWT Authentication** | `envoy.filters.http.jwt_authn` | Validates JWT tokens against JWKS endpoints | RequestAuthentication |
| **gRPC Stats** | `envoy.filters.http.grpc_stats` | Emits gRPC-specific metrics (request/response message counts) | Automatic for gRPC traffic |

---

## Connection Pooling

Envoy manages upstream connection pools on a per-cluster, per-worker-thread basis. The pooling behavior differs significantly between HTTP/1.1 and HTTP/2:

```
┌───────────────────────────────────────────────────────────────────┐
│              CONNECTION POOL ARCHITECTURE                           │
│                                                                    │
│  Worker Thread 0                  Worker Thread 1                  │
│  ┌────────────────────────┐      ┌────────────────────────┐      │
│  │  Cluster: reviews:8080  │      │  Cluster: reviews:8080  │      │
│  │                          │      │                          │      │
│  │  HTTP/1.1 pool:          │      │  HTTP/1.1 pool:          │      │
│  │  ┌────┐ ┌────┐ ┌────┐  │      │  ┌────┐ ┌────┐         │      │
│  │  │conn│ │conn│ │conn│  │      │  │conn│ │conn│         │      │
│  │  │ 1  │ │ 2  │ │ 3  │  │      │  │ 1  │ │ 2  │         │      │
│  │  └────┘ └────┘ └────┘  │      │  └────┘ └────┘         │      │
│  │  (1 request per conn)   │      │  (1 request per conn)   │      │
│  │                          │      │                          │      │
│  │  HTTP/2 pool:            │      │  HTTP/2 pool:            │      │
│  │  ┌────────────────────┐ │      │  ┌────────────────────┐ │      │
│  │  │ conn 1             │ │      │  │ conn 1             │ │      │
│  │  │ ├─ stream 1        │ │      │  │ ├─ stream 1        │ │      │
│  │  │ ├─ stream 2        │ │      │  │ ├─ stream 2        │ │      │
│  │  │ ├─ stream 3        │ │      │  │ └─ stream 3        │ │      │
│  │  │ └─ stream 4        │ │      │  └────────────────────┘ │      │
│  │  └────────────────────┘ │      │  (many requests over 1  │      │
│  │  (multiplexed streams)  │      │   connection)            │      │
│  └────────────────────────┘      └────────────────────────┘      │
└───────────────────────────────────────────────────────────────────┘
```

| Protocol | Pooling Behavior | Concurrency |
|----------|-----------------|-------------|
| **HTTP/1.1** | One request at a time per connection. Envoy opens multiple connections to the same endpoint to achieve parallelism. Connections are kept alive and reused for subsequent requests. | Controlled by `maxConnectionsPerEndpoint` (circuit breaker `max_connections`) |
| **HTTP/2** | Multiple concurrent streams (requests) multiplexed over a single TCP connection per worker per endpoint. Envoy typically opens just one connection per worker per upstream host. | Controlled by `max_concurrent_streams` (default 2147483647 -- practically unlimited) and `max_requests` circuit breaker |

Connection pools are **not shared across worker threads**. Each worker independently manages its own pools. This means total connections to a single upstream host equals `connections_per_worker * num_workers`.

**Circuit breaker integration**: Connection pools are bounded by the circuit breaker thresholds configured via DestinationRule's `connectionPool` settings. When thresholds are hit (e.g., `maxConnections`, `maxPendingRequests`, `maxRequestsPerConnection`), Envoy immediately returns a `503` with the flag `UO` (upstream overflow) rather than queueing the request.

---

## Health Checking

Envoy supports two complementary mechanisms for determining endpoint health:

### Active Health Checking

Envoy periodically sends probe requests to each upstream endpoint and marks unhealthy endpoints as unavailable. This is configured per-cluster and operates independently of Kubernetes liveness/readiness probes.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `interval` | Time between health check attempts | 5s (Istio default varies) |
| `timeout` | Time to wait for a health check response | 1s |
| `unhealthy_threshold` | Consecutive failures before marking unhealthy | 2 |
| `healthy_threshold` | Consecutive successes before marking healthy again | 1 |

Health check types: HTTP (send GET to a path, check status code), TCP (attempt connection), gRPC (use grpc.health.v1.Health service).

> **Note:** In Istio, active health checking is **not enabled by default** for sidecar proxies. Istio relies on Kubernetes readiness probes to remove unready pods from Endpoints, which then propagates to Envoy via EDS. Active health checks can be configured via DestinationRule's `outlierDetection` or via EnvoyFilter for advanced cases. The Istio Gateway deployments are more likely to use active health checks.

### Passive Health Checking (Outlier Detection)

Outlier detection monitors real traffic responses and ejects endpoints that show signs of failure -- no extra probe traffic needed. This is configured via `DestinationRule.trafficPolicy.outlierDetection` and maps directly to Envoy's `outlier_detection` cluster config.

```
┌──────────────────────────────────────────────────────────────┐
│                   OUTLIER DETECTION FLOW                       │
│                                                               │
│  Request to upstream endpoint                                 │
│         │                                                     │
│         ▼                                                     │
│  Response received (or connection error / timeout)            │
│         │                                                     │
│         ▼                                                     │
│  Envoy tracks per-endpoint:                                   │
│  - consecutive 5xx count                                      │
│  - consecutive gateway errors (502, 503, 504)                 │
│  - consecutive local-origin failures (connect timeout, reset) │
│  - success rate (over a sliding window)                       │
│         │                                                     │
│         ▼                                                     │
│  Threshold exceeded?                                          │
│    ├── No  → continue routing to this endpoint                │
│    └── Yes → EJECT endpoint for `baseEjectionTime`            │
│              (each subsequent ejection doubles the duration)   │
│              Ejected endpoint receives no traffic              │
│         │                                                     │
│         ▼                                                     │
│  After ejection period: endpoint re-enters the pool           │
│  Next failure → ejected for 2x the base time, etc.           │
│                                                               │
│  Safety valve: maxEjectionPercent (default 10%)               │
│  Never eject more than this % of the cluster at once          │
└──────────────────────────────────────────────────────────────┘
```

```yaml
# DestinationRule with outlier detection
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: reviews-outlier
spec:
  host: reviews.default.svc.cluster.local
  trafficPolicy:
    outlierDetection:
      consecutive5xxErrors: 3        # eject after 3 consecutive 5xx
      interval: 10s                  # check window
      baseEjectionTime: 30s          # first ejection lasts 30s
      maxEjectionPercent: 50         # allow ejecting up to 50% of endpoints
```

**Key difference from Kubernetes probes**: Kubernetes liveness/readiness probes determine whether a pod should be restarted or removed from Service endpoints globally. Envoy outlier detection is **per-proxy** -- one Envoy might eject an endpoint that other Envoys still consider healthy, because the failure might be path-dependent (e.g., network partition between specific nodes).

---

## Access Logging

Envoy access logs record per-request metadata for debugging and auditing. In Istio, access logging is configured globally via MeshConfig or per-workload via the Telemetry API.

**Enabling access logs globally** (via MeshConfig):

```yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
  meshConfig:
    accessLogFile: /dev/stdout            # file-based (logs to container stdout)
    accessLogEncoding: JSON               # TEXT or JSON
    accessLogFormat: ""                    # empty = default format
```

**Default access log format** (TEXT mode):

```
[%START_TIME%] "%REQ(:METHOD)% %REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %PROTOCOL%"
%RESPONSE_CODE% %RESPONSE_FLAGS% %RESPONSE_CODE_DETAILS% %CONNECTION_TERMINATION_DETAILS%
"%UPSTREAM_TRANSPORT_FAILURE_REASON%" %BYTES_RECEIVED% %BYTES_SENT%
%DURATION% %RESP(X-ENVOY-UPSTREAM-SERVICE-TIME)%
"%REQ(X-FORWARDED-FOR)%" "%REQ(USER-AGENT)%"
"%REQ(X-REQUEST-ID)%" "%REQ(:AUTHORITY)%" "%UPSTREAM_HOST%"
%UPSTREAM_CLUSTER% %UPSTREAM_LOCAL_ADDRESS% %DOWNSTREAM_LOCAL_ADDRESS%
%DOWNSTREAM_REMOTE_ADDRESS% %REQUESTED_SERVER_NAME% %ROUTE_NAME%
```

Key response flags to watch for in logs:

| Flag | Meaning |
|------|---------|
| `UH` | No healthy upstream hosts |
| `UF` | Upstream connection failure |
| `UO` | Upstream overflow (circuit breaker tripped) |
| `NR` | No route configured |
| `URX` | Upstream retry limit exceeded |
| `DC` | Downstream connection termination |
| `RL` | Rate limited |
| `UAEX` | Unauthorized (ext_authz denied) |
| `RLSE` | Rate limit service error |

**gRPC Access Log Service (ALS)**: Instead of (or in addition to) file-based logging, Envoy can stream access logs to a remote gRPC service. This enables centralized log collection without relying on a sidecar log shipper:

```
Envoy → gRPC stream → Access Log Service (ALS) → Storage backend
                        (e.g., OpenTelemetry       (Elasticsearch,
                         Collector, custom)          BigQuery, etc.)
```

Configure via MeshConfig:

```yaml
meshConfig:
  accessLogFile: ""                     # disable file logging
  defaultConfig:
    envoyAccessLogService:
      address: als-collector.istio-system:9090
```

---

## See also

- [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]] -- control plane, xDS, sidecar injection, iptables, request lifecycle
- [[notes/Networking/istio-traffic-management|Istio Traffic Management]] -- VirtualService, DestinationRule, Gateway API
- [[notes/Networking/istio-security|Istio Security]] -- mTLS, AuthorizationPolicy, RequestAuthentication, ext_authz
- [[notes/Networking/istio-observability-extensibility|Istio Observability & Extensibility]] -- metrics, tracing, WasmPlugin, EnvoyFilter
- [Envoy Threading Model (official docs)](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/intro/threading_model)
- [Envoy Hot Restart (official docs)](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/operations/hot_restart)
- [Envoy HTTP Filter Chain (official docs)](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/http/http_filters)
- [Envoy Connection Pooling](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/connection_pooling)
- [Envoy Outlier Detection](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier)
- [Envoy Listener Architecture](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/listeners/listeners)

---

## Interview Prep

### Q: What is the difference between Istio and Envoy?

**A:** Envoy is a standalone, high-performance L4/L7 proxy written in C++ by Lyft. It handles the actual data plane work: accepting connections, load balancing, applying retries/timeouts, terminating TLS, and collecting metrics. Envoy has no opinion about how it gets configured -- it exposes the xDS API for dynamic configuration.

Istio is the control plane that manages a fleet of Envoy proxies. It watches Kubernetes resources (Services, Endpoints, VirtualService, DestinationRule, PeerAuthentication), translates them into Envoy-native configuration, and pushes that configuration to every sidecar proxy via xDS. Istio also acts as a Certificate Authority, issuing SPIFFE X.509 certificates to each proxy for mTLS.

The `istio-proxy` container in each pod contains the Envoy binary plus `pilot-agent`, a helper process that generates Envoy's bootstrap config, manages its lifecycle, fetches certificates from istiod, and serves them to Envoy via the local SDS API.

---

### Q: Explain Envoy's threading model. Why doesn't it use a thread-per-connection approach?

**A:** Envoy uses a multi-threaded, non-blocking event-loop architecture:

```
                    ┌────────────────┐
                    │  Main Thread   │
                    │  - xDS updates │
                    │  - Admin API   │
                    │  - Stats flush │
                    └───────┬────────┘
                            │ RCU (thread-local snapshots)
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Worker 0 │ │ Worker 1 │ │ Worker N │
        │ (event   │ │ (event   │ │ (event   │
        │  loop)   │ │  loop)   │ │  loop)   │
        │          │ │          │ │          │
        │ owns:    │ │ owns:    │ │ owns:    │
        │ - conns  │ │ - conns  │ │ - conns  │
        │ - pools  │ │ - pools  │ │ - pools  │
        └──────────┘ └──────────┘ └──────────┘
```

The **main thread** handles control plane operations (xDS updates, admin API, stats flushing) but never touches data-plane traffic. **Worker threads** each run an independent libevent event loop and own their connections for the entire connection lifetime. The kernel distributes incoming connections across workers using `SO_REUSEPORT`.

A thread-per-connection model would waste memory on idle connections and suffer from context-switching overhead at high connection counts. Envoy's event-loop model can handle thousands of concurrent connections per worker thread because all I/O is non-blocking. Configuration updates flow from the main thread to workers via a read-copy-update (RCU) mechanism using thread-local storage -- workers hold read-only config snapshots and never contend on shared mutable state.

---

### Q: How does Envoy's hot restart work? Why is it needed?

**A:** Hot restart enables zero-downtime Envoy binary upgrades. The sequence:

1. `pilot-agent` starts a new Envoy process with an incremented restart epoch.
2. The new process connects to the old process via a Unix domain socket.
3. The old process transfers its listener sockets using `SCM_RIGHTS` (Unix file descriptor passing).
4. Both processes share a shared-memory region for stats counters (so counters persist across restarts).
5. The old process enters drain mode -- stops accepting new connections but finishes in-flight requests.
6. After the drain period (default 600s in Istio), the old process exits.

In practice, hot restart is rarely triggered in Istio sidecar mode because xDS delivers config changes dynamically without restarts. It is more relevant for Envoy binary upgrades or crash recovery by `pilot-agent`.

---

### Q: What are the three types of Envoy filters? In what order do HTTP filters execute on requests vs responses?

**A:** The three filter tiers:

1. **Listener filters** (L3/L4, pre-connection): Run before filter chain selection. Inspect raw connection bytes. Examples: `tls_inspector` (reads SNI from ClientHello), `http_inspector` (sniffs for HTTP).
2. **Network filters** (L4, connection-level): Operate on TCP byte streams after filter chain selection. Must end with a terminal filter like `tcp_proxy` or `http_connection_manager`.
3. **HTTP filters** (L7, request/response): Operate on parsed HTTP. Only active when `http_connection_manager` is the network filter.

HTTP filter execution order:

```
  Request (decode):   filter_1 → filter_2 → ... → router (terminal)
  Response (encode):  router → ... → filter_2 → filter_1 (REVERSED)
```

On the decode path, filters execute in chain order. On the encode path, they execute in **reverse**. Any filter can short-circuit the chain -- for example, the RBAC filter returning 403 stops decode processing and the response goes back through the encode path.

---

### Q: How does outlier detection (passive health checking) differ from active health checking and Kubernetes readiness probes?

**A:**

| Aspect | Active Health Check | Outlier Detection | K8s Readiness Probe |
|--------|-------------------|-------------------|-------------------|
| **Mechanism** | Envoy sends periodic probe requests | Envoy monitors real traffic responses | kubelet sends periodic probes |
| **Scope** | Per-proxy decision | Per-proxy decision | Global (affects Endpoints for all consumers) |
| **Extra traffic** | Yes (synthetic probes) | No (uses real requests) | Yes (synthetic probes) |
| **Reaction time** | Depends on interval | Immediate (on Nth failure) | Depends on interval + failure threshold |
| **Recovery** | Automatic after healthy threshold | Automatic after ejection time expires | Automatic after success threshold |
| **Granularity** | Per-endpoint | Per-endpoint | Per-pod |

The key difference: Kubernetes readiness probes remove a pod from the global Service Endpoints (affecting all consumers), while outlier detection is **local to each Envoy proxy** -- one proxy may eject an endpoint while another still considers it healthy. This can happen when failures are path-dependent (e.g., network issues between specific nodes).

In Istio, active health checking is not enabled by default. The primary health signal comes from Kubernetes readiness probes (propagated via EDS), supplemented by outlier detection configured through DestinationRule.
