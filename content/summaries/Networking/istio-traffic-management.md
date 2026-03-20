---
title: "Summary: Istio Traffic Management"
---

> **Full notes:** [[notes/Networking/istio-traffic-management|Istio Traffic Management: VirtualService, DestinationRule, Gateway API, Service Entries, and Network Resilience -->]]

## Key Concepts

### Overview and CRD-to-Envoy Mapping

Istio's traffic management is built on custom resources that istiod watches, translates into Envoy-native xDS configuration, and pushes to every sidecar via gRPC streams. Each CRD maps to a specific Envoy discovery service: VirtualService to RDS (routes), DestinationRule to CDS (clusters), Gateway to LDS (listeners), ServiceEntry to CDS+EDS (external hosts), and Sidecar to scope restrictions on LDS+CDS. Kubernetes Services and Endpoints feed EDS for pod IP lists.

### Sidecar Traffic Interception: istio-init and iptables

Istio intercepts all pod traffic by injecting an init container (`istio-init`) that installs iptables REDIRECT rules in the pod's network namespace (not the node's). These rules persist after the init container exits because they belong to the namespace. Outbound traffic is redirected to Envoy on port 15001 via the OUTPUT chain; inbound traffic is redirected to port 15006 via PREROUTING. Envoy's own traffic (UID 1337) hits a RETURN rule to avoid infinite loops. An alternative is the Istio CNI plugin, which removes the need for `NET_ADMIN` capability.

```
Inbound:  external → PREROUTING → REDIRECT :15006 → Envoy → loopback to app :8080
Outbound: app → OUTPUT → REDIRECT :15001 → Envoy → OUTPUT (UID 1337 RETURN) → wire
```

Locally generated packets (Envoy to app via loopback) enter at OUTPUT, never PREROUTING -- this is fundamental netfilter design. Envoy recovers the original destination via `SO_ORIGINAL_DST`.

### VirtualService (Envoy RDS)

A VirtualService defines how requests to a hostname are routed to backends, decoupling the client-addressed destination from the actual workload. The `hosts` field matches via the Host header (HTTP) or SNI (TLS) and supports short names, FQDNs, wildcards, and IPs. Routes are evaluated top-to-bottom (first match wins). Within a single match block, conditions are ANDed; multiple match blocks within one rule are ORed.

```
Evaluates as: (header=jason AND uri=/api*) OR (header=admin)
```

Match fields include `uri`, `headers`, `queryParams`, `method`, `port`, `sourceLabels`, `sourceNamespace`, and `gateways`. Always include a default catch-all route as the last rule -- without it, unmatched requests get 404. Once a VirtualService claims a host, it takes full ownership; there is no fallback to Kubernetes default routing.

### DestinationRule (Envoy CDS)

DestinationRules define how traffic reaches a destination after routing -- they configure the Envoy cluster. Applied after VirtualService routing decisions. Subsets partition endpoints by label selector (typically `version`), each becoming a separate Envoy cluster with its own endpoint list via EDS. Subset-level traffic policies override top-level policies.

| Algorithm | Envoy Policy | Behavior |
|---|---|---|
| `LEAST_REQUEST` (default) | `LEAST_REQUEST` | Power-of-two random choices |
| `ROUND_ROBIN` | `ROUND_ROBIN` | Sequential rotation |
| `RANDOM` | `RANDOM` | Uniform random |
| `PASSTHROUGH` | `CLUSTER_PROVIDED` | Direct to caller-specified address |

Consistent hash LB enables session affinity using HTTP header, cookie, source IP, or query parameter. Maps to Envoy's ring hash or Maglev algorithm.

### Traffic Splitting, Retries, Timeouts, Circuit Breaking Mapping

```
VirtualService → Envoy:                  DestinationRule → Envoy:
  route[].weight → weighted_clusters       connectionPool → circuit_breakers
  retries        → retry_policy            outlierDetection → outlier_detection
  timeout        → route timeout           loadBalancer → lb_policy
  fault          → fault injection filter  tls → transport_socket
  mirror         → request_mirror_policy   subsets[] → separate cluster per subset
```

### Ingress: Istio Gateway CRD (Legacy)

The Istio `Gateway` resource configures a standalone Envoy proxy (`istio-ingressgateway`) at the mesh edge with ports, protocols, and TLS settings. A VirtualService binds to the Gateway by name for routing. This translates to an LDS listener with TLS via SDS and an RDS route config for virtual hosts. Key limitation: Gateway and VirtualService reference each other by name with no ownership relationship, and role separation between infra admin and app developer is weak.

### Kubernetes Gateway API (Recommended)

The Kubernetes Gateway API (`gateway.networking.k8s.io`) is the recommended approach (Istio 1.22+ GA). It introduces a clean role-based model: **GatewayClass** (infra provider, defines controller), **Gateway** (cluster operator, configures listeners/TLS/allowed routes), and **HTTPRoute/GRPCRoute/TCPRoute** (app developer, defines routing rules and backends). ReferenceGrant controls cross-namespace references.

When a Gateway resource references `istio.io/gateway-controller`, Istio automatically provisions an Envoy Deployment, Service, and ServiceAccount -- delete the Gateway and everything is cleaned up. This is a major improvement over the legacy CRD's manual deployment.

| Aspect | Istio Gateway CRD | K8s Gateway API |
|---|---|---|
| Provisioning | Manual | Automatic |
| Role separation | Weak | Strong (3-tier) |
| Cross-namespace | Implicit | Explicit (allowedRoutes + ReferenceGrant) |
| Status reporting | Limited | Rich (conditions per parent) |
| Portability | Istio-only | Multi-implementation |

