---
title: "Istio Service Mesh: Architecture, Traffic Interception, xDS, mTLS, and Ambient Mode"
---

## Overview

Istio is a service mesh that provides traffic management, security (mTLS, authorization), and observability for microservices running on Kubernetes. It works by injecting an Envoy sidecar proxy into every pod and managing those proxies from a centralized control plane called **istiod**. The application code requires zero changes -- all networking concerns (retries, timeouts, mutual TLS, traffic splitting) are handled transparently by the proxy layer.

This note covers the full architecture at wire level: how Envoy processes requests internally, how traffic interception works via iptables, how xDS delivers configuration, how mTLS certificates are managed, and how the newer sidecar-less ambient mode changes the picture.

For Kubernetes networking fundamentals including kube-proxy, iptables, and ClusterIP routing, see [[notes/Networking/docker-proxy-networking-in-k8s|Docker Proxy Networking in K8s]].

---

## Architecture: Control Plane vs Data Plane

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CONTROL PLANE                                   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                          istiod                                  │    │
│  │                                                                  │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐   │    │
│  │  │  Pilot   │  │ Citadel  │  │  Galley   │  │  xDS Server   │   │    │
│  │  │ (config  │  │  (CA /   │  │ (config   │  │  (push config │   │    │
│  │  │  trans-  │  │  cert    │  │  valida-  │  │   to proxies) │   │    │
│  │  │  lation) │  │  mgmt)   │  │  tion)    │  │               │   │    │
│  │  └──────────┘  └──────────┘  └──────────┘  └───────────────┘   │    │
│  └──────────────────────────────────┬──────────────────────────────┘    │
│                                     │ xDS (gRPC)                        │
│                                     │ SDS (certs)                       │
└─────────────────────────────────────┼───────────────────────────────────┘
                                      │
┌─────────────────────────────────────┼───────────────────────────────────┐
│                         DATA PLANE  │                                   │
│                                     ▼                                   │
│  ┌─── Pod A ──────────────┐   ┌─── Pod B ──────────────┐               │
│  │  ┌──────┐  ┌─────────┐ │   │  ┌──────┐  ┌─────────┐ │               │
│  │  │ App  │  │ istio-  │ │   │  │ App  │  │ istio-  │ │               │
│  │  │      │◄─┤ proxy   │ │   │  │      │◄─┤ proxy   │ │               │
│  │  │      │  │ (envoy  │ │   │  │      │  │ (envoy  │ │               │
│  │  │      │  │  + pilot│ │   │  │      │  │  + pilot│ │               │
│  │  │      │  │  -agent)│ │   │  │      │  │  -agent)│ │               │
│  │  └──────┘  └─────────┘ │   │  └──────┘  └─────────┘ │               │
│  └────────────────────────┘   └────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────┘
```

### istiod (Control Plane)

istiod is a single Go binary that consolidates what were historically separate components (Pilot, Citadel, Galley) into one process. Its responsibilities:


| Component        | Responsibility                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pilot**        | Watches Kubernetes API for Services, Endpoints, VirtualService, DestinationRule. Translates them into Envoy configuration and pushes via xDS. |
| **Citadel (CA)** | Acts as a Certificate Authority. Issues SPIFFE X.509 certificates to workloads, handles rotation. Delivers certs via SDS.                     |
| **Galley**       | Validates Istio custom resource configurations before they are accepted by the API server.                                                    |
| **xDS Server**   | Maintains gRPC connections to every Envoy proxy. Pushes configuration updates (listeners, routes, clusters, endpoints, secrets) in real time. |


istiod is stateless by design -- it reconstructs all state from the Kubernetes API server on startup. Running multiple replicas provides high availability.

### Data Plane (Envoy Sidecars)

Every meshed pod runs an `istio-proxy` container alongside the application container. This container holds two processes:

```
┌─── istio-proxy container ───────────────────────┐
│                                                   │
│  ┌─────────────┐       ┌───────────────────────┐ │
│  │ pilot-agent  │──────▶│       Envoy            │ │
│  │              │       │                         │ │
│  │ - bootstrap  │       │ - L4/L7 proxy           │ │
│  │   generation │       │ - mTLS termination      │ │
│  │ - cert fetch │       │ - load balancing         │ │
│  │   via SDS    │       │ - retries/timeouts       │ │
│  │ - health     │       │ - metrics (port 15090)   │ │
│  │   checks     │       │ - admin API (port 15000) │ │
│  │ - envoy      │       │                         │ │
│  │   lifecycle  │       │                         │ │
│  └─────────────┘       └───────────────────────┘ │
└───────────────────────────────────────────────────┘
```

**pilot-agent** (not to be confused with Pilot in istiod):

- Generates the Envoy bootstrap configuration at startup
- Implements the SDS server locally -- fetches certificates from istiod and serves them to Envoy over a Unix domain socket
- Manages the Envoy process lifecycle (starts, drains, restarts on crash)
- Serves the health check endpoint on port 15021

---

## Well-Known Ports


| Port      | Protocol | Owner       | Purpose                                                       |
| --------- | -------- | ----------- | ------------------------------------------------------------- |
| **15001** | TCP      | Envoy       | **VirtualOutbound** listener -- captures all outbound traffic |
| **15006** | TCP      | Envoy       | **VirtualInbound** listener -- captures all inbound traffic   |
| **15000** | HTTP     | Envoy       | Admin interface (`/config_dump`, `/clusters`, `/stats`)       |
| **15004** | gRPC     | pilot-agent | Debug interface                                               |
| **15010** | gRPC     | istiod      | xDS (plaintext, for testing)                                  |
| **15012** | gRPC     | istiod      | xDS over mTLS (production)                                    |
| **15014** | HTTP     | istiod      | Control plane metrics and debug                               |
| **15017** | HTTPS    | istiod      | Webhook server (sidecar injection, config validation)         |
| **15020** | HTTP     | pilot-agent | Merged Prometheus metrics + health                            |
| **15021** | HTTP     | pilot-agent | Health check endpoint (`/healthz/ready`)                      |
| **15053** | DNS      | pilot-agent | Istio DNS proxy (captures DNS queries)                        |
| **15090** | HTTP     | Envoy       | Prometheus metrics endpoint (`/stats/prometheus`)             |


---

## Envoy Proxy Internals

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

## xDS Protocol Deep Dive

xDS (Extensible Discovery Service) is the gRPC-based protocol Envoy uses to receive dynamic configuration from a management server (istiod). Instead of static config files, every Envoy proxy maintains a persistent gRPC stream to istiod and receives configuration updates in real time.

```
┌─────────────────────────────────────────────────────────┐
│                        istiod                            │
│                                                          │
│  K8s API Watch ──► Translation Engine ──► xDS Server     │
│                                              │           │
│  VirtualService  ──► RDS routes              │           │
│  DestinationRule ──► CDS clusters            │           │
│  Service/Endpoints ──► CDS + EDS             │           │
│  PeerAuthentication ──► LDS + filter chains  │           │
└──────────────────────────┬───────────────────┘
                           │ gRPC stream (ADS)
                           │ port 15012 (mTLS)
                ┌──────────┼──────────┐
                ▼          ▼          ▼
            Envoy A    Envoy B    Envoy C
```

### The Six xDS APIs


| xDS API | Full Name                    | What It Configures                                                                                                   | Envoy Concept             |
| ------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **LDS** | Listener Discovery Service   | How to accept connections -- bind address, port, filter chains                                                       | `listener`                |
| **RDS** | Route Discovery Service      | How to route HTTP requests -- virtual hosts, route match rules, rewrites                                             | `route_configuration`     |
| **CDS** | Cluster Discovery Service    | Upstream service groups -- load balancing policy, circuit breaker settings, TLS context                              | `cluster`                 |
| **EDS** | Endpoint Discovery Service   | Actual IP:port of healthy pods backing a cluster -- locality, weight, health status                                  | `cluster_load_assignment` |
| **SDS** | Secret Discovery Service     | TLS certificates and private keys for mTLS, trusted CA bundles                                                       | `secret`                  |
| **ADS** | Aggregated Discovery Service | Not a separate resource type -- a single gRPC stream that multiplexes all of the above, ensuring ordering guarantees | (transport mechanism)     |


### xDS Update Flow

```
  K8s Event (e.g., new Pod becomes Ready)
       │
       ▼
  istiod watches K8s API server
       │
       ▼
  istiod translates to Envoy config
       │
       ▼
  istiod pushes via xDS (over existing gRPC stream)
       │
       ├──► LDS push: new filter chain for the service
       ├──► RDS push: updated route if VirtualService changed
       ├──► CDS push: updated cluster config
       ├──► EDS push: new endpoint added to cluster
       └──► SDS push: certificate rotation
       │
       ▼
  Envoy applies config in-memory (hot reload, no restart)
