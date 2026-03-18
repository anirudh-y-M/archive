---
title: "Istio Traffic Management: VirtualService, DestinationRule, Gateway API, Service Entries, and Network Resilience"
---

## Overview

Istio's traffic management is built on custom resources that map directly to Envoy configuration. The control plane (**istiod**) watches these CRDs, translates them into Envoy-native xDS configuration, and pushes updates to every sidecar proxy in the mesh via gRPC streams.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    ISTIO TRAFFIC MANAGEMENT STACK                         │
│                                                                          │
│  User defines CRDs              istiod translates          Envoy applies │
│  ──────────────────              ──────────────────         ───────────── │
│                                                                          │
│  VirtualService  ─────────►  RDS (Route Discovery)  ────►  Route rules   │
│  DestinationRule ─────────►  CDS (Cluster Discovery)────►  LB / CB / OD  │
│  Gateway         ─────────►  LDS (Listener Discovery)──►  Listeners      │
│  ServiceEntry    ─────────►  CDS + EDS              ────►  External hosts │
│  Sidecar         ─────────►  LDS + CDS scope        ────►  Proxy config  │
│                                                                          │
│  K8s Services    ─────────►  EDS (Endpoint Discovery)──►  Pod IPs        │
│  K8s Endpoints   ─────────►                                              │
└──────────────────────────────────────────────────────────────────────────┘
```

For the Istio control plane architecture, xDS protocol, and request lifecycle, see [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]]. For Envoy internals (filter chains, connection pooling), see [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]].

---

## Sidecar Traffic Interception: istio-init and iptables

Istio intercepts all pod traffic by injecting an **init container** (`istio-init`) that sets up iptables REDIRECT rules in the **pod's network namespace** (not the node's). These rules redirect traffic to the Envoy sidecar before it reaches the app or leaves the pod.

### Where the iptables rules live

iptables rules are **per network namespace**. Each pod gets its own namespace, its own rules. The node's root namespace (kube-proxy rules) is untouched.

### istio-init lifecycle

`istio-init` is a Kubernetes init container — runs once, installs iptables rules, exits. The rules persist in the namespace after the container dies (rules belong to the namespace, not the process). Requires `NET_ADMIN` capability. Alternative: **Istio CNI plugin** does this at the CNI level, removing the `NET_ADMIN` requirement.

### Core iptables rules

```
# Inbound: external traffic → redirect to Envoy inbound listener
-A PREROUTING -p tcp --dport <app-port> -j REDIRECT --to-port 15006

# Outbound: app traffic → redirect to Envoy outbound listener
-A OUTPUT -p tcp -j REDIRECT --to-port 15001

# Prevent infinite loop: Envoy (UID 1337) traffic skips redirect
-A OUTPUT -m owner --uid-owner 1337 -j RETURN
```

### Traffic flow through netfilter chains

The Linux kernel has one netfilter pipeline per network namespace. Which chain a packet hits depends on its **origin**, not the interface:

```
                     INCOMING (from outside pod)          LOCALLY GENERATED (by a process)
                            │                                        │
                            ▼                                        │
                       PREROUTING                                    │
                            │                                        │
                            ▼                                        │
                     routing decision  ◄──────────────────────  OUTPUT
                      ╱           ╲                                  ▲
                     ╱             ╲                                  │
               for this         forward to                    local process
               host?            another host?                 generates packet
                 │                    │
                 ▼                    ▼
              INPUT              FORWARD
                 │                    │
                 ▼                    ▼
           local process        POSTROUTING → out
```

> **Key insight:** Locally generated packets (e.g., Envoy → `127.0.0.1:8080`) enter at OUTPUT, **never PREROUTING**. PREROUTING only hooks packets arriving from a network interface. This is fundamental netfilter design, not a special case. ([ref: nftables wiki — Netfilter hooks](https://wiki.nftables.org/wiki-nftables/index.php/Netfilter_hooks))

### Outbound: App → External Service

```
App sends to 10.0.5.3:443
  → OUTPUT chain → matches REDIRECT rule → rewritten to 127.0.0.1:15001
  → Envoy receives on :15001, recovers original dst via SO_ORIGINAL_DST
  → Envoy applies routing/mTLS/retries, opens new connection to 10.0.5.3:443
  → OUTPUT chain again → UID=1337 → RETURN (skip redirect)
  → packet leaves pod via eth0 → CNI → destination
