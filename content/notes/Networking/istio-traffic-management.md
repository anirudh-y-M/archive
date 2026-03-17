---
title: "Istio Traffic Management: VirtualService, DestinationRule, Gateway API, and Traffic Policies"
---

## Overview

Istio's traffic management is built on custom resources that map directly to Envoy configuration. For internal (east-west) routing: **VirtualService** (how to route) and **DestinationRule** (how to reach). For ingress (north-south) traffic: **Gateway** resources that configure Envoy listeners at the mesh edge.

For the Istio control plane architecture, xDS protocol, and request lifecycle, see [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]]. For Envoy internals (filter chains, connection pooling), see [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]].

---

## VirtualService -> Envoy Route Configuration (RDS)

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
  - route:                            # ← Default route
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

---

## DestinationRule -> Envoy Cluster Configuration (CDS)

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

## See also

- [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]] -- control plane, xDS, sidecar injection, iptables, request lifecycle
- [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]] -- Envoy proxy pipeline, threading, filters, connection pooling
- [[notes/Networking/istio-security|Istio Security]] -- mTLS, AuthorizationPolicy, RequestAuthentication, ext_authz
- [[notes/Networking/istio-observability-extensibility|Istio Observability & Extensibility]] -- metrics, tracing, WasmPlugin, EnvoyFilter
- [Istio Traffic Management Concepts](https://istio.io/latest/docs/concepts/traffic-management/)
- [Kubernetes Gateway API](https://gateway-api.sigs.k8s.io/)

---

## Interview Prep

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
