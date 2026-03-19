---
title: "Istio Service Mesh: Architecture, xDS, Sidecar Injection, Traffic Interception, and Ambient Mode"
---

## Overview

Istio is a service mesh that provides traffic management, security (mTLS, authorization), and observability for microservices running on Kubernetes. It works by injecting an Envoy sidecar proxy into every pod and managing those proxies from a centralized control plane called **istiod**. The application code requires zero changes -- all networking concerns (retries, timeouts, mutual TLS, traffic splitting) are handled transparently by the proxy layer.

This note covers the core architecture: control plane vs data plane, xDS protocol, sidecar injection, iptables traffic interception, the end-to-end request lifecycle, ambient mode, common gotchas, and debugging.

For detailed topic-specific notes, see:

- [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]] -- threading model, hot restart, filter pipeline, connection pooling, health checking, access logging
- [[notes/Networking/istio-traffic-management|Istio Traffic Management]] -- VirtualService, DestinationRule, Gateway API, traffic splitting
- [[notes/Networking/istio-security|Istio Security]] -- mTLS, SPIFFE, PeerAuthentication, AuthorizationPolicy, JWT, ext_authz
- [[notes/Networking/istio-observability-extensibility|Istio Observability & Extensibility]] -- metrics, tracing, Kiali, WasmPlugin, EnvoyFilter, Telemetry API

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

For deep dive into Envoy's internal architecture (threading, filters, connection pooling), see [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]].

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