```

### Inbound: External → App

```
Traffic arrives at pod:8080
  → PREROUTING chain → REDIRECT to 127.0.0.1:15006
  → Envoy receives on :15006, applies mTLS termination/authz/telemetry
  → Envoy forwards to 127.0.0.1:8080
  → OUTPUT chain → UID=1337 → RETURN (skip redirect)
  → app receives on :8080 (no PREROUTING — it's locally generated loopback)
```

### Why Envoy → app loopback isn't re-intercepted

Envoy's packet to `127.0.0.1:8080` is **locally generated** — it goes through OUTPUT (where UID 1337 matches RETURN), not PREROUTING. Loopback delivery follows: `OUTPUT → routing → POSTROUTING → INPUT → app`. PREROUTING is never involved because the packet never enters from an external interface.

---

## VirtualService -> Envoy Route Configuration (RDS)

A VirtualService defines **how requests to a hostname are routed** to actual service backends. It decouples the destination the client addresses from the actual workload that handles the request, enabling canary deployments, A/B testing, and header-based routing without changing application code.

### Hosts Field

The `hosts` field specifies which destination hostnames this VirtualService applies to. These can be:
- Kubernetes short names (`reviews`) -- resolved to `reviews.{namespace}.svc.cluster.local`
- FQDNs (`reviews.default.svc.cluster.local`)
- Wildcard prefixes (`*.example.com`) -- matches any subdomain
- IP addresses (for TCP routing)

A request's `Host` header (HTTP) or SNI (TLS) is matched against these values.

### Match Conditions: AND vs OR Logic

Routing rules are evaluated **top-to-bottom** -- the first match wins. Within a single rule, match conditions follow specific AND/OR semantics:

```
┌───────────────────────────────────────────────────────┐
│          MATCH CONDITION LOGIC                          │
│                                                        │
│  http:                                                 │
│  - match:                                              │
│    - headers:          ┐                               │
│        end-user:       │  All conditions within        │
│          exact: jason  ├─ a SINGLE match block         │
│      uri:              │  are ANDed together           │
│        prefix: /api    ┘                               │
│    - headers:          ┐                               │
│        end-user:       ├─ Multiple match blocks        │
│          exact: admin  ┘  are ORed                     │
│    route: ...                                          │
│                                                        │
│  Evaluates as:                                         │
│  (header=jason AND uri=/api*) OR (header=admin)        │
└───────────────────────────────────────────────────────┘
```

Match fields available: `uri` (exact/prefix/regex), `headers`, `queryParams`, `method`, `port`, `sourceLabels`, `sourceNamespace`, `gateways`.

### Full Example with Envoy Translation

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: reviews-route
spec:
  hosts:
  - reviews                           # ← Envoy virtual host match
  http:
  - match:
    - headers:
        end-user:
          exact: jason                # ← Route match condition
    route:
    - destination:
        host: reviews                 # ← Envoy cluster
        subset: v2                    # ← From DestinationRule
      weight: 100
  - route:                            # ← Default route (no match = catch-all)
    - destination:
        host: reviews
        subset: v1
      weight: 90
    - destination:
        host: reviews
        subset: v3
      weight: 10
    retries:
      attempts: 3                     # ← Envoy retry policy
      perTryTimeout: 2s
    timeout: 10s                      # ← Envoy route timeout
```

This translates to Envoy config:

```
Envoy Route Configuration (RDS):
  virtual_host: "reviews.default.svc.cluster.local:8080"
    routes:
      - match: { headers: [{ name: "end-user", exact_match: "jason" }] }
        route: { cluster: "outbound|8080|v2|reviews.default.svc.cluster.local" }
      - match: { prefix: "/" }
        route:
          weighted_clusters:
            clusters:
              - { name: "outbound|8080|v1|reviews.default...", weight: 90 }
              - { name: "outbound|8080|v3|reviews.default...", weight: 10 }
          retry_policy: { num_retries: 3, per_try_timeout: "2s" }
          timeout: "10s"
```

> **Gotcha:** Always include a default route (no `match` condition) as the last rule. Without it, requests that don't match any condition get a 404 from Envoy. Istio does NOT fall back to Kubernetes default routing when a VirtualService exists for a host -- the VirtualService takes full ownership of that host's routing.

---

## DestinationRule -> Envoy Cluster Configuration (CDS)

DestinationRules define **how traffic reaches a destination** after routing. They configure the Envoy cluster: load balancing algorithm, connection pool limits, circuit breaker thresholds, outlier detection (passive health checking), TLS settings, and service subsets.

DestinationRules apply **after** VirtualService routing decisions. A VirtualService says "send to cluster X, subset Y" -- the DestinationRule says "here's how to talk to subset Y."

### Subsets

Subsets partition a service's endpoints by label selector (typically `version`). Each subset becomes a separate Envoy cluster with its own endpoint list (via EDS). Subset-level traffic policies override the top-level `trafficPolicy`.

### Load Balancing Algorithms

| Algorithm | Envoy `lb_policy` | Behavior |
|-----------|-------------------|----------|
| `LEAST_REQUEST` | `LEAST_REQUEST` | **Default.** Picks two random endpoints, sends to the one with fewer active requests. Good general-purpose choice. |
| `ROUND_ROBIN` | `ROUND_ROBIN` | Sequential rotation through endpoints. Simple, predictable. |
| `RANDOM` | `RANDOM` | Uniform random selection. Performs well under high concurrency. |
| `PASSTHROUGH` | `CLUSTER_PROVIDED` | Sends to the caller-specified address directly. Used for ServiceEntry with static IPs. |

**Consistent hash** load balancing enables session affinity -- the same client always reaches the same endpoint (until endpoint membership changes):

```yaml
trafficPolicy:
  loadBalancer:
    consistentHashLB:
      httpHeaderName: x-user-id     # hash by header value
      # OR: httpCookie, useSourceIp, httpQueryParameterName
      minimumRingSize: 1024
```

Hash key options: HTTP header, HTTP cookie (Envoy generates a cookie if missing), source IP, or query parameter. Under the hood, this maps to Envoy's **ring hash** or **Maglev** algorithm.

### Full Example

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: reviews-destination
spec:
  host: reviews
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100           # ← Envoy circuit breaker
      http:
        h2UpgradePolicy: DEFAULT
        maxRequestsPerConnection: 1
    outlierDetection:                 # ← Envoy outlier detection
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
    loadBalancer:
      simple: ROUND_ROBIN            # ← Envoy LB policy
  subsets:
  - name: v1
    labels:
      version: v1
  - name: v2
    labels:
      version: v2
  - name: v3
    labels:
      version: v3
```

This creates three Envoy clusters:

```
Cluster: "outbound|8080|v1|reviews.default.svc.cluster.local"
  - lb_policy: ROUND_ROBIN
  - circuit_breakers: { max_connections: 100 }
  - outlier_detection: { consecutive_5xx: 5, interval: 30s }
  - endpoints (from EDS): [pods with label version=v1]

Cluster: "outbound|8080|v2|reviews.default.svc.cluster.local"
  - (same policies)
  - endpoints: [pods with label version=v2]

Cluster: "outbound|8080|v3|reviews.default.svc.cluster.local"
  - (same policies)
  - endpoints: [pods with label version=v3]
```

---

## Traffic Splitting, Retries, Timeouts, Circuit Breaking

```
┌───────────────────────────────────────────────────────────────────┐
│                    How They Map to Envoy                          │
│                                                                   │
│  VirtualService                     Envoy Concept                 │
│  ─────────────                     ──────────────                 │
│  http[].route[].weight          →  weighted_clusters              │
│  http[].retries                 →  retry_policy on route          │
│  http[].timeout                 →  timeout on route               │
│  http[].fault                   →  fault injection filter         │
│  http[].mirror                  →  request_mirror_policy          │
│                                                                   │
│  DestinationRule                   Envoy Concept                  │
│  ───────────────                   ──────────────                 │
│  trafficPolicy.connectionPool   →  circuit_breakers thresholds    │
│  trafficPolicy.outlierDetection →  outlier_detection              │
│  trafficPolicy.loadBalancer     →  lb_policy on cluster           │
│  trafficPolicy.tls              →  transport_socket (upstream TLS)│
│  subsets[]                      →  separate cluster per subset    │
└───────────────────────────────────────────────────────────────────┘
```

---

## Ingress: Istio Gateway and Kubernetes Gateway API

North-south traffic (from external clients into the mesh) requires a dedicated ingress point. Istio has historically used its own `Gateway` CRD, and now fully supports the **Kubernetes Gateway API** as the recommended approach.

### Istio Gateway CRD (Legacy / `networking.istio.io`)

The Istio `Gateway` resource configures an Envoy proxy deployed as a standalone `Deployment + Service` (typically `istio-ingressgateway`) at the edge of the mesh. It defines which ports, protocols, and TLS settings the gateway should expose. A `VirtualService` is then bound to the `Gateway` to define routing rules.

```
                                    ┌──────────────────────────────────────┐
   External                         │            K8s Cluster               │
   Client                           │                                      │
     │                               │  ┌─────────────────────┐            │
     │  HTTPS :443                   │  │ istio-ingressgateway │            │
     ├──────────────────────────────►│  │   (Envoy proxy)      │            │
     │                               │  │                      │            │
     │                               │  │  Gateway: ports,     │            │
     │                               │  │    TLS termination   │            │
     │                               │  │  VirtualService:     │            │
     │                               │  │    route to backends │            │
     │                               │  └──────────┬───────────┘            │
     │                               │             │                        │
     │                               │     ┌───────┴────────┐              │
     │                               │     ▼                ▼              │
     │                               │  ┌──────┐        ┌──────┐          │
     │                               │  │Pod A │        │Pod B │          │
     │                               │  │+proxy│        │+proxy│          │
     │                               │  └──────┘        └──────┘          │
     │                               └──────────────────────────────────────┘
```

```yaml
# 1. Gateway: configures the ingress listener
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: my-gateway
spec:
  selector:
    istio: ingressgateway          # ← selects the gateway deployment
  servers:
  - port:
      number: 443
      name: https
      protocol: HTTPS
    tls:
      mode: SIMPLE                 # ← TLS termination at the gateway
      credentialName: my-tls-cert  # ← K8s Secret with cert/key
    hosts:
    - "api.example.com"            # ← SNI / Host match

# 2. VirtualService: binds to the Gateway for routing
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: api-routes
spec:
  hosts:
  - "api.example.com"
  gateways:
  - my-gateway                     # ← binds to the Gateway above
  http:
  - match:
    - uri:
        prefix: /v1
    route:
    - destination:
        host: api-v1
        port:
          number: 8080
  - match:
    - uri:
        prefix: /v2
    route:
    - destination:
        host: api-v2
        port:
          number: 8080
```

This translates to Envoy config on the `istio-ingressgateway` pod:

```
LDS: listener on 0.0.0.0:443
  → filter_chain:
      transport_socket: TLS (cert from SDS, credentialName: "my-tls-cert")
      filters:
        → http_connection_manager
            → RDS route_config:
                virtual_host: "api.example.com"
                  routes:
                    - match: { prefix: "/v1" }
                      route: { cluster: "outbound|8080||api-v1.default.svc.cluster.local" }
                    - match: { prefix: "/v2" }
                      route: { cluster: "outbound|8080||api-v2.default.svc.cluster.local" }
```

**Key limitation of the Istio Gateway CRD**: The `Gateway` and `VirtualService` are separate resources that reference each other by name. There is no ownership relationship -- a misconfigured VirtualService can silently fail to bind. The role of infrastructure admin (who manages the gateway) and application developer (who manages routes) are not clearly separated.

### Kubernetes Gateway API (Current Standard)

The **Kubernetes Gateway API** (`gateway.networking.k8s.io`) is a SIG-Network project that provides a standard, portable API for ingress across mesh implementations. Istio adopted it as the **recommended API** starting from Istio 1.16 and it reached GA in Istio 1.22+. It replaces both the Istio `Gateway` CRD and `Ingress` resource.

The Gateway API introduces a clean role-based resource model:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     KUBERNETES GATEWAY API RESOURCE MODEL                    │
│                                                                             │
│   Infrastructure Provider         Cluster Operator          App Developer   │
│   ────────────────────           ───────────────           ──────────────   │
│                                                                             │
│   ┌──────────────────┐          ┌──────────────┐         ┌──────────────┐  │
│   │   GatewayClass    │◄─────── │   Gateway      │◄────── │  HTTPRoute    │  │
│   │                    │  refs   │                │  refs  │  (or GRPCRoute│  │
│   │  - controller name │         │  - listeners   │        │   TCPRoute,   │  │
│   │    (istio.io/      │         │  - ports, TLS  │        │   TLSRoute)   │  │
│   │     gateway-       │         │  - addresses   │        │               │  │
│   │     controller)    │         │  - allowed     │        │  - hostnames  │  │
│   │                    │         │    routes       │        │  - rules      │  │
│   └──────────────────┘          └──────────────┘         │  - backends   │  │
│                                                           └──────────────┘  │
│                                                                             │
│   "Who provides the     "Which ports/protocols     "Where does traffic     │
│    infrastructure?"      does this gateway expose?"  for my app go?"        │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Resource | Who Manages | Purpose | Analogous Istio CRD |
|----------|-------------|---------|---------------------|
| **GatewayClass** | Infrastructure provider | Defines the controller implementation (e.g. `istio.io/gateway-controller`) | N/A (implicit) |
| **Gateway** | Cluster operator / platform team | Configures listeners (ports, TLS, allowed routes) | `Gateway` (networking.istio.io) |
| **HTTPRoute** | Application developer | Defines routing rules, backends, filters | `VirtualService` |
| **GRPCRoute** | Application developer | gRPC-specific routing rules | `VirtualService` (with gRPC match) |
| **TCPRoute / TLSRoute** | Application developer | L4 routing | `VirtualService` (with TCP/TLS match) |
| **ReferenceGrant** | Namespace owner | Allows cross-namespace references | N/A |

```yaml
# 1. GatewayClass -- typically created once by the platform team
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: istio
spec:
  controllerName: istio.io/gateway-controller

# 2. Gateway -- creates an Envoy deployment + service automatically
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: my-gateway
  namespace: istio-ingress
spec:
  gatewayClassName: istio           # ← references the GatewayClass
  listeners:
  - name: https
    port: 443
    protocol: HTTPS
    hostname: "api.example.com"
    tls:
      mode: Terminate
      certificateRefs:
      - kind: Secret
        name: api-tls-cert
    allowedRoutes:
      namespaces:
        from: Selector              # ← only specific namespaces can attach
        selector:
          matchLabels:
            shared-gateway: "true"

# 3. HTTPRoute -- created by app developers in their own namespace
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-routes
  namespace: my-app                 # ← different namespace from Gateway
spec:
  parentRefs:
  - name: my-gateway
    namespace: istio-ingress        # ← attaches to the Gateway
  hostnames:
  - "api.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /v1
    backendRefs:
    - name: api-v1
      port: 8080
      weight: 90
    - name: api-v2
      port: 8080
      weight: 10                    # ← traffic splitting built in
  - matches:
    - path:
        type: PathPrefix
        value: /healthz
    filters:
    - type: RequestHeaderModifier   # ← header manipulation
      requestHeaderModifier:
        add:
        - name: X-Health-Check
          value: "true"
    backendRefs:
    - name: health-svc
      port: 8080
```

**How Istio implements the Gateway API:**

When you create a `Gateway` resource referencing a GatewayClass with `controllerName: istio.io/gateway-controller`, Istio **automatically provisions**:
1. An Envoy `Deployment` (the gateway proxy)
2. A `Service` (typically LoadBalancer) to expose it
3. A `ServiceAccount` with the appropriate RBAC

This is a major difference from the Istio Gateway CRD, where you had to manually deploy `istio-ingressgateway`. With the Gateway API, the lifecycle is fully automated -- delete the `Gateway` resource and the deployment is cleaned up.

```
Gateway API resource created
         │
         ▼
  istiod watches gateway.networking.k8s.io/v1
         │
         ├──► Creates Deployment (Envoy proxy) with matching labels
         ├──► Creates Service (LoadBalancer / ClusterIP)
         ├──► Creates ServiceAccount + RBAC
         │
         ▼
  istiod translates Gateway listeners + HTTPRoute rules
  into xDS config and pushes to the new Envoy proxy
         │
         ▼
  Envoy proxy starts serving traffic with
  routes defined by HTTPRoute resources
```

### Istio Gateway CRD vs Kubernetes Gateway API

| Aspect | Istio Gateway CRD | Kubernetes Gateway API |
|--------|-------------------|----------------------|
| API group | `networking.istio.io/v1` | `gateway.networking.k8s.io/v1` |
| Status | Supported (not deprecated) | **Recommended** (Istio 1.22+) |
| Gateway provisioning | Manual (deploy `istio-ingressgateway`) | **Automatic** (Istio creates Deployment + Service) |
| Route binding | VirtualService `gateways` field (by name) | HTTPRoute `parentRefs` (explicit, with status feedback) |
| Cross-namespace | Allowed implicitly | Requires explicit `allowedRoutes` + `ReferenceGrant` |
| Role separation | Weak (same team manages Gateway + VS) | **Strong** (GatewayClass / Gateway / Route layers) |
| Status reporting | Limited | Rich (route conditions, accepted/rejected per parent) |
| Portability | Istio-specific | Portable across implementations (Istio, Envoy Gateway, Cilium, etc.) |
| Mesh (east-west) | VirtualService for internal routing | HTTPRoute can also be used for mesh routing (experimental in some versions) |

> **Note:** The Istio Gateway CRD is **not deprecated** as of Istio 1.24. Both APIs work side by side. However, all new Istio documentation and examples default to the Gateway API, and the community direction is clearly toward it. For new deployments, use the Kubernetes Gateway API.

### Waypoint Proxies and the Gateway API

In Ambient mode, **waypoint proxies** are also managed via the Gateway API:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: my-ns-waypoint
  namespace: my-namespace
  labels:
    istio.io/waypoint-for: service  # ← "service" or "workload"
spec:
  gatewayClassName: istio-waypoint  # ← special class for waypoints
  listeners:
  - name: mesh
    port: 15008                     # ← HBONE port
    protocol: HBONE
```

This creates a waypoint proxy Deployment in the namespace. All L7 policies (HTTPRoute, AuthorizationPolicy with HTTP conditions) are enforced at this waypoint. The Gateway API unifies both ingress and mesh-internal L7 proxies under a single API surface.

---

## ServiceEntry: Adding External Services to the Mesh

By default, Istio-proxied services can reach external hosts, but traffic to those hosts bypasses Istio's routing, resilience, and observability features. A **ServiceEntry** registers an external service into Istio's internal service registry so that Envoy can apply the full traffic management stack (retries, timeouts, circuit breaking, mTLS) to external traffic.

```
┌───────────────────────────────────────────────────────────────────┐
│                     WITHOUT ServiceEntry                           │
│                                                                    │
│  Pod ──► Envoy sidecar ──► ext-api.example.com                    │
│                  │                                                 │
│                  └─ passthrough cluster (no Istio policies)        │
│                     no retries, no timeouts, no metrics            │
│                                                                    │
│                     WITH ServiceEntry                              │
│                                                                    │
│  Pod ──► Envoy sidecar ──► ext-api.example.com                    │
│                  │                                                 │
│                  └─ named cluster with full Envoy config           │
│                     retries, timeouts, circuit breaking, metrics   │
│                     VirtualService + DestinationRule can attach    │
└───────────────────────────────────────────────────────────────────┘
```

```yaml
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: external-api
spec:
  hosts:
  - ext-api.example.com
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  location: MESH_EXTERNAL             # outside the mesh (vs MESH_INTERNAL)
  resolution: DNS                     # resolve via DNS (vs STATIC, NONE)
```

**`location`** values:
- `MESH_EXTERNAL` -- external service, mTLS not applied to outbound connection
- `MESH_INTERNAL` -- treat as a mesh service (e.g., a VM running an Envoy sidecar registered to the mesh)

**`resolution`** values:
- `DNS` -- Envoy resolves the hostname via DNS and load-balances across returned IPs
- `STATIC` -- use explicitly listed `endpoints` with IP addresses
- `NONE` -- forward to the IP the caller connected to (used for wildcard hosts)

Once registered, you can apply VirtualService and DestinationRule to the ServiceEntry host just like any in-mesh service:

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: external-api-route
spec:
  hosts:
  - ext-api.example.com
  http:
  - timeout: 5s
    retries:
      attempts: 2
      perTryTimeout: 2s
    route:
    - destination:
        host: ext-api.example.com
---
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: external-api-dr
spec:
  host: ext-api.example.com
  trafficPolicy:
    tls:
      mode: SIMPLE                    # originate TLS to the external service
    connectionPool:
      tcp:
        maxConnections: 50
    outlierDetection:
      consecutive5xxErrors: 3
      interval: 10s
      baseEjectionTime: 30s
```

---

## Sidecar Resource: Limiting Proxy Scope

By default, every Envoy sidecar is configured with routes and clusters for **every service in the mesh**. In large meshes (hundreds or thousands of services), this means every proxy holds a large xDS configuration, consuming significant memory and increasing config push times.

The **Sidecar** resource limits which services a proxy can reach (egress) and which ports it accepts traffic on (ingress), reducing the xDS config footprint.

```
┌──────────────────────────────────────────────────────────────────┐
│          DEFAULT (no Sidecar resource)                             │
│                                                                   │
│  Envoy sidecar config includes:                                   │
│  - Clusters for ALL services across ALL namespaces                │
│  - Routes for ALL VirtualServices                                 │
│  - Memory: potentially hundreds of MB in large meshes             │
│                                                                   │
│          WITH Sidecar resource                                    │
│                                                                   │
│  Envoy sidecar config includes:                                   │
│  - Only clusters for services in specified namespaces/hosts       │
│  - Dramatically smaller config, faster xDS pushes                 │
└──────────────────────────────────────────────────────────────────┘
```

```yaml
apiVersion: networking.istio.io/v1
kind: Sidecar
metadata:
  name: default
  namespace: bookinfo
spec:
  workloadSelector:                   # omit to apply to ALL pods in namespace
    labels:
      app: reviews
  egress:
  - hosts:
    - "./*"                           # all services in same namespace
    - "istio-system/*"                # istiod, telemetry, etc.
    - "external-ns/ext-api.example.com"  # specific external service
  ingress:
  - port:
      number: 8080
      protocol: HTTP
      name: http
    defaultEndpoint: 127.0.0.1:8080   # forward to app container
```

**Scope rules:**
- A namespace-wide Sidecar (no `workloadSelector`) applies to all workloads in that namespace unless a more specific workload-scoped Sidecar exists
- Only one namespace-wide Sidecar allowed per namespace
- The `egress.hosts` field uses `namespace/host` format. `.` means the Sidecar's own namespace
- Omitting the egress section means the proxy can reach everything (default behavior)

> **Best practice for large meshes:** Define a namespace-wide Sidecar in each namespace restricting egress to only the services that namespace actually calls. This can reduce Envoy memory usage by 10x or more.

---

## Egress Gateways: Controlled External Access

An **egress gateway** is a dedicated Envoy proxy at the mesh edge that handles outbound traffic to external services. It provides a centralized point for monitoring, controlling, and securing all traffic leaving the mesh.

```
┌─────────────────────────────────────────────────────────────────────┐
│  K8s Cluster                                                         │
│                                                                      │
│  ┌──────────┐     ┌──────────────────┐     ┌────────────────────┐   │
│  │ Pod       │     │ istio-egress-    │     │  External Service  │   │
│  │ (+ sidecar)────►│ gateway          │────►│  ext-api.example   │   │
│  └──────────┘     │ (Envoy proxy)    │     │  .com              │   │
│                    │                  │     └────────────────────┘   │
│                    │ - TLS origination│                               │
│                    │ - Access logging │                               │
│                    │ - Policy enforce │                               │
│                    └──────────────────┘                               │
└─────────────────────────────────────────────────────────────────────┘
```

Use cases:
- **Security policy**: Force all external traffic through a single exit point for auditing and firewall rules
- **TLS origination**: Internal services send plain HTTP; the egress gateway upgrades to HTTPS
- **Network topology**: Nodes without direct internet access route through the egress gateway

```yaml
# 1. ServiceEntry for external host
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: ext-svc
spec:
  hosts:
  - ext-api.example.com
  ports:
  - number: 443
    name: tls
    protocol: TLS
  resolution: DNS
  location: MESH_EXTERNAL

# 2. Gateway for egress
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: egress-gateway
spec:
  selector:
    istio: egressgateway
  servers:
  - port:
      number: 443
      name: tls
      protocol: TLS
    hosts:
    - ext-api.example.com
    tls:
      mode: PASSTHROUGH               # pass TLS through without terminating

# 3. VirtualService: route mesh traffic → egress gateway → external
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: ext-via-egress
spec:
  hosts:
  - ext-api.example.com
  gateways:
  - mesh                              # applies to sidecar-to-egress routing
  - egress-gateway                    # applies at the egress gateway itself
  tls:
  - match:
    - gateways: [mesh]
      port: 443
      sniHosts: [ext-api.example.com]
    route:
    - destination:
        host: istio-egressgateway.istio-system.svc.cluster.local
        port:
          number: 443
  - match:
    - gateways: [egress-gateway]
      port: 443
      sniHosts: [ext-api.example.com]
    route:
    - destination:
        host: ext-api.example.com
        port:
          number: 443
```

---

## Network Resilience: Timeouts, Retries, Circuit Breaking, Fault Injection

These features make services resilient to failures without requiring application code changes. They are configured via VirtualService (timeouts, retries, fault injection) and DestinationRule (circuit breaking, outlier detection).

### Timeouts

```yaml
http:
- route:
  - destination:
      host: ratings
  timeout: 10s                        # total request timeout
```

Istio's default: **no timeout** (disabled). When set, Envoy returns `504 Gateway Timeout` if the upstream does not respond within the specified duration. The timeout covers the entire request, including all retries.

> **Gotcha:** If the application also sets a timeout (e.g., HTTP client timeout), the **shorter** of the two wins. A common pitfall: application timeout is 3s, Istio timeout is 10s with 3 retries -- the application gives up before retries complete. Always coordinate timeouts across layers.

### Retries

```yaml
http:
- route:
  - destination:
      host: ratings
  retries:
    attempts: 3                       # max retry attempts (total calls = attempts + 1... NO)
    perTryTimeout: 2s                 # timeout per individual attempt
    retryOn: 5xx,reset,connect-failure,retriable-4xx
```

> **Note:** The `attempts` field specifies the **total number of attempts including the first try**, not retries after the first try. So `attempts: 3` means up to 3 total calls (1 original + 2 retries). This matches Envoy's `num_retries` behavior where `num_retries: 3` means 3 retries after the first attempt -- but Istio's `attempts` is mapped as `num_retries = attempts - 1` in Envoy config, so `attempts: 3` = `num_retries: 2`.

Istio default: **2 attempts**, with retry conditions `connect-failure,refused-stream,unavailable,cancelled,retriable-status-codes`. Retries are automatically spaced with a 25ms+ base interval with random jitter to avoid thundering-herd on a failing service.

**`retryOn` values** (maps to Envoy's `retry_on`):

| Value | Retries when... |
|-------|----------------|
| `5xx` | Upstream returns any 5xx status |
| `gateway-error` | 502, 503, or 504 |
| `reset` | Upstream resets the connection (TCP RST) |
| `connect-failure` | Connection to upstream fails entirely |
| `retriable-4xx` | Upstream returns a retriable 4xx (409 Conflict) |
| `refused-stream` | Upstream sends REFUSED_STREAM (HTTP/2) |
| `retriable-status-codes` | Upstream returns a status in `retriableStatusCodes` list |

### Circuit Breaking (via DestinationRule)

Circuit breaking prevents cascading failures by capping concurrent connections, requests, and retries to an upstream cluster. When thresholds are exceeded, Envoy immediately returns `503` with response flag `UO` (upstream overflow) instead of queueing.

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: reviews-cb
spec:
  host: reviews
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100           # max TCP connections to upstream
      http:
        h2UpgradePolicy: DEFAULT
        http1MaxPendingRequests: 100  # max queued requests when all conns busy
        http2MaxRequests: 1000        # max concurrent HTTP/2 requests
        maxRequestsPerConnection: 10  # close conn after N requests (prevents stale)
        maxRetries: 3                 # max concurrent retries to upstream
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
```

```
┌────────────────────────────────────────────────────────────────┐
│                    CIRCUIT BREAKER FLOW                          │
│                                                                 │
│  New request arrives at Envoy                                   │
│         │                                                       │
│         ▼                                                       │
│  Check: active connections < maxConnections?                    │
│    ├── No  → 503 (UO flag) immediately                         │
│    └── Yes                                                      │
│         │                                                       │
│         ▼                                                       │
│  Check: pending requests < http1MaxPendingRequests?             │
│    ├── No  → 503 (UO flag) immediately                         │
│    └── Yes                                                      │
│         │                                                       │
│         ▼                                                       │
│  Forward request to upstream                                    │
│         │                                                       │
│         ▼                                                       │
│  Response: 5xx?                                                 │
│    ├── Yes → increment outlier counter for that endpoint        │
│    │         consecutive5xxErrors >= threshold?                  │
│    │           └── Yes → EJECT endpoint for baseEjectionTime    │
│    └── No  → reset consecutive error counter                    │
└────────────────────────────────────────────────────────────────┘
```

### Fault Injection

Fault injection tests resilience by injecting delays or HTTP errors at the Envoy proxy layer (L7), not at the network layer. This tests actual application behavior including timeouts, retry logic, and fallback mechanisms.

Two types:
- **Delays** -- adds latency before forwarding the request
- **Aborts** -- returns an error code without forwarding

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: ratings-fault
spec:
  hosts:
  - ratings
  http:
  - fault:
      delay:
        percentage:
          value: 10                   # 10% of requests
        fixedDelay: 5s                # add 5s delay
      abort:
        percentage:
          value: 0.1                  # 0.1% of requests
        httpStatus: 500               # return 500 error
    route:
    - destination:
        host: ratings
        subset: v1
```

Fault injection happens **before** the request reaches the upstream, so it tests the calling service's handling of slow/failed dependencies. The delay is applied before forwarding, and abort replaces the upstream response entirely.

> **Important:** Fault injection and retry/timeout config on the **same VirtualService route** can interact unexpectedly. For example, injecting a 5s delay with a 3s timeout on the same route means the delayed requests will always timeout. Test fault injection on the destination service's VirtualService, not the caller's.

---

## See also

- [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]] -- control plane, xDS, sidecar injection, iptables, request lifecycle
- [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]] -- Envoy proxy pipeline, threading, filters, connection pooling
- [[notes/Networking/istio-security|Istio Security]] -- mTLS, AuthorizationPolicy, RequestAuthentication, ext_authz
- [[notes/Networking/istio-observability-extensibility|Istio Observability & Extensibility]] -- metrics, tracing, WasmPlugin, EnvoyFilter
- [Istio Traffic Management Concepts](https://istio.io/latest/docs/concepts/traffic-management/)
- [Istio VirtualService Reference](https://istio.io/latest/docs/reference/config/networking/virtual-service/)
- [Istio DestinationRule Reference](https://istio.io/latest/docs/reference/config/networking/destination-rule/)
- [Istio ServiceEntry Reference](https://istio.io/latest/docs/reference/config/networking/service-entry/)
- [Istio Sidecar Reference](https://istio.io/latest/docs/reference/config/networking/sidecar/)
- [Envoy Circuit Breaking](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking)
- [Kubernetes Gateway API](https://gateway-api.sigs.k8s.io/)

---

## Interview Prep

### Q: Walk through how a VirtualService and DestinationRule work together to implement a canary deployment.

**A:** A canary deployment gradually shifts traffic from an old version to a new one. Here is the end-to-end flow:

```
1. DestinationRule defines subsets (v1, v2) based on pod labels
2. VirtualService splits traffic: 90% → v1, 10% → v2

   Client request
       │
       ▼
   Envoy sidecar (caller)
       │
       ├── RDS: route config from VirtualService
       │   weighted_clusters: v1=90, v2=10
       │
       ├── 90% chance → CDS cluster: outbound|8080|v1|reviews...
       │                  └── EDS: pods with version=v1
       │
       └── 10% chance → CDS cluster: outbound|8080|v2|reviews...
                          └── EDS: pods with version=v2
```

The VirtualService handles route-level weight splitting. The DestinationRule maps subset names to label selectors and configures per-subset policies (e.g., different circuit breaker thresholds for the canary). You gradually increase the v2 weight (10 -> 25 -> 50 -> 100) as confidence grows.

Key point: **Without** a DestinationRule defining subsets, you cannot reference `subset: v2` in the VirtualService -- Envoy won't have a cluster for it.

---

### Q: What is the Kubernetes Gateway API and how does Istio use it? How does it differ from the Istio Gateway CRD?

**A:** The Kubernetes Gateway API (`gateway.networking.k8s.io`) is a SIG-Network standard that provides a role-oriented, portable API for managing ingress and mesh traffic. It has three core resources:

- **GatewayClass**: Defines the controller implementation (e.g., `istio.io/gateway-controller`). Managed by infrastructure providers.
- **Gateway**: Configures listeners (ports, TLS, hostname matching, allowed routes). Managed by cluster operators.
- **HTTPRoute** (also GRPCRoute, TCPRoute, TLSRoute): Defines routing rules and backends. Managed by application developers.

Key differences from the Istio Gateway CRD:

1. **Automated provisioning**: When you create a Gateway API `Gateway` resource, Istio automatically creates the Envoy Deployment, Service, and ServiceAccount. With the Istio CRD, you had to manually deploy `istio-ingressgateway`.
2. **Role separation**: The three-tier model (GatewayClass -> Gateway -> Route) cleanly separates infrastructure, platform, and application concerns. The Istio CRD mixed these -- the same team often managed both Gateway and VirtualService.
3. **Cross-namespace safety**: The Gateway API requires explicit `allowedRoutes` on the Gateway and `ReferenceGrant` for cross-namespace references. The Istio CRD allowed implicit cross-namespace binding.
4. **Status feedback**: HTTPRoute reports rich status conditions (Accepted, ResolvedRefs) per parent Gateway. The Istio VirtualService had limited status reporting.
5. **Portability**: Gateway API works across Istio, Envoy Gateway, Cilium, and other implementations. The Istio CRD is Istio-specific.

Istio adopted the Gateway API as the **recommended** API starting with 1.16, reaching GA in 1.22+. The Istio CRD is not deprecated but all new documentation defaults to the Gateway API.

In Ambient mode, waypoint proxies are also managed via Gateway API using `gatewayClassName: istio-waypoint`, unifying both ingress and mesh-internal L7 proxies under one API.

---

### Q: What is the difference between circuit breaking and outlier detection in Istio?

**A:** Both are configured via DestinationRule but serve different purposes:

```
┌─────────────────────────┬──────────────────────────────────────┐
│    Circuit Breaking      │    Outlier Detection                 │
│    (connectionPool)      │    (outlierDetection)                │
├─────────────────────────┼──────────────────────────────────────┤
│ Prevents overloading     │ Removes unhealthy endpoints          │
│ upstream with too many   │ from the load balancer pool          │
│ concurrent requests      │ based on observed errors             │
│                          │                                      │
│ Thresholds:              │ Thresholds:                          │
│ - maxConnections         │ - consecutive5xxErrors               │
│ - http1MaxPendingReqs    │ - consecutiveGatewayErrors           │
│ - http2MaxRequests       │ - interval (check window)            │
│ - maxRetries             │ - baseEjectionTime                   │
│                          │ - maxEjectionPercent                 │
│ When exceeded:           │ When exceeded:                       │
│ → 503 immediately        │ → endpoint ejected for a duration    │
│   (response flag: UO)    │   (exponential backoff on repeat)    │
│                          │                                      │
│ Scope: entire cluster    │ Scope: individual endpoint           │
└─────────────────────────┴──────────────────────────────────────┘
```

Circuit breaking protects the upstream service from being overwhelmed. Outlier detection protects the caller from wasting requests on a broken endpoint. They complement each other -- circuit breaking caps total load, outlier detection removes the bad pods from rotation.

---

### Q: What happens when a VirtualService exists for a host but the request doesn't match any route rule?

**A:** The request gets a **404 Not Found** from Envoy. Once a VirtualService claims a host (via the `hosts` field), it takes full ownership of that host's routing in Envoy's RDS config. Envoy does NOT fall back to Kubernetes default round-robin routing. This is why you should always include a catch-all route (no `match` condition) as the last rule.

---

### Q: Why would you use a ServiceEntry? What can you do with it that you cannot do without it?

**A:** Without a ServiceEntry, traffic to external hosts goes through Envoy's passthrough cluster -- it reaches the destination, but Istio cannot apply retries, timeouts, circuit breaking, mTLS, or traffic shifting. You also get no telemetry (no metrics, no access logs with proper service names).

With a ServiceEntry:
- Apply VirtualService routing rules (timeouts, retries, fault injection, traffic splitting)
- Apply DestinationRule policies (circuit breaking, outlier detection, TLS origination)
- Get full Envoy metrics and access logs for external traffic
- Use egress gateways to funnel all external traffic through a controlled exit point

---

### Q: How does the Sidecar resource improve performance in large meshes?

**A:** By default, every Envoy sidecar receives xDS configuration for every service in the mesh. In a mesh with 500 services, each sidecar holds 500+ cluster definitions, route tables, and endpoint lists. This causes:
- High memory usage per proxy (can exceed 100MB)
- Slow xDS push times (istiod must push to every proxy on any service change)
- Longer Envoy startup times

The Sidecar resource's `egress.hosts` field restricts which services a proxy knows about. A workload that only calls 5 services only gets xDS config for those 5 services. This reduces memory 10-50x and makes xDS pushes incremental and targeted.

---

### Q: Explain the interaction between Istio retries and timeouts. What is `perTryTimeout` vs the overall `timeout`?

**A:**

```
┌──────────────────────────────────── timeout: 10s ──────────────────────┐
│                                                                         │
│  ┌── perTryTimeout: 3s ──┐  ┌── perTryTimeout: 3s ──┐  ┌── 3s ──┐   │
│  │    Attempt 1           │  │    Attempt 2 (retry)   │  │  Att 3  │   │
│  │    (connect + wait     │  │    (connect + wait     │  │ (retry) │   │
│  │     for response)      │  │     for response)      │  │         │   │
│  └────────────────────────┘  └────────────────────────┘  └─────────┘   │
│                                                                         │
│  t=0                    t=3s                        t=6s          t=10s │
│  start                  retry 1                     retry 2       give  │
│                         (attempt 1 timed out)       starts        up    │
└─────────────────────────────────────────────────────────────────────────┘
```

- `timeout` is the **total** time allowed for the entire request including all retries. Default: disabled (no timeout).
- `perTryTimeout` is the max time for each individual attempt. Default: same as the overall route timeout.
- `attempts: 3` means up to 3 total calls. In Envoy terms, `num_retries` = attempts - 1 = 2 retries.

If the overall `timeout` expires mid-retry, Envoy stops retrying and returns 504. If `perTryTimeout` expires on one attempt, Envoy starts the next retry (if attempts remain and overall timeout hasn't expired).

---

### Q: How does consistent hash load balancing work in Istio? When would you use it?

**A:** Consistent hash LB ensures the same client always reaches the same backend endpoint, enabling session affinity without server-side session stores. Configured in DestinationRule:

```yaml
trafficPolicy:
  loadBalancer:
    consistentHashLB:
      httpHeaderName: x-user-id    # or httpCookie, useSourceIp, httpQueryParameterName
```

Envoy hashes the specified key and maps it to a point on a hash ring where each endpoint occupies a range. When endpoints are added/removed, only a fraction of keys get remapped (minimizing disruption).

Use cases: sticky sessions for stateful services, cache affinity (user X always hits the same cache node), WebSocket connections.

Caveat: if the hashed endpoint is ejected by outlier detection, the request falls through to the next endpoint on the ring -- no error, just a different backend.