In Ambient mode, waypoint proxies are also managed via Gateway API using `gatewayClassName: istio-waypoint`, unifying ingress and mesh-internal L7 proxies under one API.

### ServiceEntry: External Services in the Mesh

Without a ServiceEntry, external traffic goes through Envoy's passthrough cluster with no retries, timeouts, circuit breaking, or metrics. A ServiceEntry registers an external service into Istio's registry so the full traffic management stack applies. `location` can be `MESH_EXTERNAL` (no outbound mTLS) or `MESH_INTERNAL` (treated as mesh service). `resolution` can be `DNS`, `STATIC` (explicit IPs), or `NONE` (forward to caller's original IP). Once registered, VirtualService and DestinationRule can attach to the ServiceEntry host.

### Sidecar Resource: Limiting Proxy Scope

By default, every Envoy sidecar holds routes and clusters for every service in the mesh, consuming significant memory and increasing xDS push times. The Sidecar resource restricts which services a proxy can reach (egress) and which ports it accepts (ingress). Uses `namespace/host` format (`.` = own namespace). Only one namespace-wide Sidecar per namespace is allowed; workload-scoped Sidecars override it. Best practice: define a namespace-wide Sidecar restricting egress to only services that namespace actually calls for 10x+ memory reduction.

### Egress Gateways

A dedicated Envoy proxy at the mesh edge for outbound traffic. Provides centralized monitoring, security policy enforcement, TLS origination, and a single exit point for auditing. Configuration requires a ServiceEntry, an egress Gateway resource, and a VirtualService with `gateways: [mesh, egress-gateway]` to route sidecar traffic through the egress gateway and then to the external destination.

### Network Resilience

**Timeouts:** Default is no timeout (disabled). When set, Envoy returns 504 if upstream doesn't respond. Covers the entire request including retries. Coordinate with application-level timeouts -- the shorter one wins.

**Retries:** `attempts` = total calls including the first (not retries after first). `attempts: 3` maps to `num_retries: 2` in Envoy. Default: 2 attempts with `connect-failure,refused-stream,unavailable,cancelled,retriable-status-codes`. Retries use 25ms+ base interval with jitter.

**Circuit Breaking (DestinationRule):** Caps concurrent connections (`maxConnections`), pending requests (`http1MaxPendingRequests`), HTTP/2 requests (`http2MaxRequests`), and retries (`maxRetries`). When exceeded, Envoy returns 503 with response flag `UO` immediately.

**Outlier Detection (DestinationRule):** Removes unhealthy individual endpoints from the LB pool based on observed errors (`consecutive5xxErrors`). Ejected for `baseEjectionTime` with exponential backoff on repeat. `maxEjectionPercent` caps total ejections. Circuit breaking protects upstream from overload; outlier detection protects the caller from bad endpoints.

**Fault Injection:** Injects delays or HTTP errors at L7 before the request reaches upstream. Tests calling service's handling of slow/failed dependencies. Can interact unexpectedly with retry/timeout config on the same route.

## Quick Reference

```
CRD                  -> Envoy Concept
----------------------------------------------
VirtualService       -> RDS (routes, weights, retries, timeouts)
DestinationRule      -> CDS (clusters, LB, circuit breakers, subsets)
Gateway / HTTPRoute  -> LDS (listeners, TLS)
ServiceEntry         -> CDS + EDS (external hosts)
Sidecar              -> LDS + CDS scope restriction
```

| Resilience Feature | Configured In | Scope | On Exceed |
|---|---|---|---|
| Timeout | VirtualService | Entire request | 504 |
| Retries | VirtualService | Per-attempt + total | Retry or give up |
| Circuit Breaking | DestinationRule | Entire cluster | 503 (UO flag) |
| Outlier Detection | DestinationRule | Individual endpoint | Eject from pool |
| Fault Injection | VirtualService | Before forwarding | Delay or abort |

```
┌── perTryTimeout: 3s ──┐  ┌── perTryTimeout: 3s ──┐  ┌── 3s ──┐
│    Attempt 1           │  │    Attempt 2 (retry)   │  │  Att 3  │
└────────────────────────┘  └────────────────────────┘  └─────────┘
|← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  timeout: 10s  ─ ─ ─ ─ ─ ─ ─ ─ ─ →|
```

## Key Takeaways

- VirtualService owns a host's routing completely -- no fallback to K8s default if no match exists (you get 404).
- `attempts: 3` means 3 total calls (1 original + 2 retries), not 3 retries after the first.
- Circuit breaking (connectionPool) protects the upstream from overload; outlier detection (outlierDetection) protects the caller from bad endpoints. They complement each other.
- Use the Kubernetes Gateway API for new deployments -- it auto-provisions Envoy and cleanly separates infra/platform/app roles. The Istio Gateway CRD is not deprecated but all new docs default to Gateway API.
- In large meshes, define a Sidecar resource per namespace to restrict egress scope and reduce proxy memory 10x+.
- Egress gateways centralize outbound traffic for auditing, TLS origination, and security policy enforcement.
- iptables interception uses PREROUTING for inbound, OUTPUT for outbound. UID 1337 RETURN prevents Envoy loops. Locally generated loopback packets never hit PREROUTING.
- ServiceEntry enables full Istio traffic management (retries, timeouts, metrics) for external services that would otherwise use the passthrough cluster.
- Fault injection happens before the upstream, testing the caller's resilience. Watch for interactions with timeout/retry on the same route.