```
  ┌───────────────────────────────┬───────────────────────────────────────────────────────────────────┐      
  │           Mechanism           │                             What for                              │
  ├───────────────────────────────┼───────────────────────────────────────────────────────────────────┤      
  │ UDS                           │ Pass the namespace fd (one-time control plane handoff)            │
  ├───────────────────────────────┼───────────────────────────────────────────────────────────────────┤      
  │ TCP sockets bound via setns() │ Ztunnel's listening ports inside pod's netns (data plane capture) │      
  ├───────────────────────────────┼───────────────────────────────────────────────────────────────────┤      
  │ Veth + IP networking          │ Actual traffic between pods/nodes                                 │      
  └───────────────────────────────┴───────────────────────────────────────────────────────────────────┘
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

## See also

- [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]] -- threading model, hot restart, filter pipeline, connection pooling, health checking
- [[notes/Networking/istio-traffic-management|Istio Traffic Management]] -- VirtualService, DestinationRule, Gateway API
- [[notes/Networking/istio-security|Istio Security]] -- mTLS, SPIFFE, AuthorizationPolicy, JWT, ext_authz
- [[notes/Networking/istio-observability-extensibility|Istio Observability & Extensibility]] -- metrics, tracing, Kiali, WasmPlugin, EnvoyFilter
- [[notes/Networking/tls-1.3-handshake|TLS 1.3 Handshake]] -- mTLS in Istio uses TLS under the hood
- [[notes/Networking/docker-proxy-networking-in-k8s|Docker Proxy Networking in K8s]] -- iptables and network namespaces context
- [[notes/K8s/daemonset-pod-race-conditions|DaemonSet Pod Race Conditions]] -- relevant to istio-init race conditions
- [Istio Architecture (official docs)](https://istio.io/latest/docs/ops/deployment/architecture/)
- [Envoy xDS Protocol (official docs)](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol)
- [Istio Ambient Mode Overview](https://istio.io/latest/docs/ambient/overview/)
- [Istio Ambient Data Plane Architecture](https://istio.io/latest/docs/ambient/architecture/data-plane/)
- [Istio Debugging (proxy-cmd)](https://istio.io/latest/docs/ops/diagnostic-tools/proxy-cmd/)
- [Tetrate: iptables Rules in Istio Sidecar Explained](https://tetrate.io/blog/traffic-types-and-iptables-rules-in-istio-sidecar-explained)
- [Jimmy Song: Sidecar Injection, Traffic Intercepting & Routing](https://jimmysong.io/en/blog/sidecar-injection-iptables-and-traffic-routing/)

---

## Interview Prep

### Q: How does traffic interception work without application changes?

**A:** Istio uses Linux iptables rules in the NAT table to transparently redirect all TCP traffic through the Envoy sidecar. When a pod is created, the `istio-init` init container (or the Istio CNI plugin) installs iptables rules in the pod's network namespace:

- **Inbound**: The PREROUTING chain redirects all incoming TCP to port 15006 (Envoy's VirtualInbound listener), except for Envoy's own ports (15090, 15021, 15020).
- **Outbound**: The OUTPUT chain redirects all outgoing TCP to port 15001 (Envoy's VirtualOutbound listener), except traffic from UID 1337 (Envoy itself, to prevent infinite loops) and traffic to localhost.

The application connects to `reviews:8080` normally. The kernel intercepts the SYN packet via iptables, redirects it to Envoy on port 15001. Envoy reads the original destination from `SO_ORIGINAL_DST`, applies routing rules, selects an upstream endpoint, and opens a new connection (as UID 1337, which bypasses iptables). The application is completely unaware.

---

### Q: Walk through a request lifecycle end-to-end in an Istio mesh.

**A:** Suppose Service A's app sends `GET /api/reviews` to `reviews:8080`:

1. **App A** calls `connect("reviews:8080")`. The kernel resolves this to the ClusterIP (e.g., 10.96.5.100).
2. **Kernel (Pod A)**: The OUTPUT chain catches the SYN packet. iptables checks: not from UID 1337, not to localhost -> redirects to 127.0.0.1:15001.
3. **Envoy outbound (Pod A, port 15001)**: Accepts the connection, reads the original destination (10.96.5.100:8080) via `SO_ORIGINAL_DST`. Matches it against its route table (from RDS). The route says cluster `outbound|8080||reviews.default.svc.cluster.local`. EDS provides the healthy endpoints. Load balancer picks Pod B (10.48.2.15:8080). Envoy applies DestinationRule policies (retries, circuit breaker). Initiates mTLS with Pod B's Envoy using its SPIFFE certificate. Sends the HTTP request over the encrypted connection.
4. **Network**: Packet travels from Pod A to Pod B (via CNI, possibly across nodes).
5. **Kernel (Pod B)**: The PREROUTING chain catches the incoming packet. iptables redirects to 127.0.0.1:15006.
6. **Envoy inbound (Pod B, port 15006)**: Accepts the connection, terminates mTLS, verifies Pod A's SPIFFE identity, evaluates AuthorizationPolicy (RBAC). If allowed, forwards to `127.0.0.1:8080` (the local app). This connection is from UID 1337, so iptables lets it pass.
7. **App B** receives the plain HTTP request on port 8080, processes it, and sends the response back through the same path in reverse.

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

### Q: What is Istio Ambient Mode and why was it introduced?

**A:** Ambient mode is a sidecar-less data plane architecture that addresses the main pain points of sidecar injection: high resource overhead (one Envoy per pod), operational complexity (pod restarts needed for injection, init container race conditions), and the blast radius of sidecar failures.

Ambient mode splits the data plane into two layers:

**ztunnel (Zero Trust Tunnel)**: A lightweight Rust-based L4 proxy deployed as a DaemonSet (one per node). It handles mTLS encryption, L4 authorization, and TCP telemetry. Traffic between ztunnels is tunneled over HBONE (HTTP CONNECT over mTLS with HTTP/2 multiplexing). ztunnel creates listening sockets inside each pod's network namespace via the Istio CNI agent, so no iptables REDIRECT rules or init containers are needed.

**Waypoint Proxy**: An optional Envoy-based deployment (per-namespace or per-service) that provides L7 features: HTTP routing, header-based authorization, retries, fault injection, traffic splitting. Only deployed when L7 processing is actually needed.

The key insight is that most services only need L4 security (mTLS + basic authz), so the L7 overhead of a full Envoy sidecar is wasted. Ambient mode reports 90%+ memory reduction compared to sidecar mode. Pods don't need to restart to join the mesh -- just label the namespace.

---

### Q: What are common Istio debugging techniques?

**A:** The primary debugging tools:

1. `**istioctl proxy-status`** (or `istioctl ps`): Shows whether each proxy is SYNCED or STALE with istiod. STALE means a config push failed or the proxy is disconnected.
2. `**istioctl proxy-config**` (or `istioctl pc`): Dumps the actual Envoy configuration for a specific proxy. Sub-commands: `listeners` (LDS), `routes` (RDS), `clusters` (CDS), `endpoints` (EDS), `all` (full config dump). Use `-o json` for full detail. Example: `istioctl pc routes deploy/my-app` shows exactly which routes Envoy has.
3. **Envoy Admin API** (port 15000): `kubectl port-forward deploy/my-app 15000:15000`, then `curl localhost:15000/config_dump` for the full config, `/clusters` for upstream health, `/stats` for metrics counters. You can change log levels at runtime with `/logging?level=debug`.
4. **iptables inspection**: `kubectl exec deploy/my-app -c istio-proxy -- iptables -t nat -S` to verify the NAT rules are correct.
5. `**istioctl analyze`**: Static analysis of Istio configuration in a namespace -- catches misconfigurations like missing DestinationRules for subsets referenced in VirtualServices.
6. **Access logs**: Enable Envoy access logging via MeshConfig (`accessLogFile: /dev/stdout`) to see every request with upstream/downstream details, response codes, and latency breakdowns.

---

### Q: How does Istio handle protocol detection?

**A:** Istio determines the protocol of a connection through three mechanisms, in priority order:

1. **Explicit declaration**: The Kubernetes Service port name starts with a recognized prefix (`http-`, `grpc-`, `tcp-`, etc.) or the `appProtocol` field is set. This is the most reliable method.
2. **HTTP inspection (auto-detection)**: If no protocol hint is available, Envoy's HTTP inspector filter reads the first bytes of the connection to determine if they look like HTTP. This works for client-first protocols (HTTP) but causes a detection timeout delay (up to 5 seconds by default) for server-first protocols like MySQL, where the server sends the first bytes. During this timeout, the connection appears to hang.
3. **Fallback to TCP**: If detection times out or fails, the traffic is treated as opaque TCP. No HTTP-level features (retries, header-based routing, HTTP metrics) are available.

The gotcha: if you forget to name your ports correctly, all HTTP traffic is treated as TCP. You get no HTTP metrics, no retries, no header-based routing. The symptom is subtle -- everything works, but mesh features silently don't apply. Always check with `istioctl proxy-config listeners deploy/my-app` to verify the filter chain type for each port.