```

### Ordering Guarantees

When using ADS (which Istio always does), updates must follow a safe ordering to avoid traffic blackholes:

```
  CDS ──► EDS ──► LDS ──► RDS

  Why this order:
  1. CDS first:  Create the cluster definition
  2. EDS second: Populate it with endpoints (so it's not empty)
  3. LDS third:  Create the listener that will route to the cluster
  4. RDS last:   Add routes pointing to the now-populated cluster

  If LDS arrived before CDS/EDS, Envoy would have a route
  pointing to a cluster that doesn't exist yet → 503 errors.
```

### State of the World (SotW) vs Delta xDS


| Variant                 | Description                                                        | Trade-off                                                                   |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **SotW**                | Every push sends the complete set of resources of that type        | Simple but wasteful at scale -- 1 new pod = full EDS push for all endpoints |
| **Delta (Incremental)** | Only changed resources are sent                                    | Much more efficient for large meshes. Default since Istio 1.22              |
| **Delta ADS**           | Single gRPC stream with incremental updates for all resource types | Best of both worlds -- ordering guarantees + efficiency                     |


---

## Sidecar Injection

Istio injects the sidecar proxy into pods automatically using a Kubernetes **Mutating Admission Webhook**. No changes to Deployments or Pod specs are needed -- the injection happens at pod creation time.

```
  kubectl apply -f deployment.yaml
       │
       ▼
  K8s API Server receives Pod creation request
       │
       ▼
  API Server calls Mutating Admission Webhooks
       │
       ▼
  istiod webhook (port 15017) intercepts the request
       │
       ▼
  istiod checks namespace label: istio-injection=enabled ?
       │
       ├── No  → Pod created as-is (no sidecar)
       │
       └── Yes → istiod mutates the Pod spec:
                  │
                  ├── Adds init container: istio-init
                  │   (sets up iptables rules)
                  │
                  ├── Adds sidecar container: istio-proxy
                  │   (Envoy + pilot-agent)
                  │
                  ├── Adds volumes:
                  │   - istio-envoy (emptyDir for config)
                  │   - istio-data (emptyDir for SDS socket)
                  │   - istio-token (projected SA token)
                  │
                  └── Returns mutated Pod spec to API server
       │
       ▼
  API Server creates the mutated Pod
       │
       ▼
  kubelet starts containers in order:
    1. istio-init (runs iptables setup, exits)
    2. istio-proxy + app container (run concurrently)
```

### The istio-init Container

The `istio-init` container runs the `istio-iptables` binary with these key arguments:

```bash
istio-iptables \
  -p 15001 \          # Outbound capture port (VirtualOutbound)
  -z 15006 \          # Inbound capture port (VirtualInbound)
  -u 1337 \           # UID of the istio-proxy process (excluded from capture)
  -m REDIRECT \       # iptables mode (REDIRECT or TPROXY)
  -i '*' \            # Include all outbound IPs for capture
  -x "" \             # Exclude no IPs
  -b '*' \            # Include all inbound ports for capture
  -d 15090,15021,15020  # Exclude these inbound ports from capture
```

It runs with `NET_ADMIN` capability (or is replaced by the Istio CNI plugin which runs at the node level, eliminating the need for `NET_ADMIN` in the pod).

---

## Traffic Interception with iptables

The `istio-init` container creates custom chains in the **NAT table** that transparently redirect all TCP traffic through Envoy. This is how Istio achieves zero-code-change traffic capture.

### iptables Chains and Rules

```
  ┌───────────────────────────────────────────────────────────────┐
  │                     NAT TABLE                                  │
  │                                                                │
  │  PREROUTING chain (inbound traffic entering the pod)           │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │ -j ISTIO_INBOUND                                         │  │
  │  └─────────────────────┬────────────────────────────────────┘  │
  │                        ▼                                       │
  │  ISTIO_INBOUND chain                                           │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │ -p tcp --dport 15008 -j RETURN    (HBONE passthrough)    │  │
  │  │ -p tcp --dport 15090 -j RETURN    (Prometheus metrics)   │  │
  │  │ -p tcp --dport 15021 -j RETURN    (health check)         │  │
  │  │ -p tcp --dport 15020 -j RETURN    (merged metrics)       │  │
  │  │ -p tcp -j ISTIO_IN_REDIRECT       (everything else)      │  │
  │  └─────────────────────┬────────────────────────────────────┘  │
  │                        ▼                                       │
  │  ISTIO_IN_REDIRECT chain                                       │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │ -p tcp -j REDIRECT --to-port 15006                       │  │
  │  └──────────────────────────────────────────────────────────┘  │
  │                                                                │
  │                                                                │
  │  OUTPUT chain (outbound traffic leaving from app)              │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │ -j ISTIO_OUTPUT                                          │  │
  │  └─────────────────────┬────────────────────────────────────┘  │
  │                        ▼                                       │
  │  ISTIO_OUTPUT chain                                            │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │ -s 127.0.0.6/32 -j RETURN         (Envoy inbound→app)   │  │
  │  │ -m owner --uid-owner 1337 -j RETURN (Envoy's own traffic)│  │
  │  │ -m owner --gid-owner 1337 -j RETURN (Envoy's own traffic)│  │
  │  │ -d 127.0.0.1/32 -j RETURN         (localhost traffic)    │  │
  │  │ -j ISTIO_REDIRECT                  (everything else)      │  │
  │  └─────────────────────┬────────────────────────────────────┘  │
  │                        ▼                                       │
  │  ISTIO_REDIRECT chain                                          │
  │  ┌──────────────────────────────────────────────────────────┐  │
  │  │ -p tcp -j REDIRECT --to-port 15001                       │  │
  │  └──────────────────────────────────────────────────────────┘  │
  └───────────────────────────────────────────────────────────────┘
```

### How the Loop is Avoided

The critical trick is the **UID 1337** check. The Envoy process runs as user ID 1337. When Envoy sends a packet (after processing), the OUTPUT chain sees `--uid-owner 1337` and returns immediately, letting the packet go directly to the network stack. Without this, Envoy's outbound traffic would be redirected back to itself infinitely.

```
  App sends packet (uid != 1337)
    │
    ▼
  OUTPUT → ISTIO_OUTPUT → not uid 1337 → ISTIO_REDIRECT → port 15001
    │
    ▼
  Envoy processes, sends packet (uid == 1337)
    │
    ▼
  OUTPUT → ISTIO_OUTPUT → uid 1337 → RETURN → packet goes to network
```

> **Note:** Never run your application container as UID 1337. If you do, all your app's outbound traffic will bypass the sidecar entirely because iptables will think it is Envoy traffic.

### Viewing the iptables Rules

```bash
# From inside the sidecar container:
kubectl exec deploy/my-app -c istio-proxy -- iptables -t nat -S

# Or using nsenter from the node:
nsenter -t <PID> -n iptables -t nat -L -v
```

### Alternative: Istio CNI Plugin

The Istio CNI plugin moves iptables setup from the `istio-init` container to a node-level DaemonSet. Benefits:

- Pods no longer need `NET_ADMIN` or `NET_RAW` capabilities
- Eliminates the init container race condition (see Gotchas section)
- Required for ambient mode

---

## Request Lifecycle End-to-End

A complete request from Service A to Service B in an Istio mesh traverses the following path:

```
 Service A Pod                                          Service B Pod
┌──────────────────────────┐                           ┌──────────────────────────┐
│                          │                           │                          │
│  ┌─────┐   ┌──────────┐ │         Network            │ ┌──────────┐   ┌─────┐  │
│  │ App │   │  Envoy   │ │                            │ │  Envoy   │   │ App │  │
│  │  A  │   │ (sidecar)│ │                            │ │ (sidecar)│   │  B  │  │
│  └──┬──┘   └────┬─────┘ │                            │ └────┬─────┘   └──┬──┘  │
│     │           │        │                            │      │            │     │
└─────┼───────────┼────────┘                            └──────┼────────────┼─────┘
      │           │                                            │            │
      │ Step 1    │ Step 3                             Step 5  │   Step 7   │
      ▼           ▼                                            ▼            ▼

Step 1: App A sends HTTP request to reviews:8080
        (App thinks it's connecting directly to reviews service)

Step 2: Kernel intercepts via iptables OUTPUT chain
        → ISTIO_OUTPUT → ISTIO_REDIRECT → port 15001
        Packet redirected to Envoy outbound listener

Step 3: Envoy outbound processing:
        a. Listener 15001 (VirtualOutbound) inspects original dest
        b. Routes to the correct cluster based on Host header / SNI
           Cluster name: "outbound|8080||reviews.default.svc.cluster.local"
        c. Load balancer selects endpoint (e.g., 10.48.2.15:8080)
        d. Applies DestinationRule: retries, timeouts, circuit breaking
        e. Initiates mTLS handshake with destination Envoy
           (presents SPIFFE cert, verifies peer cert)
        f. Sends request over encrypted connection

Step 4: Packet travels over pod network (CNI, possibly across nodes)
        Source: Pod A IP → Dest: Pod B IP (10.48.2.15:8080)

Step 5: Packet arrives at Pod B's network namespace
        Kernel intercepts via iptables PREROUTING chain
        → ISTIO_INBOUND → ISTIO_IN_REDIRECT → port 15006
        Redirected to Envoy inbound listener

Step 6: Envoy inbound processing:
        a. Listener 15006 (VirtualInbound) inspects original dest port
        b. Selects filter chain matching port 8080
        c. Terminates mTLS, validates peer SPIFFE identity
        d. Applies AuthorizationPolicy (RBAC check)
        e. Applies any inbound traffic policies

Step 7: Envoy forwards to localhost:8080 (the actual app)
        (Envoy connects to 127.0.0.1:8080 as uid 1337,
         bypassing iptables redirect)

Step 8: App B processes request, sends response
        Response follows the reverse path through both Envoys
```

### Detailed Packet Walk (Kernel Level)

```
App A: connect(fd, "10.96.5.100:8080")    ← ClusterIP of "reviews" service
         │
         ▼
Kernel: TCP SYN packet created
        src=10.48.1.5:49152  dst=10.96.5.100:8080
         │
         ▼
iptables NAT OUTPUT: matches ISTIO_OUTPUT
        Not uid 1337 → ISTIO_REDIRECT
        REDIRECT to 127.0.0.1:15001
        (original dst 10.96.5.100:8080 saved in conntrack via SO_ORIGINAL_DST)
         │
         ▼
Envoy (port 15001): accepts connection
        getsockopt(SO_ORIGINAL_DST) → 10.96.5.100:8080
        Looks up route for "reviews" → cluster has endpoints via EDS
        Selects endpoint 10.48.2.15:8080
         │
         ▼
Envoy: connect(fd, "10.48.2.15:8080")     ← Direct pod IP
        (as uid 1337 → bypasses iptables)
         │
         ▼
Kernel: TCP SYN packet created
        src=10.48.1.5:49200  dst=10.48.2.15:8080
        → kube-proxy / CNI routes to Pod B's node
         │
         ▼
Pod B kernel: packet arrives
iptables NAT PREROUTING: matches ISTIO_INBOUND
        Port 8080 not excluded → ISTIO_IN_REDIRECT
        REDIRECT to 127.0.0.1:15006
         │
         ▼
Envoy (port 15006): accepts connection
        getsockopt(SO_ORIGINAL_DST) → 10.48.2.15:8080
        Selects filter chain for port 8080
        Terminates mTLS, runs HTTP filters
         │
         ▼
Envoy: connect(fd, "127.0.0.1:8080")
        (as uid 1337 → bypasses iptables)
         │
         ▼
App B: accepts connection on 0.0.0.0:8080
```

---

## mTLS in Istio

Istio provides automatic mutual TLS between all meshed workloads. Every sidecar gets a short-lived X.509 certificate with a SPIFFE identity, and all service-to-service communication is encrypted and authenticated.

### SPIFFE Identity

Every workload in the mesh receives a SPIFFE (Secure Production Identity Framework for Everyone) identity based on its Kubernetes service account:

```
spiffe://<trust-domain>/ns/<namespace>/sa/<service-account>

Example:
spiffe://cluster.local/ns/default/sa/reviews
```

This identity is embedded in the SAN (Subject Alternative Name) field of the X.509 certificate that istiod issues to the workload.

### Certificate Issuance Flow

```
  Pod starts with istio-proxy container
       │
       ▼
  pilot-agent reads the pod's Kubernetes Service Account token
  (projected token mounted at /var/run/secrets/tokens/istio-token)
       │
       ▼
  pilot-agent generates a private key + CSR
  (CSR includes SPIFFE ID: spiffe://cluster.local/ns/default/sa/reviews)
       │
       ▼
  pilot-agent sends CSR + SA token to istiod (gRPC, port 15012)
       │
       ▼
  istiod validates the SA token with Kubernetes API server
  (TokenReview API -- confirms the token is valid and not expired)
       │
       ▼
  istiod CA signs the CSR, producing an X.509 certificate
  (short TTL, default 24 hours)
       │
       ▼
  istiod returns the signed certificate to pilot-agent
       │
       ▼
  pilot-agent serves the certificate + private key to Envoy
  via the SDS API over a local Unix domain socket
  (/var/run/secrets/workload-spiffe-uds/socket)
       │
       ▼
  Envoy uses the certificate for:
  - Outbound: presenting identity when connecting to other services
  - Inbound: authenticating to peers + encrypting traffic
       │
       ▼
  pilot-agent monitors expiration, rotates before TTL expires
  (no Envoy restart needed -- SDS hot-swaps the cert)
```

### mTLS Handshake Between Services

```
  Envoy A (client)                              Envoy B (server)
       │                                              │
       │ ──── TLS ClientHello ─────────────────────► │
       │      (ALPN: istio-peer-exchange, h2)         │
       │                                              │
       │ ◄─── TLS ServerHello + Certificate ───────── │
       │      cert SAN: spiffe://cluster.local/       │
       │                ns/default/sa/reviews          │
       │      + CertificateVerify                     │
       │                                              │
       │ ──── Client Certificate ──────────────────► │
       │      cert SAN: spiffe://cluster.local/       │
       │                ns/default/sa/productpage      │
       │      + CertificateVerify                     │
       │                                              │
       │ ◄──► Finished ──────────────────────────────►│
       │                                              │
       │ ═══════ Encrypted application data ═════════ │
       │      (HTTP request/response over mTLS)       │
```

Both sides verify:

1. The peer's certificate is signed by the mesh CA (istiod)
2. The SPIFFE identity in the SAN matches the expected service account
3. The certificate is not expired

### PeerAuthentication Policy

Controls the mTLS mode at different scopes:

```yaml
# Mesh-wide: enforce STRICT mTLS everywhere
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system     # root namespace = mesh-wide
spec:
  mtls:
    mode: STRICT              # reject any plaintext traffic
```

```yaml
# Namespace-level: allow plaintext for migration
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: legacy-apps
spec:
  mtls:
    mode: PERMISSIVE          # accept both mTLS and plaintext
```

```yaml
# Workload-specific: port-level override
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: reviews-mtls
  namespace: default
spec:
  selector:
    matchLabels:
      app: reviews
  mtls:
    mode: STRICT
  portLevelMtls:
    8080:
      mode: PERMISSIVE        # allow plaintext on this port only
```


| Mode         | Behavior                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------ |
| `STRICT`     | Only mTLS traffic accepted. Plaintext connections are rejected.                            |
| `PERMISSIVE` | Accepts both mTLS and plaintext. Envoy auto-detects the protocol. Useful during migration. |
| `DISABLE`    | mTLS disabled for this scope. Not recommended.                                             |
| `UNSET`      | Inherits from parent scope (workload inherits namespace, namespace inherits mesh).         |


---

## Traffic Management

Istio's traffic management is built on custom resources that map directly to Envoy configuration. For internal (east-west) routing: **VirtualService** (how to route) and **DestinationRule** (how to reach). For ingress (north-south) traffic: **Gateway** resources that configure Envoy listeners at the mesh edge.

### VirtualService -> Envoy Route Configuration (RDS)

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

### DestinationRule -> Envoy Cluster Configuration (CDS)

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

### Traffic Splitting, Retries, Timeouts, Circuit Breaking

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

### Ingress: Istio Gateway and Kubernetes Gateway API

North-south traffic (from external clients into the mesh) requires a dedicated ingress point. Istio has historically used its own `Gateway` CRD, and now fully supports the **Kubernetes Gateway API** as the recommended approach.

#### Istio Gateway CRD (Legacy / `networking.istio.io`)

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

#### Kubernetes Gateway API (Current Standard)

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

#### Istio Gateway CRD vs Kubernetes Gateway API

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

#### Waypoint Proxies and the Gateway API

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

## Istio Ambient Mode (ztunnel + Waypoint Proxy)

Ambient mode is a sidecar-less data plane architecture introduced to address the resource overhead and operational complexity of sidecar injection. It splits mesh functionality into two layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AMBIENT MODE ARCHITECTURE                        │
│                                                                     │
│  ┌─── Node 1 ─────────────────────────────────────────────────┐    │
│  │                                                              │    │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐                     │    │
│  │  │  Pod A  │  │  Pod B  │  │  Pod C  │  ← no sidecars!     │    │
│  │  │  (app   │  │  (app   │  │  (app   │                     │    │
│  │  │  only)  │  │  only)  │  │  only)  │                     │    │
│  │  └────┬────┘  └────┬────┘  └────┬────┘                     │    │
│  │       │            │            │                            │    │
│  │       └────────────┼────────────┘                            │    │
│  │                    │                                         │    │
│  │              ┌─────┴─────┐                                   │    │
│  │              │  ztunnel  │  ← DaemonSet, one per node        │    │
│  │              │  (Rust,   │    L4: mTLS, L4 authz, telemetry  │    │
│  │              │   L3/L4)  │                                   │    │
│  │              └─────┬─────┘                                   │    │
│  └────────────────────┼─────────────────────────────────────────┘    │
│                       │                                              │
│                       │ HBONE tunnel (HTTP CONNECT over mTLS)       │
│                       │                                              │
│  ┌────────────────────┼──────────────────────────────────────┐      │
│  │                    ▼                                       │      │
│  │  ┌────────────────────────┐     (optional, per-namespace) │      │
│  │  │   Waypoint Proxy       │     L7: HTTP routing, authz,  │      │
│  │  │   (Envoy, Deployment)  │     retries, fault injection,  │      │
│  │  │                        │     traffic splitting          │      │
│  │  └────────────────────────┘                                │      │
│  └────────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

### ztunnel (Zero Trust Tunnel)

- Written in **Rust** (not Envoy) -- purpose-built for L4 only
- Deployed as a **DaemonSet** on every node
- Handles: mTLS encryption/decryption, L4 authorization, TCP telemetry
- Uses **HBONE** (HTTP-Based Overlay Network Encapsulation) to tunnel traffic between ztunnels via HTTP CONNECT over mTLS with HTTP/2 multiplexing
- Creates listening sockets **inside each pod's network namespace** via the Istio CNI agent (no iptables REDIRECT needed for interception)

### Waypoint Proxy

- Standard **Envoy proxy** deployed as a Kubernetes Deployment (not a sidecar)
- Deployed **per namespace** or per service (not per pod)
- Only needed when L7 features are required (HTTP routing, header-based authz, retries, fault injection)
- If no waypoint is deployed, traffic flows directly between ztunnels (L4 only)

### Traffic Flow in Ambient Mode

```
  Without waypoint (L4 only):
  Pod A → ztunnel (node A) ──HBONE──► ztunnel (node B) → Pod B

  With waypoint (L7 processing):
  Pod A → ztunnel (node A) ──HBONE──► Waypoint ──HBONE──► ztunnel (node B) → Pod B
```

### Sidecar vs Ambient Comparison


| Aspect                     | Sidecar Mode                      | Ambient Mode                         |
| -------------------------- | --------------------------------- | ------------------------------------ |
| Proxy per pod              | Yes (Envoy sidecar)               | No (shared ztunnel per node)         |
| Resource overhead          | High (Envoy per pod)              | Low (90%+ memory reduction reported) |
| L7 features                | Always available                  | Only with waypoint proxy             |
| Injection mechanism        | Mutating webhook + init container | Istio CNI agent                      |
| App restart needed to mesh | Yes (pod recreated with sidecar)  | No (label the namespace)             |
| Traffic interception       | iptables REDIRECT                 | ztunnel sockets in pod netns         |
| mTLS                       | Per-sidecar certificates          | Per-ztunnel (shared node identity)   |


---

## Common Gotchas

### Port Naming Requirements

Istio uses Kubernetes service port names to detect the protocol. If ports are not named with a recognized prefix, Istio treats the traffic as opaque TCP and cannot apply HTTP-level features.

```yaml
# Correct -- Istio detects HTTP
ports:
- name: http-web       # prefix "http-" or "http2-" or "grpc-"
  port: 8080
  targetPort: 8080

# Incorrect -- treated as opaque TCP, no HTTP routing/retries
ports:
- name: web
  port: 8080
  targetPort: 8080
```

Recognized prefixes: `http`, `http2`, `https`, `grpc`, `grpc-web`, `mongo`, `mysql`, `redis`, `tcp`, `tls`, `udp`.

Alternatively, set the `appProtocol` field (Kubernetes 1.19+):

```yaml
ports:
- name: web
  port: 8080
  appProtocol: http    # Istio reads this
```

### Protocol Detection (Auto-Detection)

When no protocol hint is available, Envoy's HTTP inspector filter sniffs the first bytes of the connection to determine if it's HTTP. This adds a small latency (detection timeout, default 5s for server-first protocols). For server-first protocols like MySQL, the connection stalls during detection because the server speaks first but Envoy is waiting for client bytes.

### App Binding to localhost vs 0.0.0.0

If your application binds to `127.0.0.1` instead of `0.0.0.0`, the Envoy sidecar cannot reach it. Envoy forwards inbound traffic to `127.0.0.1:<app-port>`, but the kernel only delivers to localhost listeners if the app binds to `0.0.0.0` or `127.0.0.1`. In sidecar mode, this works because Envoy connects via localhost. But if you configure the app to listen on `localhost` only and also have external health checks, those external checks will fail.

> **Note:** Starting with Istio 1.10+, the `ISTIO_META_LOCALHOST_AUTODETECT` feature and changes in VirtualInbound behavior improved localhost handling. However, binding to `0.0.0.0` remains the safest practice.

### Init Container Race Conditions

The `istio-init` container must complete before the app container starts, but the `istio-proxy` (sidecar) container starts concurrently with the app. If the app starts faster than Envoy and immediately sends traffic, iptables will redirect it to port 15001 where Envoy is not yet listening, causing connection failures.

Mitigations:

- Use `holdApplicationUntilProxyStarts: true` in the mesh config (adds a postStart hook to wait for Envoy readiness)
- Use the Istio CNI plugin (eliminates the init container entirely)

### istiod Unavailability

If istiod goes down:

- **Existing proxies continue working** -- they use their last-known configuration cached in memory
- **New xDS pushes stop** -- configuration changes (new routes, new endpoints) are not delivered
- **Certificate rotation fails** -- when certs expire, mTLS handshakes will fail
- **New pods don't get sidecars** -- the mutating webhook is unavailable
- **Endpoint changes are not propagated** -- if pods scale up/down, existing proxies won't learn about new endpoints

This is why running multiple istiod replicas is critical for production.

---

## Debugging Istio

### Essential Commands

```bash
# Check sync status of all proxies (are they up to date with istiod?)
istioctl proxy-status

# OUTPUT:
# NAME              CDS    LDS    EDS    RDS    ECDS   ISTIOD
# app-v1.default    SYNCED SYNCED SYNCED SYNCED        istiod-abc-123
# app-v2.default    STALE  SYNCED SYNCED SYNCED        istiod-abc-123
#                   ^^^^^ indicates config push failure

# Dump Envoy's listeners (LDS)
istioctl proxy-config listeners deploy/my-app

# Dump Envoy's routes (RDS)
istioctl proxy-config routes deploy/my-app

# Dump Envoy's clusters (CDS)
istioctl proxy-config clusters deploy/my-app

# Dump Envoy's endpoints (EDS)
istioctl proxy-config endpoints deploy/my-app

# Full Envoy config dump (JSON)
istioctl proxy-config all deploy/my-app -o json

# Check what config istiod WOULD push to a proxy
istioctl experimental describe pod my-app-pod-xyz

# Verify mTLS is active between services
istioctl authn tls-check deploy/my-app reviews.default.svc.cluster.local
```

### Envoy Admin API (Port 15000)

```bash
# Port-forward to access the admin API
kubectl port-forward deploy/my-app 15000:15000

# Useful endpoints:
curl localhost:15000/config_dump          # Full Envoy configuration
curl localhost:15000/clusters             # Upstream cluster health
curl localhost:15000/stats                # All metrics counters
curl localhost:15000/stats?filter=http    # Filtered metrics
curl localhost:15000/server_info          # Envoy version, uptime
curl localhost:15000/logging?level=debug  # Change log level at runtime
```

### Check iptables Rules

```bash
# View the NAT table rules in the pod
kubectl exec deploy/my-app -c istio-proxy -- iptables -t nat -S

# Expected output (abbreviated):
# -A PREROUTING -j ISTIO_INBOUND
# -A OUTPUT -j ISTIO_OUTPUT
# -A ISTIO_INBOUND -p tcp --dport 15008 -j RETURN
# -A ISTIO_INBOUND -p tcp --dport 15090 -j RETURN
# -A ISTIO_INBOUND -p tcp --dport 15021 -j RETURN
# -A ISTIO_INBOUND -p tcp --dport 15020 -j RETURN
# -A ISTIO_INBOUND -p tcp -j ISTIO_IN_REDIRECT
# -A ISTIO_IN_REDIRECT -p tcp -j REDIRECT --to-ports 15006
# -A ISTIO_OUTPUT -s 127.0.0.6/32 -j RETURN
# -A ISTIO_OUTPUT -m owner --uid-owner 1337 -j RETURN
# -A ISTIO_OUTPUT -m owner --gid-owner 1337 -j RETURN
# -A ISTIO_OUTPUT -d 127.0.0.1/32 -j RETURN
# -A ISTIO_OUTPUT -j ISTIO_REDIRECT
# -A ISTIO_REDIRECT -p tcp -j REDIRECT --to-ports 15001
```

---

## Envoy Proxy Deep Dive

The earlier section covered Envoy's request processing pipeline (Listener -> Filter Chain -> Cluster -> Endpoint). This section goes deeper into Envoy's internal architecture, threading model, filter execution, connection management, and operational features like hot restart and health checking.

### Threading Model

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

### Hot Restart

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

### Filter Types in Depth

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

#### Built-in HTTP Filters Used by Istio

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

### Connection Pooling

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

### Health Checking

Envoy supports two complementary mechanisms for determining endpoint health:

#### Active Health Checking

Envoy periodically sends probe requests to each upstream endpoint and marks unhealthy endpoints as unavailable. This is configured per-cluster and operates independently of Kubernetes liveness/readiness probes.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `interval` | Time between health check attempts | 5s (Istio default varies) |
| `timeout` | Time to wait for a health check response | 1s |
| `unhealthy_threshold` | Consecutive failures before marking unhealthy | 2 |
| `healthy_threshold` | Consecutive successes before marking healthy again | 1 |

Health check types: HTTP (send GET to a path, check status code), TCP (attempt connection), gRPC (use grpc.health.v1.Health service).

> **Note:** In Istio, active health checking is **not enabled by default** for sidecar proxies. Istio relies on Kubernetes readiness probes to remove unready pods from Endpoints, which then propagates to Envoy via EDS. Active health checks can be configured via DestinationRule's `outlierDetection` or via EnvoyFilter for advanced cases. The Istio Gateway deployments are more likely to use active health checks.

#### Passive Health Checking (Outlier Detection)

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

### Access Logging

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

## Observability

Istio provides comprehensive observability out of the box by leveraging Envoy's built-in telemetry capabilities. Every request passing through the mesh is automatically instrumented -- no application code changes required for metrics and basic tracing.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    OBSERVABILITY DATA FLOW                                    │
│                                                                              │
│  ┌─── Pod ──────────────────────┐                                           │
│  │  ┌──────┐     ┌────────────┐ │                                           │
│  │  │ App  │◄───►│ Envoy      │ │                                           │
│  │  │      │     │ (istio-    │ │                                           │
│  │  │      │     │  proxy)    │ │                                           │
│  │  └──────┘     └──┬──┬──┬──┘ │                                           │
│  └──────────────────┼──┼──┼────┘                                           │
│                     │  │  │                                                  │
│          ┌──────────┘  │  └──────────┐                                      │
│          │             │             │                                       │
│          ▼             ▼             ▼                                       │
│  ┌──────────────┐ ┌────────────┐ ┌──────────────────┐                      │
│  │  :15090      │ │ Trace      │ │ Access Logs       │                      │
│  │  /stats/     │ │ Spans      │ │ (stdout or        │                      │
│  │  prometheus  │ │ (Zipkin/   │ │  gRPC ALS)        │                      │
│  │              │ │  OTel fmt) │ │                    │                      │
│  └──────┬───────┘ └─────┬──────┘ └────────┬──────────┘                     │
│         │               │                 │                                  │
│    Scrape (pull)   Push (HTTP/gRPC)   Collect (file/gRPC)                   │
│         │               │                 │                                  │
│         ▼               ▼                 ▼                                  │
│  ┌──────────────┐ ┌────────────────┐ ┌──────────────────┐                  │
│  │  Prometheus   │ │  Jaeger /       │ │  Loki /           │                 │
│  │              │ │  Zipkin /       │ │  Elasticsearch /  │                  │
│  │  (scrapes    │ │  Tempo /        │ │  OpenTelemetry    │                 │
│  │   all Envoys │ │  OpenTelemetry  │ │  Collector        │                  │
│  │   on :15090) │ │  Collector      │ │                    │                 │
│  └──────┬───────┘ └────────┬───────┘ └──────────────────┘                  │
│         │                  │                                                 │
│         ▼                  ▼                                                 │
│  ┌──────────────┐ ┌────────────────┐                                       │
│  │  Grafana      │ │  Jaeger UI /    │                                      │
│  │  (dashboards) │ │  Tempo UI       │                                      │
│  └──────────────┘ └────────────────┘                                       │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  Kiali  (scrapes Prometheus + queries traces)                 │           │
│  │  - Service topology graph                                      │          │
│  │  - Traffic flow visualization                                  │          │
│  │  - Istio config validation                                     │          │
│  └──────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Metrics

Envoy generates a rich set of metrics for every request it proxies. Istio adds a set of **standard metrics** with consistent label dimensions that enable service-level dashboards.

#### Standard Istio Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `istio_requests_total` | Counter | Total requests. Labels: `source_workload`, `destination_workload`, `source_namespace`, `destination_namespace`, `request_protocol`, `response_code`, `connection_security_policy`, `response_flags` |
| `istio_request_duration_milliseconds` | Histogram | Request duration in ms (buckets). Same labels as above. |
| `istio_request_bytes` | Histogram | Request body size in bytes. |
| `istio_response_bytes` | Histogram | Response body size in bytes. |
| `istio_tcp_sent_bytes_total` | Counter | Total bytes sent during TCP connections. |
| `istio_tcp_received_bytes_total` | Counter | Total bytes received during TCP connections. |
| `istio_tcp_connections_opened_total` | Counter | Total TCP connections opened. |
| `istio_tcp_connections_closed_total` | Counter | Total TCP connections closed. |

These metrics are generated by the **Istio stats filter** (`istio.stats`), a Wasm filter compiled into Envoy. It intercepts request/response metadata and emits the standard metrics with the correct label dimensions.

#### Metrics Collection Flow

```
  Envoy sidecar (in every pod)
       │
       │  Exposes /stats/prometheus on port 15090
       │  (merged with Istio standard metrics)
       │
       ▼
  Prometheus scrapes port 15090
       │
       │  Typically via PodMonitor or ServiceMonitor CRDs
       │  (if using prometheus-operator) or via
       │  annotation-based discovery:
       │    prometheus.io/scrape: "true"
       │    prometheus.io/port: "15090"
       │    prometheus.io/path: "/stats/prometheus"
       │
       ▼
  Grafana dashboards
       │
       │  Istio ships standard dashboards:
       │  - Mesh Dashboard (global overview)
       │  - Service Dashboard (per-service metrics)
       │  - Workload Dashboard (per-workload detail)
       │  - Performance Dashboard (control plane metrics)
       │  - Control Plane Dashboard (istiod health)
```

> **Note:** Port 15020 on `pilot-agent` serves a merged metrics endpoint that combines Envoy stats (from 15090) with pilot-agent's own metrics and application metrics (if configured via `prometheus.io/` annotations on the pod). This is useful when you want a single scrape target per pod.

#### Customizing Metrics via Telemetry API

The Istio Telemetry API (discussed in the Extensibility section) allows per-workload metric configuration -- adding custom dimensions, disabling specific metrics, or overriding tag values:

```yaml
apiVersion: telemetry.istio.io/v1
kind: Telemetry
metadata:
  name: custom-metrics
  namespace: my-app
spec:
  metrics:
  - providers:
    - name: prometheus
    overrides:
    - match:
        metric: REQUEST_COUNT
        mode: CLIENT_AND_SERVER
      tagOverrides:
        request_host:
          operation: UPSERT
          value: "request.host"    # add request_host label
    - match:
        metric: REQUEST_DURATION
        mode: SERVER
      disabled: true               # disable duration histogram for this workload
```

### Distributed Tracing

Istio enables distributed tracing across microservices by having each Envoy sidecar generate a **span** for every request it handles. These spans, linked by trace context headers, form a complete trace of a request's path through the mesh.

#### How It Works

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     DISTRIBUTED TRACING FLOW                              │
│                                                                           │
│  Client                                                                   │
│    │                                                                      │
│    │  GET /api/product/123                                                │
│    │  (no trace headers)                                                  │
│    ▼                                                                      │
│  ┌────────────────────┐                                                  │
│  │ Envoy A (ingress)  │ ◄── Generates root span                         │
│  │                     │     Creates: x-request-id, x-b3-traceid,        │
│  │                     │     x-b3-spanid, x-b3-sampled                   │
│  └─────────┬──────────┘                                                  │
│            │  Span A: "inbound|gateway → product-svc"                    │
│            ▼                                                              │
│  ┌────────────────────┐                                                  │
│  │ App: product-svc   │ ◄── App MUST propagate trace headers             │
│  │                     │     when making outbound calls                   │
│  │  calls:             │                                                  │
│  │  - reviews-svc      │                                                  │
│  │  - ratings-svc      │                                                  │
│  └──┬───────────┬──────┘                                                 │
│     │           │                                                         │
│     ▼           ▼                                                         │
│  ┌────────┐  ┌────────┐                                                  │
│  │Envoy B │  │Envoy C │ ◄── Each generates a child span                 │
│  │        │  │        │     linked to the same trace ID                  │
│  └────┬───┘  └────┬───┘                                                  │
│       │           │                                                       │
│       ▼           ▼                                                       │
│  ┌────────┐  ┌────────┐                                                  │
│  │reviews │  │ratings │                                                  │
│  │svc     │  │svc     │                                                  │
│  └────────┘  └────────┘                                                  │
│                                                                           │
│  Result in Jaeger/Zipkin:                                                │
│  ┌─ Trace: abc123 ──────────────────────────────────────────────────┐    │
│  │                                                                    │    │
│  │  ├── Span A: gateway → product-svc       [0ms────────200ms]      │    │
│  │  │   ├── Span B: product → reviews-svc   [10ms──────150ms]      │    │
│  │  │   └── Span C: product → ratings-svc   [20ms────100ms]        │    │
│  │                                                                    │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

#### Critical Caveat: Applications MUST Propagate Trace Headers

Envoy generates spans automatically, but it cannot correlate inbound and outbound spans within the same application. The application **must** copy the following headers from incoming requests to all outgoing requests:

| Header | Format | Purpose |
|--------|--------|---------|
| `x-request-id` | UUID | Envoy-generated unique request ID |
| `x-b3-traceid` | 128-bit hex | Zipkin/B3 trace identifier |
| `x-b3-spanid` | 64-bit hex | Zipkin/B3 span identifier |
| `x-b3-parentspanid` | 64-bit hex | Parent span ID |
| `x-b3-sampled` | `0` or `1` | Whether the trace is sampled |
| `traceparent` | W3C Trace Context | W3C standard trace context (used with OpenTelemetry) |
| `tracestate` | W3C Trace Context | Vendor-specific trace data |

If the application does not propagate these headers, each Envoy generates an independent trace with no parent-child relationship. Multi-hop traces appear as disconnected, single-span traces in Jaeger.

Most HTTP frameworks have middleware/interceptors to propagate these automatically (e.g., Spring Sleuth, Go's `ochttp`, Python's `opentelemetry-instrumentation`).

#### Configuring Tracing

Tracing is configured via the Telemetry API or MeshConfig:

```yaml
# Via Telemetry API (per-namespace or per-workload)
apiVersion: telemetry.istio.io/v1
kind: Telemetry
metadata:
  name: tracing-config
  namespace: istio-system          # mesh-wide if in istio-system
spec:
  tracing:
  - providers:
    - name: zipkin                 # or "opentelemetry"
    randomSamplingPercentage: 1.0  # sample 1% of requests
    customTags:
      environment:
        literal:
          value: "production"
```

Supported tracing backends: **Zipkin**, **Jaeger** (with Zipkin-compatible collector), **OpenTelemetry Collector** (recommended for new deployments), **Datadog**, **Lightstep/ServiceNow**.

### Kiali

Kiali is the dedicated observability console for Istio. It provides a web UI for understanding the structure and health of the service mesh.

Core capabilities:

- **Topology graph**: Real-time visualization of service-to-service traffic flow, with edges showing request rates, error rates, and response times. Can be viewed at namespace, workload, app, or service granularity.
- **Traffic animation**: Animated dots flowing along edges showing actual request volume and direction.
- **Istio config validation**: Validates VirtualService, DestinationRule, AuthorizationPolicy, and other Istio CRDs. Flags issues like missing DestinationRules for subsets referenced in VirtualServices, conflicting mTLS settings, or unreachable routes.
- **Health indicators**: Color-coded health status for services, workloads, and apps based on error rates and request success rates.
- **Distributed tracing integration**: Embeds Jaeger/Tempo trace views directly in the Kiali UI for correlated troubleshooting.
- **Wizard actions**: Can generate Istio config (e.g., traffic routing, fault injection) directly from the UI.

Kiali pulls data from Prometheus (for metrics and graph generation), the Kubernetes API (for workload/service info), and optionally Jaeger/Tempo (for traces).

---

## Security (Beyond mTLS)

The earlier section covered mTLS and PeerAuthentication. This section covers the remaining security features: request-level authentication (JWT validation), fine-grained authorization policies (RBAC), and external authorization delegation.

### Security Evaluation Flow

Every inbound request to a meshed workload passes through the following security checks inside Envoy, in this exact order:

```
┌──────────────────────────────────────────────────────────────────────────┐
│              SECURITY EVALUATION ORDER FOR INCOMING REQUEST               │
│                                                                           │
│  Incoming connection                                                      │
│         │                                                                 │
│         ▼                                                                 │
│  ┌─────────────────────┐                                                 │
│  │  1. mTLS Handshake   │  PeerAuthentication policy                     │
│  │                       │  - STRICT: require valid client cert           │
│  │  Validate peer cert   │  - PERMISSIVE: accept with or without         │
│  │  Extract SPIFFE ID    │  - DISABLE: no TLS                            │
│  │  from SAN             │                                                │
│  └──────────┬────────────┘                                               │
│             │  Peer identity established (or plaintext if PERMISSIVE)    │
│             ▼                                                             │
│  ┌─────────────────────────┐                                             │
│  │  2. RequestAuthentication│  JWT validation                            │
│  │                           │  - Fetch JWKS from issuer                 │
│  │  Validate JWT token       │  - Verify signature, expiry, audience     │
│  │  (if present in request)  │  - Extract claims to filter metadata      │
│  │                           │                                            │
│  │  Missing token?           │                                            │
│  │  → Allowed (unless        │                                            │
│  │    AuthorizationPolicy    │                                            │
│  │    requires JWT claims)   │                                            │
│  └──────────┬────────────────┘                                           │
│             │  JWT claims available (if token was present and valid)     │
│             ▼                                                             │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │  3. AuthorizationPolicy evaluation                                 │   │
│  │                                                                     │   │
│  │  Three actions, evaluated in strict order:                          │   │
│  │                                                                     │   │
│  │  ┌─────────────────┐                                               │   │
│  │  │  a. CUSTOM       │ → Calls ext_authz service                    │   │
│  │  │  (if configured) │   If DENY → 403, stop                        │   │
│  │  │                   │   If ALLOW → continue                        │   │
│  │  └────────┬──────────┘                                             │   │
│  │           ▼                                                         │   │
│  │  ┌─────────────────┐                                               │   │
│  │  │  b. DENY         │ → If ANY deny rule matches → 403, stop       │   │
│  │  │  (if configured) │   If no deny rule matches → continue         │   │
│  │  └────────┬──────────┘                                             │   │
│  │           ▼                                                         │   │
│  │  ┌─────────────────┐                                               │   │
│  │  │  c. ALLOW        │ → If ANY allow rule matches → allow          │   │
│  │  │  (if configured) │   If NO allow rule matches → 403, deny       │   │
│  │  │                   │                                              │   │
│  │  │  If NO ALLOW      │                                              │   │
│  │  │  policies exist   │ → Allow all (implicit allow)                │   │
│  │  └─────────────────┘                                               │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│             │                                                             │
│             ▼                                                             │
│  Request forwarded to application                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

The evaluation order is **CUSTOM -> DENY -> ALLOW**. This is critical to understand:

1. **CUSTOM** policies are evaluated first. If any CUSTOM policy denies the request, evaluation stops immediately.
2. **DENY** policies are evaluated next. If any DENY rule matches, the request is denied regardless of ALLOW policies.
3. **ALLOW** policies are evaluated last. If ALLOW policies exist, at least one must match for the request to proceed. If no ALLOW policies exist at all, the request is implicitly allowed (after passing DENY checks).

### AuthorizationPolicy

AuthorizationPolicy is the RBAC mechanism for Istio. It controls which workloads can communicate with each other and under what conditions. At the Envoy level, AuthorizationPolicy translates to the `envoy.filters.http.rbac` and `envoy.filters.network.rbac` filters.

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: <name>
  namespace: <namespace>       # applies to workloads in this namespace
spec:
  selector:                    # optional: target specific workloads
    matchLabels:
      app: my-service
  action: ALLOW | DENY | CUSTOM   # default: ALLOW
  provider:                    # only for action: CUSTOM
    name: my-ext-authz
  rules:
  - from:                      # source conditions (AND with 'to' and 'when')
    - source:
        principals: [...]      # SPIFFE identity
        namespaces: [...]
        ipBlocks: [...]
    to:                        # destination conditions
    - operation:
        methods: [...]
        paths: [...]
        ports: [...]
    when:                      # additional conditions
    - key: request.headers[x-custom-token]
      values: ["valid-token"]
```

#### Example: Deny-First Pattern (Recommended)

The deny-first pattern provides a deny-by-default posture:

```yaml
# 1. Deny all traffic by default (mesh-wide in istio-system)
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: deny-all
  namespace: istio-system      # mesh-wide scope
spec:
  {}                           # empty spec with no rules = deny everything

---
# 2. Allow specific traffic
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-frontend-to-api
  namespace: backend
spec:
  selector:
    matchLabels:
      app: api-server
  action: ALLOW
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/frontend/sa/webapp"]
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/api/*"]
```

> **Note:** An empty `spec: {}` with no `rules` means "match all traffic but have no allow rules." Since ALLOW policies exist (with zero matching rules), all traffic is denied. This is the standard deny-by-default pattern.

#### Example: Source-Based, Path-Based, and Header-Based Rules

```yaml
# Allow only requests from the "monitoring" namespace to /metrics
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-metrics-scrape
  namespace: my-app
spec:
  selector:
    matchLabels:
      app: my-service
  action: ALLOW
  rules:
  - from:
    - source:
        namespaces: ["monitoring"]
    to:
    - operation:
        paths: ["/metrics", "/stats/prometheus"]
        methods: ["GET"]

---
# Deny requests with a specific header (e.g., block internal testing header in prod)
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: deny-test-header
  namespace: production
spec:
  action: DENY
  rules:
  - when:
    - key: request.headers[x-test-request]
      values: ["true"]
```

#### Example: JWT-Claim-Based Authorization

```yaml
# Only allow requests with a valid JWT that has role=admin
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: require-admin-role
  namespace: admin-portal
spec:
  selector:
    matchLabels:
      app: admin-dashboard
  action: ALLOW
  rules:
  - from:
    - source:
        requestPrincipals: ["https://auth.example.com/*"]  # issuer must match
    when:
    - key: request.auth.claims[role]
      values: ["admin"]
    to:
    - operation:
        methods: ["GET", "POST", "PUT", "DELETE"]
```

The `request.auth.claims[...]` fields are populated by the `RequestAuthentication` resource's JWT validation (covered below). Without a corresponding `RequestAuthentication`, no JWT validation occurs and these claim-based rules never match.

### RequestAuthentication (JWT Validation)

RequestAuthentication configures Envoy to validate JWT tokens on incoming requests. It maps to the `envoy.filters.http.jwt_authn` filter in Envoy.

```yaml
apiVersion: security.istio.io/v1
kind: RequestAuthentication
metadata:
  name: jwt-auth
  namespace: my-app
spec:
  selector:
    matchLabels:
      app: api-server
  jwtRules:
  - issuer: "https://auth.example.com"
    jwksUri: "https://auth.example.com/.well-known/jwks.json"
    audiences:                                 # optional: restrict accepted audiences
    - "api.example.com"
    forwardOriginalToken: true                 # pass validated JWT to upstream app
    fromHeaders:                               # where to find the token
    - name: Authorization
      prefix: "Bearer "
    fromParams:                                # also check query param
    - "access_token"
    outputPayloadToHeader: "x-jwt-payload"     # optional: forward decoded payload
```

How JWT validation works at the Envoy filter level:

```
  Request arrives with Authorization: Bearer <token>
         │
         ▼
  jwt_authn filter extracts token from header/param
         │
         ▼
  Fetch JWKS from issuer's jwksUri
  (cached in Envoy, refreshed periodically)
         │
         ▼
  Validate JWT:
  - Signature verification (RS256, ES256, etc.)
  - Expiry check (exp claim)
  - Issuer match (iss claim)
  - Audience match (aud claim, if configured)
         │
         ├── Invalid → 401 Unauthorized
         │
         └── Valid → Extract claims to Envoy filter metadata
                     (available to downstream filters like RBAC)
```

**Key behavior**: If a request has **no JWT token at all**, `RequestAuthentication` does **not reject it**. It only rejects requests with **invalid** tokens. To require a token, you must pair it with an `AuthorizationPolicy` that demands specific JWT claims (e.g., `requestPrincipals` must be non-empty).

This two-resource pattern is intentional -- it separates authentication (is the token valid?) from authorization (is this identity allowed?).

#### Integration with External Identity Providers

RequestAuthentication works with any OIDC-compliant provider that publishes a JWKS endpoint:

| Provider | jwksUri Example |
|----------|----------------|
| Auth0 | `https://YOUR_DOMAIN.auth0.com/.well-known/jwks.json` |
| Keycloak | `https://keycloak.example.com/realms/myrealm/protocol/openid-connect/certs` |
| Google | `https://www.googleapis.com/oauth2/v3/certs` |
| Azure AD | `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys` |
| Okta | `https://YOUR_DOMAIN.okta.com/oauth2/default/v1/keys` |

### External Authorization (ext_authz)

For authorization logic too complex for static RBAC rules (e.g., checking a database, evaluating OPA policies, calling a custom decision service), Istio supports delegating authorization to an external service via the `ext_authz` Envoy filter.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    EXT_AUTHZ FLOW                                        │
│                                                                          │
│  Request arrives at Envoy                                                │
│         │                                                                │
│         ▼                                                                │
│  ext_authz filter activated                                              │
│  (before RBAC filter in the chain)                                       │
│         │                                                                │
│         │  gRPC call (or HTTP call) to external service:                 │
│         │  - sends: source IP, headers, path, method,                    │
│         │    SNI, peer cert, request body (if configured)                │
│         ▼                                                                │
│  ┌───────────────────────────────────────┐                              │
│  │  External Authz Service               │                              │
│  │  (e.g., OPA, custom Go/Python svc)    │                              │
│  │                                        │                              │
│  │  Evaluates policy:                     │                              │
│  │  - Query OPA Rego policies             │                              │
│  │  - Check database / Redis              │                              │
│  │  - Multi-tenant authorization          │                              │
│  │  - Rate limiting with custom logic     │                              │
│  │                                        │                              │
│  │  Returns:                              │                              │
│  │  - OK (200) → request continues        │                              │
│  │  - Denied (403) → request rejected     │                              │
│  │  - Can add/remove headers              │                              │
│  └──────────────────┬────────────────────┘                              │
│                     │                                                    │
│                     ▼                                                    │
│  Envoy receives decision                                                │
│  ├── ALLOW → proceed to RBAC → ALLOW evaluation → route to upstream     │
│  └── DENY  → return 403 to client immediately                          │
└─────────────────────────────────────────────────────────────────────────┘
```

Configuring ext_authz in Istio:

```yaml
# 1. Register the ext_authz provider in MeshConfig
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
  meshConfig:
    extensionProviders:
    - name: "opa-authz"
      envoyExtAuthzGrpc:
        service: "opa.opa-system.svc.cluster.local"
        port: 9191
        # optional: include request body in authz check
        includeRequestBodyInCheck:
          maxRequestBytes: 4096
          allowPartialMessage: true

---
# 2. AuthorizationPolicy with CUSTOM action
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: opa-authz
  namespace: my-app
spec:
  selector:
    matchLabels:
      app: api-server
  action: CUSTOM
  provider:
    name: opa-authz                # references the meshConfig provider
  rules:
  - to:
    - operation:
        paths: ["/api/*"]          # only trigger ext_authz for /api/ paths
```

The ext_authz service must implement either the Envoy `envoy.service.auth.v3.Authorization` gRPC interface or a simple HTTP check interface (Envoy sends the request headers as-is to the HTTP endpoint).

---

## Extensibility

Istio exposes several mechanisms for extending Envoy's behavior beyond what the built-in Istio CRDs offer. These range from safe, supported APIs (WasmPlugin, Telemetry) to low-level escape hatches (EnvoyFilter).

### Wasm (WebAssembly) Plugins

WebAssembly allows extending Envoy with custom filter logic written in Go, Rust, C++, or AssemblyScript, compiled to a `.wasm` binary. Envoy loads and executes the Wasm module in a sandboxed VM (V8 or Wasmtime) inside the proxy process.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    WASM PLUGIN LIFECYCLE                                   │
│                                                                           │
│  Developer writes plugin                                                  │
│  (Go with proxy-wasm-go-sdk,                                             │
│   Rust with proxy-wasm-rust-sdk)                                         │
│         │                                                                 │
│         ▼                                                                 │
│  Compile to .wasm binary                                                 │
│         │                                                                 │
│         ▼                                                                 │
│  Push to OCI registry                                                    │
│  (e.g., ghcr.io/myorg/my-plugin:v1)                                     │
│         │                                                                 │
│         ▼                                                                 │
│  Create WasmPlugin CRD                                                   │
│         │                                                                 │
│         ▼                                                                 │
│  istiod translates to Envoy Wasm filter config                           │
│  pushes via LDS/xDS                                                      │
│         │                                                                 │
│         ▼                                                                 │
│  Envoy downloads .wasm from OCI registry                                 │
│  (via istio-agent, cached locally)                                       │
│         │                                                                 │
│         ▼                                                                 │
│  Envoy loads .wasm into V8/Wasmtime sandbox                              │
│  Inserts filter into HTTP filter chain                                   │
│         │                                                                 │
│         ▼                                                                 │
│  Plugin executes on every matching request                               │
│  (decodeHeaders, decodeBody, encodeHeaders, encodeBody callbacks)        │
└──────────────────────────────────────────────────────────────────────────┘
```

```yaml
apiVersion: extensions.istio.io/v1alpha1
kind: WasmPlugin
metadata:
  name: custom-header-plugin
  namespace: my-app
spec:
  selector:
    matchLabels:
      app: my-service
  url: oci://ghcr.io/myorg/header-plugin:v1.2.0   # OCI image with .wasm
  phase: AUTHN                   # where in the filter chain to insert
                                 # AUTHN (before authn), AUTHZ (before authz),
                                 # STATS (before stats), UNSPECIFIED (before router)
  pluginConfig:                  # plugin-specific config (passed as JSON)
    header_name: "x-custom-id"
    header_value: "injected-by-wasm"
  imagePullPolicy: IfNotPresent  # Always, IfNotPresent, Never
  match:                         # optional: only apply to specific traffic
  - mode: SERVER                 # SERVER (inbound), CLIENT (outbound), or UNDEFINED (both)
    ports:
    - number: 8080
```

**Performance characteristics**: Wasm plugins add latency compared to native C++ filters. Typical overhead is 10-50 microseconds per filter invocation for simple logic (header reads/writes). Computationally heavy plugins (parsing large request bodies, regex evaluation) can add significantly more. For extremely latency-sensitive paths, native C++ filters are preferred, but Wasm provides a safe, portable alternative that does not require recompiling Envoy.

**Use cases**: Custom metrics emission, header injection/transformation, request routing based on custom logic, token exchange/transformation, request body validation, A/B testing cookie assignment.

### EnvoyFilter

EnvoyFilter is a low-level CRD that directly patches the Envoy configuration generated by Istio. It is an **escape hatch** for configuring Envoy features not exposed through Istio's higher-level CRDs (VirtualService, DestinationRule, AuthorizationPolicy, etc.).

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: add-lua-filter
  namespace: my-app
spec:
  workloadSelector:
    labels:
      app: my-service
  configPatches:
  - applyTo: HTTP_FILTER                    # what to patch
    match:
      context: SIDECAR_INBOUND              # SIDECAR_INBOUND, SIDECAR_OUTBOUND,
                                            # GATEWAY, ANY
      listener:
        filterChain:
          filter:
            name: envoy.filters.network.http_connection_manager
            subFilter:
              name: envoy.filters.http.router    # insert before router
    patch:
      operation: INSERT_BEFORE               # ADD, REMOVE, MERGE, REPLACE,
                                             # INSERT_BEFORE, INSERT_AFTER,
                                             # INSERT_FIRST
      value:
        name: envoy.filters.http.lua
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua
          inline_code: |
            function envoy_on_request(request_handle)
              request_handle:headers():add("x-custom-header", "hello-from-lua")
            end
```

Patch operations:

| Operation | Description |
|-----------|-------------|
| `ADD` | Add a new resource (listener, cluster, filter) |
| `REMOVE` | Remove a matched resource |
| `MERGE` | Deep-merge the patch value into the matched resource |
| `REPLACE` | Replace the matched resource entirely |
| `INSERT_BEFORE` | Insert a filter before the matched filter |
| `INSERT_AFTER` | Insert a filter after the matched filter |
| `INSERT_FIRST` | Insert a filter at the beginning of the chain |

`applyTo` targets:

| Value | What It Patches |
|-------|----------------|
| `LISTENER` | Top-level listener config |
| `FILTER_CHAIN` | Filter chain within a listener |
| `NETWORK_FILTER` | Network-level filter in a chain |
| `HTTP_FILTER` | HTTP filter within HCM |
| `ROUTE_CONFIGURATION` | RDS route config |
| `VIRTUAL_HOST` | Virtual host within a route config |
| `HTTP_ROUTE` | Specific route entry |
| `CLUSTER` | CDS cluster config |
| `EXTENSION_CONFIG` | ECDS extension config |

> **Warning:** EnvoyFilter patches are brittle. They reference internal Envoy config structures that can change across Istio versions. An EnvoyFilter that works on Istio 1.20 may silently fail or cause crashes on Istio 1.22 if the generated config structure changed. Always prefer WasmPlugin, Telemetry, or higher-level CRDs when possible. Use EnvoyFilter only as a last resort, and pin your Istio version in CI tests for any EnvoyFilter resources.

### Lua Filters

Lua filters provide lightweight inline scripting for quick customizations without the overhead of compiling and distributing a Wasm binary. They are typically injected via EnvoyFilter (as shown above).

Lua scripts have access to:

- Request/response headers (read and modify)
- Request/response body (read and modify, with buffering)
- Dynamic metadata (read and write, for passing data between filters)
- Logging
- Making async HTTP calls to upstream clusters

```lua
-- Example: Add response time header and log slow requests
function envoy_on_request(request_handle)
  request_handle:headers():add("x-request-start", tostring(os.clock()))
end

function envoy_on_response(response_handle)
  local start = tonumber(response_handle:headers():get("x-request-start"))
  if start then
    local duration = os.clock() - start
    response_handle:headers():add("x-response-time-ms", tostring(duration * 1000))
    if duration > 1.0 then
      response_handle:logWarn("Slow request: " .. tostring(duration) .. "s")
    end
  end
end
```

**Limitation**: Lua filters run in a coroutine per request. They are single-threaded within the worker and must not block. For complex logic, Wasm plugins or ext_authz are preferred.

### Telemetry API

The Telemetry API is Istio's CRD for configuring observability per-workload, per-namespace, or mesh-wide. It provides a declarative way to configure metrics, tracing, and access logging without resorting to EnvoyFilter.

```yaml
apiVersion: telemetry.istio.io/v1
kind: Telemetry
metadata:
  name: mesh-telemetry
  namespace: istio-system         # mesh-wide when in istio-system
spec:
  # --- Tracing configuration ---
  tracing:
  - providers:
    - name: opentelemetry          # registered in meshConfig.extensionProviders
    randomSamplingPercentage: 5.0
    disableSpanReporting: false
    customTags:
      cluster_name:
        environment:
          name: CLUSTER_NAME

  # --- Metrics configuration ---
  metrics:
  - providers:
    - name: prometheus
    overrides:
    - match:
        metric: ALL_METRICS
        mode: CLIENT_AND_SERVER
      tagOverrides:
        request_method:
          operation: UPSERT
          value: "request.method"

  # --- Access log configuration ---
  accessLogging:
  - providers:
    - name: envoy                  # file-based (stdout)
    filter:
      expression: "response.code >= 400"  # only log errors
  - providers:
    - name: otel-als               # gRPC ALS to OTel Collector
```

The Telemetry API scoping rules:

- **Mesh-wide**: Telemetry resource in `istio-system` namespace with no `selector`
- **Namespace-wide**: Telemetry resource in a target namespace with no `selector`
- **Workload-specific**: Telemetry resource with a `selector.matchLabels`
- **Inheritance**: Workload > Namespace > Mesh. More specific configs override less specific ones.

---

## See also

- [[notes/Networking/tls-1.3-handshake|TLS 1.3 Handshake]] -- mTLS in Istio uses TLS under the hood
- [[notes/Networking/docker-proxy-networking-in-k8s|Docker Proxy Networking in K8s]] -- iptables and network namespaces context
- [[notes/K8s/daemonset-pod-race-conditions|DaemonSet Pod Race Conditions]] -- relevant to istio-init race conditions
- [Istio Architecture (official docs)](https://istio.io/latest/docs/ops/deployment/architecture/)
- [Envoy xDS Protocol (official docs)](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol)
- [Istio Security Concepts (mTLS, SPIFFE)](https://istio.io/latest/docs/concepts/security/)
- [Istio Traffic Management Concepts](https://istio.io/latest/docs/concepts/traffic-management/)
- [Istio Ambient Mode Overview](https://istio.io/latest/docs/ambient/overview/)
- [Istio Ambient Data Plane Architecture](https://istio.io/latest/docs/ambient/architecture/data-plane/)
- [SPIFFE Standard](https://spiffe.io/)
- [Envoy Listener Architecture](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/listeners/listeners)
- [Istio Debugging (proxy-cmd)](https://istio.io/latest/docs/ops/diagnostic-tools/proxy-cmd/)
- [Tetrate: iptables Rules in Istio Sidecar Explained](https://tetrate.io/blog/traffic-types-and-iptables-rules-in-istio-sidecar-explained)
- [Jimmy Song: Sidecar Injection, Traffic Intercepting & Routing](https://jimmysong.io/en/blog/sidecar-injection-iptables-and-traffic-routing/)
- [Envoy Threading Model (official docs)](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/intro/threading_model)
- [Envoy Hot Restart (official docs)](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/operations/hot_restart)
- [Envoy HTTP Filter Chain (official docs)](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/http/http_filters)
- [Envoy Connection Pooling](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/connection_pooling)
- [Envoy Outlier Detection](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier)
- [Istio Observability (official docs)](https://istio.io/latest/docs/concepts/observability/)
- [Istio Standard Metrics Reference](https://istio.io/latest/docs/reference/config/metrics/)
- [Istio Distributed Tracing](https://istio.io/latest/docs/tasks/observability/distributed-tracing/)
- [Istio AuthorizationPolicy Reference](https://istio.io/latest/docs/reference/config/security/authorization-policy/)
- [Istio RequestAuthentication Reference](https://istio.io/latest/docs/reference/config/security/request_authentication/)
- [Istio External Authorization](https://istio.io/latest/docs/tasks/security/authorization/authz-custom/)
- [Istio WasmPlugin Reference](https://istio.io/latest/docs/reference/config/proxy_extensions/wasm-plugin/)
- [Istio Telemetry API Reference](https://istio.io/latest/docs/reference/config/telemetry/)
- [Istio EnvoyFilter Reference](https://istio.io/latest/docs/reference/config/networking/envoy-filter/)
- [Kiali (official site)](https://kiali.io/)
- [Proxy-Wasm Spec (ABI)](https://github.com/proxy-wasm/spec)
- [[notes/AuthNZ/OIDC_Oauth|OIDC & OAuth]] -- JWT validation and OIDC fundamentals for RequestAuthentication

---

## Interview Prep

### Q: What is the difference between Istio and Envoy?

**A:** Envoy is a standalone, high-performance L4/L7 proxy written in C++ by Lyft. It handles the actual data plane work: accepting connections, load balancing, applying retries/timeouts, terminating TLS, and collecting metrics. Envoy has no opinion about how it gets configured -- it exposes the xDS API for dynamic configuration.

Istio is the control plane that manages a fleet of Envoy proxies. It watches Kubernetes resources (Services, Endpoints, VirtualService, DestinationRule, PeerAuthentication), translates them into Envoy-native configuration, and pushes that configuration to every sidecar proxy via xDS. Istio also acts as a Certificate Authority, issuing SPIFFE X.509 certificates to each proxy for mTLS.

The `istio-proxy` container in each pod contains the Envoy binary plus `pilot-agent`, a helper process that generates Envoy's bootstrap config, manages its lifecycle, fetches certificates from istiod, and serves them to Envoy via the local SDS API.

---

### Q: How does traffic interception work without application changes?

**A:** Istio uses Linux iptables rules in the NAT table to transparently redirect all TCP traffic through the Envoy sidecar. When a pod is created, the `istio-init` init container (or the Istio CNI plugin) installs iptables rules in the pod's network namespace:

- **Inbound**: The PREROUTING chain redirects all incoming TCP to port 15006 (Envoy's VirtualInbound listener), except for Envoy's own ports (15090, 15021, 15020).
- **Outbound**: The OUTPUT chain redirects all outgoing TCP to port 15001 (Envoy's VirtualOutbound listener), except traffic from UID 1337 (Envoy itself, to prevent infinite loops) and traffic to localhost.

The application connects to `reviews:8080` normally. The kernel intercepts the SYN packet via iptables, redirects it to Envoy on port 15001. Envoy reads the original destination from `SO_ORIGINAL_DST`, applies routing rules, selects an upstream endpoint, and opens a new connection (as UID 1337, which bypasses iptables). The application is completely unaware.

---

### Q: Walk through a request lifecycle end-to-end in an Istio mesh.

**A:** Suppose Service A's app sends `GET /api/reviews` to `reviews:8080`:

1. **App A** calls `connect("reviews:8080")`. The kernel resolves this to the ClusterIP (e.g., 10.96.5.100).
2. **Kernel (Pod A)**: The OUTPUT chain catches the SYN packet. iptables checks: not from UID 1337, not to localhost → redirects to 127.0.0.1:15001.
3. **Envoy outbound (Pod A, port 15001)**: Accepts the connection, reads the original destination (10.96.5.100:8080) via `SO_ORIGINAL_DST`. Matches it against its route table (from RDS). The route says cluster `outbound|8080||reviews.default.svc.cluster.local`. EDS provides the healthy endpoints. Load balancer picks Pod B (10.48.2.15:8080). Envoy applies DestinationRule policies (retries, circuit breaker). Initiates mTLS with Pod B's Envoy using its SPIFFE certificate. Sends the HTTP request over the encrypted connection.
4. **Network**: Packet travels from Pod A to Pod B (via CNI, possibly across nodes).
5. **Kernel (Pod B)**: The PREROUTING chain catches the incoming packet. iptables redirects to 127.0.0.1:15006.
6. **Envoy inbound (Pod B, port 15006)**: Accepts the connection, terminates mTLS, verifies Pod A's SPIFFE identity, evaluates AuthorizationPolicy (RBAC). If allowed, forwards to `127.0.0.1:8080` (the local app). This connection is from UID 1337, so iptables lets it pass.
7. **App B** receives the plain HTTP request on port 8080, processes it, and sends the response back through the same path in reverse.

---

### Q: How does mTLS work in Istio? How are certificates managed?

**A:** Istio uses SPIFFE X.509 certificates for mutual TLS. The flow:

1. When a pod starts, `pilot-agent` in the `istio-proxy` container reads the pod's projected Kubernetes service account token.
2. `pilot-agent` generates a private key locally and creates a CSR (Certificate Signing Request) with the SPIFFE ID `spiffe://cluster.local/ns/<namespace>/sa/<service-account>`.
3. It sends the CSR + SA token to istiod over gRPC (port 15012).
4. istiod validates the SA token via the Kubernetes TokenReview API, then signs the CSR using its CA. The resulting certificate has a short TTL (default 24 hours).
5. `pilot-agent` serves the certificate and private key to Envoy over a local Unix domain socket using the SDS (Secret Discovery Service) API.
6. Envoy uses the cert for both inbound (server-side mTLS) and outbound (client-side mTLS) connections.
7. `pilot-agent` monitors expiration and rotates the cert before it expires -- no restart needed, SDS hot-swaps it.

The private key never leaves the pod. istiod only sees the CSR (public key + identity request), not the private key. PeerAuthentication policies control whether mTLS is STRICT (required), PERMISSIVE (accept both), or DISABLE.

---

### Q: What is the xDS protocol? Name and explain each xDS API.

**A:** xDS (Extensible Discovery Service) is the gRPC-based protocol Envoy uses to receive dynamic configuration from a management server. In Istio, istiod is the xDS server. Each Envoy maintains a persistent gRPC stream and receives real-time updates.

The six APIs:

- **LDS (Listener Discovery Service)**: Configures Envoy listeners -- what addresses/ports to bind, which filter chains to use. In Istio, the VirtualInbound (15006) and VirtualOutbound (15001) listeners are configured via LDS.
- **RDS (Route Discovery Service)**: Configures HTTP route tables -- virtual hosts, route match rules, weighted destinations, retries, timeouts. VirtualService resources map to RDS.
- **CDS (Cluster Discovery Service)**: Configures upstream clusters -- load balancing policy, circuit breakers, outlier detection, TLS context. DestinationRule resources map to CDS.
- **EDS (Endpoint Discovery Service)**: Provides the actual IP:port endpoints for each cluster, along with health status, locality, and weight. Kubernetes Endpoints/EndpointSlices map to EDS.
- **SDS (Secret Discovery Service)**: Delivers TLS certificates and private keys, plus trusted CA bundles. Used for mTLS cert rotation without proxy restart.
- **ADS (Aggregated Discovery Service)**: A single gRPC stream that multiplexes all resource types. Istio always uses ADS to ensure safe ordering: CDS -> EDS -> LDS -> RDS. This prevents traffic blackholes from partial configuration.

Istio 1.22+ defaults to **Delta xDS** (incremental), which sends only changed resources instead of the full set -- critical for meshes with thousands of endpoints.

---

### Q: What happens if istiod goes down?

**A:** Existing Envoy proxies continue operating with their last-known configuration cached in memory. Traffic keeps flowing with the most recent routing rules, mTLS settings, and endpoints.

However, several things break:

- **No config updates**: New VirtualService/DestinationRule changes are not pushed. Endpoint changes (pods scaling up/down) are not propagated -- proxies use stale endpoint lists.
- **Certificate rotation stops**: When existing certificates expire (default 24h TTL), mTLS handshakes fail and service-to-service communication breaks.
- **No new sidecar injection**: The mutating webhook is unavailable, so new pods are created without sidecars.
- **No new proxy bootstrapping**: Newly restarted proxies cannot fetch their initial configuration.

This is why production deployments run multiple istiod replicas (typically 2-3). istiod is stateless and reconstructs all state from the Kubernetes API server on startup. Recovery after restart is automatic -- proxies reconnect and receive a full configuration push.

---

### Q: Explain sidecar injection. What is a mutating admission webhook?

**A:** A Mutating Admission Webhook is a Kubernetes extension point that intercepts API requests (like pod creation) before they are persisted to etcd. The API server sends the pod spec to a registered webhook endpoint, which can modify (mutate) the spec and return it.

Istio registers a MutatingWebhookConfiguration that targets pod creation in namespaces labeled `istio-injection=enabled` (or `istio.io/rev=<tag>`). When a pod is created:

1. The API server sends the pod spec to istiod's webhook endpoint (port 15017).
2. istiod checks the namespace label and any pod-level annotations.
3. If injection is enabled, istiod mutates the pod spec by adding: (a) an `istio-init` init container that runs `istio-iptables` to set up traffic interception rules, (b) an `istio-proxy` sidecar container with Envoy + pilot-agent, (c) volumes for config, SDS socket, and projected service account tokens.
4. The mutated pod spec is returned to the API server and persisted.

The injection is entirely at the Kubernetes API level -- existing Deployments and Helm charts don't need changes. To disable injection for a specific pod, annotate it with `sidecar.istio.io/inject: "false"`.

---

### Q: What is the Kubernetes Gateway API and how does Istio use it? How does it differ from the Istio Gateway CRD?

**A:** The Kubernetes Gateway API (`gateway.networking.k8s.io`) is a SIG-Network standard that provides a role-oriented, portable API for managing ingress and mesh traffic. It has three core resources:

- **GatewayClass**: Defines the controller implementation (e.g., `istio.io/gateway-controller`). Managed by infrastructure providers.
- **Gateway**: Configures listeners (ports, TLS, hostname matching, allowed routes). Managed by cluster operators.
- **HTTPRoute** (also GRPCRoute, TCPRoute, TLSRoute): Defines routing rules and backends. Managed by application developers.

Key differences from the Istio Gateway CRD:

1. **Automated provisioning**: When you create a Gateway API `Gateway` resource, Istio automatically creates the Envoy Deployment, Service, and ServiceAccount. With the Istio CRD, you had to manually deploy `istio-ingressgateway`.
2. **Role separation**: The three-tier model (GatewayClass → Gateway → Route) cleanly separates infrastructure, platform, and application concerns. The Istio CRD mixed these -- the same team often managed both Gateway and VirtualService.
3. **Cross-namespace safety**: The Gateway API requires explicit `allowedRoutes` on the Gateway and `ReferenceGrant` for cross-namespace references. The Istio CRD allowed implicit cross-namespace binding.
4. **Status feedback**: HTTPRoute reports rich status conditions (Accepted, ResolvedRefs) per parent Gateway. The Istio VirtualService had limited status reporting.
5. **Portability**: Gateway API works across Istio, Envoy Gateway, Cilium, and other implementations. The Istio CRD is Istio-specific.

Istio adopted the Gateway API as the **recommended** API starting with 1.16, reaching GA in 1.22+. The Istio CRD is not deprecated but all new documentation defaults to the Gateway API.

In Ambient mode, waypoint proxies are also managed via Gateway API using `gatewayClassName: istio-waypoint`, unifying both ingress and mesh-internal L7 proxies under one API.

---

### Q: What is Istio Ambient Mode and why was it introduced?

**A:** Ambient mode is a sidecar-less data plane architecture that addresses the main pain points of sidecar injection: high resource overhead (one Envoy per pod), operational complexity (pod restarts needed for injection, init container race conditions), and the blast radius of sidecar failures.

Ambient mode splits the data plane into two layers:

**ztunnel (Zero Trust Tunnel)**: A lightweight Rust-based L4 proxy deployed as a DaemonSet (one per node). It handles mTLS encryption, L4 authorization, and TCP telemetry. Traffic between ztunnels is tunneled over HBONE (HTTP CONNECT over mTLS with HTTP/2 multiplexing). ztunnel creates listening sockets inside each pod's network namespace via the Istio CNI agent, so no iptables REDIRECT rules or init containers are needed.

**Waypoint Proxy**: An optional Envoy-based deployment (per-namespace or per-service) that provides L7 features: HTTP routing, header-based authorization, retries, fault injection, traffic splitting. Only deployed when L7 processing is actually needed.

The key insight is that most services only need L4 security (mTLS + basic authz), so the L7 overhead of a full Envoy sidecar is wasted. Ambient mode reports 90%+ memory reduction compared to sidecar mode. Pods don't need to restart to join the mesh -- just label the namespace.

---

### Q: What are common Istio debugging techniques?

**A:** The primary debugging tools:

1. **`istioctl proxy-status`** (or `istioctl ps`): Shows whether each proxy is SYNCED or STALE with istiod. STALE means a config push failed or the proxy is disconnected.
2. **`istioctl proxy-config`** (or `istioctl pc`): Dumps the actual Envoy configuration for a specific proxy. Sub-commands: `listeners` (LDS), `routes` (RDS), `clusters` (CDS), `endpoints` (EDS), `all` (full config dump). Use `-o json` for full detail. Example: `istioctl pc routes deploy/my-app` shows exactly which routes Envoy has.
3. **Envoy Admin API** (port 15000): `kubectl port-forward deploy/my-app 15000:15000`, then `curl localhost:15000/config_dump` for the full config, `/clusters` for upstream health, `/stats` for metrics counters. You can change log levels at runtime with `/logging?level=debug`.
4. **iptables inspection**: `kubectl exec deploy/my-app -c istio-proxy -- iptables -t nat -S` to verify the NAT rules are correct.
5. **`istioctl analyze`**: Static analysis of Istio configuration in a namespace -- catches misconfigurations like missing DestinationRules for subsets referenced in VirtualServices.
6. **Access logs**: Enable Envoy access logging via MeshConfig (`accessLogFile: /dev/stdout`) to see every request with upstream/downstream details, response codes, and latency breakdowns.

---

### Q: How does Istio handle protocol detection?

**A:** Istio determines the protocol of a connection through three mechanisms, in priority order:

1. **Explicit declaration**: The Kubernetes Service port name starts with a recognized prefix (`http-`, `grpc-`, `tcp-`, etc.) or the `appProtocol` field is set. This is the most reliable method.
2. **HTTP inspection (auto-detection)**: If no protocol hint is available, Envoy's HTTP inspector filter reads the first bytes of the connection to determine if they look like HTTP. This works for client-first protocols (HTTP) but causes a detection timeout delay (up to 5 seconds by default) for server-first protocols like MySQL, where the server sends the first bytes. During this timeout, the connection appears to hang.
3. **Fallback to TCP**: If detection times out or fails, the traffic is treated as opaque TCP. No HTTP-level features (retries, header-based routing, HTTP metrics) are available.

The gotcha: if you forget to name your ports correctly, all HTTP traffic is treated as TCP. You get no HTTP metrics, no retries, no header-based routing. The symptom is subtle -- everything works, but mesh features silently don't apply. Always check with `istioctl proxy-config listeners deploy/my-app` to verify the filter chain type for each port.

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

---

### Q: What is the evaluation order of AuthorizationPolicy actions? What happens if you have CUSTOM, DENY, and ALLOW policies?

**A:** The evaluation order is strictly: **CUSTOM -> DENY -> ALLOW**.

```
  Request arrives
       │
       ▼
  CUSTOM policies evaluated ───► Any deny? ──► 403 (stop)
       │ (ext_authz call)              │
       │                               No
       ▼                               │
  DENY policies evaluated ────► Any match? ──► 403 (stop)
       │                               │
       │                               No
       ▼                               │
  ALLOW policies exist?                │
       │                               │
       ├── No ALLOW policies ─────────► ALLOW (implicit allow-all)
       │
       └── ALLOW policies exist ──► Any match? ──► ALLOW
                                        │
                                        No match ──► 403 (deny)
```

Critical nuances:

- If **no AuthorizationPolicy exists** at all for a workload, all traffic is allowed (implicit allow).
- If an ALLOW policy exists with **zero matching rules** (empty `spec: {}`), all traffic is denied. This is the standard deny-by-default pattern.
- DENY always wins over ALLOW. Even if an ALLOW rule matches, a matching DENY rule takes precedence.
- CUSTOM is evaluated first. If the ext_authz service denies, neither DENY nor ALLOW policies are consulted.

---

### Q: RequestAuthentication allows requests with no JWT token. Why? How do you require a token?

**A:** This is a deliberate design choice. `RequestAuthentication` only validates tokens that **are present**. If a request has no token, it passes through `RequestAuthentication` without error. If a request has an **invalid** token, it is rejected with 401.

The rationale is separation of concerns: authentication (is this token valid?) is separate from authorization (is this caller allowed?). To require a token, pair `RequestAuthentication` with an `AuthorizationPolicy`:

```yaml
# 1. Validate tokens if present
apiVersion: security.istio.io/v1
kind: RequestAuthentication
metadata:
  name: require-jwt
spec:
  jwtRules:
  - issuer: "https://auth.example.com"
    jwksUri: "https://auth.example.com/.well-known/jwks.json"

---
# 2. Require a valid principal (which only exists if a valid JWT was provided)
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: require-auth
spec:
  action: ALLOW
  rules:
  - from:
    - source:
        requestPrincipals: ["*"]   # at least one principal must exist
```

Without the AuthorizationPolicy, unauthenticated (no-token) requests pass through freely.

---

### Q: What is ext_authz? When would you use it over AuthorizationPolicy?

**A:** `ext_authz` (external authorization) delegates the authorization decision to an external service via gRPC or HTTP. Envoy sends request metadata (headers, path, source identity) to the external service and waits for an allow/deny response.

Use ext_authz when:
- Authorization logic requires database lookups, external API calls, or complex policy evaluation (e.g., OPA Rego policies)
- You need to implement multi-tenant authorization where policies vary per tenant
- You need to add custom response headers or transform the request based on authorization decisions
- Static RBAC rules in AuthorizationPolicy are insufficient

In Istio, ext_authz is triggered via `AuthorizationPolicy` with `action: CUSTOM`. The external service is registered as an `extensionProvider` in MeshConfig. The ext_authz filter executes **before** the RBAC filter in the Envoy chain, so CUSTOM decisions take priority over DENY and ALLOW policies.

---

### Q: How does distributed tracing work in Istio? What is the critical requirement for applications?

**A:** Each Envoy sidecar automatically generates a trace **span** for every request it proxies -- one span for the inbound side and one for the outbound side. Spans are tagged with source/destination metadata and sent to a tracing backend (Jaeger, Zipkin, OTel Collector).

```
  Svc A (Envoy) ──► Svc B (Envoy) ──► Svc C (Envoy)
  [Span: A→B]       [Span: B→C]

  These spans are linked by a shared trace ID passed via headers.
```

The **critical requirement**: Applications must propagate trace context headers (`x-request-id`, `x-b3-traceid`, `x-b3-spanid`, `x-b3-sampled`, `traceparent`) from incoming requests to all outgoing requests. Envoy cannot do this automatically because it does not understand the application-level relationship between an inbound request and the outbound calls it triggers. Without header propagation, each hop generates an independent trace -- multi-hop correlation is lost, and Jaeger shows disconnected single-span traces instead of a unified request tree.

---

### Q: What metrics does Istio generate automatically? How are they collected?

**A:** Istio generates standard metrics via the `istio.stats` Wasm filter in every Envoy proxy. The key metrics:

- `istio_requests_total` -- counter, broken down by source/destination workload, namespace, response code, protocol
- `istio_request_duration_milliseconds` -- histogram with buckets
- `istio_request_bytes` / `istio_response_bytes` -- size histograms
- `istio_tcp_sent_bytes_total` / `istio_tcp_received_bytes_total` -- TCP byte counters

These are exposed on each Envoy's `/stats/prometheus` endpoint on port 15090. Prometheus scrapes this port across all meshed pods (typically via PodMonitor or annotation-based discovery). Grafana dashboards then visualize the data.

Istio ships with standard Grafana dashboards: Mesh Dashboard (global overview), Service Dashboard (per-service), Workload Dashboard (per-workload), and Control Plane Dashboard (istiod health).

The Telemetry API (CRD) can customize metrics per-workload -- adding dimensions, disabling specific metrics, or changing tag values.

---

### Q: What is a WasmPlugin? When would you use it over an EnvoyFilter?

**A:** A WasmPlugin is an Istio CRD that loads a WebAssembly module into Envoy as an HTTP filter. The module runs in a sandboxed VM (V8/Wasmtime) and can inspect/modify requests and responses.

Use **WasmPlugin** when:
- You need custom logic (custom metrics, header transformation, request validation) not available via Istio CRDs
- You want a portable, safe extension that survives Istio upgrades
- You are willing to accept ~10-50 microsecond overhead per invocation

Use **EnvoyFilter** when:
- You need to configure an Envoy feature not exposed by any Istio API
- You need direct control over Envoy internals (e.g., changing listener bind config, adding bootstrap extensions)
- You accept the risk of breakage across Istio version upgrades

WasmPlugin is the preferred approach because it uses a stable ABI (proxy-wasm), is loaded via a supported Istio CRD, and does not patch raw Envoy config. EnvoyFilter is an escape hatch -- it directly manipulates generated Envoy config, which changes between Istio versions, making patches fragile.

---

### Q: What is the danger of using EnvoyFilter in production?

**A:** EnvoyFilter patches reference internal Envoy configuration structures generated by Istio. These structures are **not part of Istio's stable API** and can change between minor versions. The specific dangers:

1. **Silent breakage**: An EnvoyFilter that worked on Istio 1.20 may silently fail to match on 1.22 if the generated config structure changed. The patch applies to nothing, and the expected behavior is missing with no error.
2. **Hard to debug**: When EnvoyFilter patches go wrong, the symptoms are often subtle -- a missing filter, an incorrect route, or unexpected 503s. There is no straightforward validation tool.
3. **Ordering conflicts**: Multiple EnvoyFilters can conflict with each other, and their application order depends on creation timestamp and namespace, which is fragile.
4. **Upgrade blocker**: Teams with many EnvoyFilters often cannot upgrade Istio without extensive testing of every patch.

Best practice: always prefer WasmPlugin, Telemetry API, or higher-level CRDs. Reserve EnvoyFilter for features genuinely not exposed by any other API, and test them in CI against your target Istio version.