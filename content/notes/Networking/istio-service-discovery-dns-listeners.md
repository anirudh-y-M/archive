---
title: "Istio: Service Discovery, DNS Resolution, and Envoy Listener Architecture"
---

## Overview

This note covers three commonly misunderstood aspects of Istio's architecture: how service discovery works independently of mesh membership, how DNS resolution flows, and how Envoy's listener model routes traffic to the correct service. These topics are tightly linked — understanding one requires understanding the others.

For control plane architecture, see [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]]. For the Sidecar CRD's egress whitelisting, see [[notes/Networking/istio-traffic-management|Istio Traffic Management]].

---

## Service Discovery Is Independent of Mesh Membership

A common misconception is that a destination workload must have a sidecar (be "in the mesh") for Istio to know about it. **This is false.** istiod's service discovery is built entirely on top of Kubernetes, not mesh participation.

```
┌──────────────────────────────────────────────────────┐
│              Kubernetes API Server                    │
│                                                       │
│  Stores: Services, Endpoints/EndpointSlices           │
│  (populated by kube-controller-manager based          │
│   on pod label selectors — no sidecar needed)         │
└──────────────────┬───────────────────────────────────┘
                   │  watch/list
                   ▼
            ┌─────────────┐
            │   istiod     │  Watches K8s API for ALL
            │   (Pilot)    │  Services + Endpoints,
            │              │  regardless of sidecar presence
            └──────┬──────┘
                   │  xDS push (CDS, EDS)
                   ▼
        ┌──────────────────┐         ┌──────────────────┐
        │  Pod A (meshed)  │────────▶│  Pod B (no sidecar)│
        │  ┌────────────┐  │  plain  │                    │
        │  │Envoy proxy │  │  TCP    │  app container     │
        │  └────────────┘  │         │                    │
        └──────────────────┘         └──────────────────┘
```

**How it works:**

1. Kubernetes populates `Endpoints`/`EndpointSlices` for a Service based on **pod label selectors** — this mechanism has nothing to do with sidecars
2. istiod watches the K8s API server for Services + Endpoints (the same data `kube-proxy` uses)
3. istiod translates these into Envoy clusters (CDS) and endpoints (EDS) and pushes them to every connected sidecar
4. The client-side Envoy can load-balance across all destination pod IPs, even if none have sidecars

**What mesh membership actually affects** is not discovery, but capabilities:

| Capability | Destination in mesh | Destination NOT in mesh |
|---|---|---|
| Client-side load balancing | Works | Works |
| mTLS (STRICT) | Works (both have certs) | **Fails** — no sidecar to terminate TLS |
| mTLS (PERMISSIVE) | mTLS | Falls back to **plaintext** |
| Client-side policies (retries, timeouts) | Applied by client Envoy | Applied by client Envoy |
| Server-side policies (AuthorizationPolicy) | Enforced by dest Envoy | **Not enforced** — no sidecar |
| Server-side telemetry | Reported by dest Envoy | **Missing** — client-side only |

---

## Sidecar Egress Whitelisting and outboundTrafficPolicy

The [[notes/Networking/istio-traffic-management|Sidecar resource]]'s `egress.hosts` field controls which services istiod programs into a proxy's config. When a namespace is excluded, istiod does **not** push CDS/EDS/RDS for services in that namespace — the client Envoy literally doesn't know those services exist.

But **filtering config ≠ blocking traffic.** What happens to requests for unknown destinations depends on `outboundTrafficPolicy.mode`:

```
App resolves dest-svc.other-ns → ClusterIP 10.96.x.x (via kube-dns)
App connects to 10.96.x.x:80
    │
    │ iptables REDIRECT → Envoy (port 15001)
    ▼
Envoy: no matching cluster (Sidecar filtered it out)
    │
    ▼
┌───────────────────────────────────────────────┐
│  outboundTrafficPolicy.mode = ?               │
│                                               │
│  ALLOW_ANY (default)                          │
│  └─▶ PassthroughCluster                      │
│      Traffic goes through ✅                  │
│      (plain TCP, no L7 features,              │
│       no retries, no Istio metrics,           │
│       kube-proxy does the load balancing)     │
│                                               │
│  REGISTRY_ONLY                                │
│  └─▶ BlackHoleCluster                        │
│      Traffic blocked ❌                       │
│      (connection reset / 502)                 │
└───────────────────────────────────────────────┘
```

**To actually enforce Sidecar-based isolation**, you need one of:

```yaml
# Option 1: Set outboundTrafficPolicy to REGISTRY_ONLY
apiVersion: networking.istio.io/v1beta1
kind: Sidecar
metadata:
  name: default
  namespace: client-ns
spec:
  outboundTrafficPolicy:
    mode: REGISTRY_ONLY          # ← makes it enforcing
  egress:
  - hosts:
    - "istio-system/*"
    - "client-ns/*"
    # other-ns NOT listed → traffic to other-ns is BLOCKED
```

```yaml
# Option 2: Use AuthorizationPolicy (works regardless of outbound mode)
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: deny-other-ns
  namespace: client-ns
spec:
  action: DENY
  rules:
  - to:
    - operation:
        hosts: ["*.other-ns.svc.cluster.local"]
```

> **Gotcha:** Most teams set up Sidecar whitelisting expecting it to restrict traffic, but with the default `ALLOW_ANY`, it only removes Istio's **awareness** — the traffic falls through as a passthrough TCP connection. This is a common security misconfiguration.

---

## DNS Resolution in Istio

By default, **Envoy does not handle DNS.** The iptables rules Istio injects only redirect **TCP** traffic. DNS queries (UDP port 53) bypass Envoy entirely and go straight to kube-dns/CoreDNS.

```
┌────────────────────────────────────────────────────┐
│  Pod                                                │
│                                                     │
│  ┌──────────┐    DNS (UDP 53)    ┌──────────────┐  │
│  │   App    │───────────────────▶│  kube-dns /  │  │
│  │ container│  NOT intercepted   │  CoreDNS     │  │
│  └────┬─────┘  by iptables       └──────────────┘  │
│       │                                             │
│       │ TCP connect to resolved IP                  │
│       │ (iptables REDIRECT to port 15001)           │
│       ▼                                             │
│  ┌──────────┐                                       │
│  │  Envoy   │  ← only sees TCP/HTTP, not DNS        │
│  └──────────┘                                       │
└────────────────────────────────────────────────────┘
```

Envoy identifies the destination service **after** DNS resolution, using the resolved IP:

- **IP:port matching** — Envoy has a listener or filter chain for each known ClusterIP (from istiod's xDS push). When the app connects to `10.96.3.45:80`, Envoy matches it to the corresponding Envoy cluster.
- **Host header / SNI** — when multiple services share a listener (see next section), Envoy uses the HTTP `Host` header or TLS SNI to disambiguate.

### Istio DNS Proxying (Opt-In)

Since Istio ~1.8, `istio-agent` (pilot-agent, not Envoy) can optionally intercept DNS queries on port 15053:

```yaml
meshConfig:
  defaultConfig:
    proxyMetadata:
      ISTIO_META_DNS_CAPTURE: "true"
      ISTIO_META_DNS_AUTO_ALLOCATE: "true"
```

```
App ──DNS query──▶ istio-agent (localhost:15053)
                        │
                        ├─ Known in mesh (xDS cache)? → respond directly
                        │
                        └─ Unknown? → forward to kube-dns/CoreDNS
```

This exists mainly for:

- **ServiceEntry** destinations (external services with no ClusterIP) — without DNS proxying, there's no ClusterIP for Envoy to match on
- **Multi-cluster** — resolving services in remote clusters that don't exist in local kube-dns

| Scenario | Who resolves DNS? |
|---|---|
| Default Istio | **kube-dns/CoreDNS** — Envoy never sees DNS |
| DNS Proxying enabled | **istio-agent** intercepts, falls back to kube-dns |
| No mesh at all | **kube-dns/CoreDNS** |

---

## Envoy Shared Listeners and Service Disambiguation

### Per-IP vs Shared Listeners

When many Kubernetes services use the same port number (80, 443, 8080 — extremely common), Istio does **not** create a separate Envoy listener for each ClusterIP. Instead, it collapses them into a single **catch-all listener** on `0.0.0.0:<port>`:

```
Per-IP listeners (not what Istio does for same-port services):

  Listener 10.96.3.45:80  → cart-svc
  Listener 10.96.7.12:80  → payment-svc
  Listener 10.96.9.88:80  → order-svc

Shared listener (what Istio actually configures):

  Listener 0.0.0.0:80     → handles ALL port-80 traffic
                             must use Host/SNI to route
```

### How Host Header and SNI Disambiguate

```
┌──────────────────────────────────────────────────────┐
│  Listener: 0.0.0.0:80                                │
│                                                       │
│  Incoming request:                                    │
│  GET /checkout HTTP/1.1                               │
│  Host: cart-svc.default.svc.cluster.local   ◄── key  │
│                                                       │
│  Route table (from RDS):                              │
│                                                       │
│  Host == "cart-svc.default.svc..."                    │
│      → Envoy cluster: outbound|80||cart-svc           │
│                                                       │
│  Host == "payment-svc.default.svc..."                 │
│      → Envoy cluster: outbound|80||payment-svc        │
└──────────────────────────────────────────────────────┘
```

For **TLS traffic**, Envoy can't read the Host header (encrypted), so it uses **SNI** (Server Name Indication) — a field sent in the TLS ClientHello before encryption begins:

```
HTTP:   GET / HTTP/1.1
        Host: cart-svc.default.svc.cluster.local    ← Host header

TLS:    ClientHello { SNI: cart-svc.default.svc.cluster.local }  ← SNI
```

### Envoy Cluster ≠ Kubernetes Cluster

In Envoy terminology, a **cluster** is a logical group of backend endpoints (pod IPs) for a single destination — it's Envoy's internal representation of a Kubernetes Service:

```
Envoy Cluster: "outbound|80||cart-svc.default.svc.cluster.local"

  Endpoints (from EDS):
    - 10.244.1.5:80   (pod 1)
    - 10.244.2.9:80   (pod 2)
    - 10.244.3.2:80   (pod 3)
```

### Which Mechanism Applies When

| Traffic type | How Envoy identifies destination |
|---|---|
| HTTP to a unique ClusterIP | IP:port match (Host available but not strictly needed) |
| HTTP through shared listener (0.0.0.0) | **Host header** — required to disambiguate |
| TLS / mTLS passthrough | **SNI** — only readable field without decrypting |
| Plain TCP (non-HTTP) | IP:port only — no Host or SNI available |

### Inspecting Listeners and Routes

```bash
# See listeners — typically shows 0.0.0.0 for common ports
istioctl proxy-config listeners <pod> --port 80

# See route table — shows Host → cluster mapping
istioctl proxy-config routes <pod> --name 80

# See clusters (Envoy clusters, not K8s clusters)
istioctl proxy-config clusters <pod>

# See endpoints for a specific cluster
istioctl proxy-config endpoints <pod> --cluster "outbound|80||cart-svc.default.svc.cluster.local"
```

---

## See also

- [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]] — control plane, xDS, sidecar injection, iptables
- [[notes/Networking/istio-traffic-management|Istio Traffic Management]] — Sidecar resource, VirtualService, DestinationRule
- [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]] — filter pipeline, VirtualOutbound/VirtualInbound listeners
- [[notes/Networking/istio-security|Istio Security]] — mTLS, PeerAuthentication modes (STRICT vs PERMISSIVE)
- [Istio Sidecar API Reference](https://istio.io/latest/docs/reference/config/networking/sidecar/)
- [Istio DNS Proxying](https://istio.io/latest/docs/ops/configuration/traffic-management/dns-proxy/)
- [Envoy Listener Architecture](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/listeners/listeners)

---

## Interview Prep

### Q: A deployment with Istio sidecar sends requests to a service whose pods have no sidecar. Does client-side load balancing work?

**A:** Yes. istiod gets endpoint information from the **Kubernetes API server** (Services, Endpoints/EndpointSlices), not from sidecars. Kubernetes populates Endpoints based on pod label selectors — completely independent of sidecar presence. So the client's Envoy receives all destination pod IPs via EDS and can load-balance across them.

What won't work without a destination sidecar: mTLS in STRICT mode (no sidecar to terminate TLS), server-side AuthorizationPolicy enforcement, and server-side telemetry. In PERMISSIVE mode, the client Envoy automatically falls back to plaintext.

---

### Q: You've configured a Sidecar resource to whitelist only certain namespaces. Is traffic to non-whitelisted namespaces blocked?

**A:** Not necessarily — it depends on `outboundTrafficPolicy.mode`:

```
Sidecar egress whitelist excludes "other-ns"
    │
    ├─ outboundTrafficPolicy: ALLOW_ANY (default)
    │   └─ Traffic STILL goes through via PassthroughCluster
    │      (plain TCP passthrough, no L7 features, no Istio metrics)
    │
    └─ outboundTrafficPolicy: REGISTRY_ONLY
        └─ Traffic BLOCKED via BlackHoleCluster (502 / reset)
```

The Sidecar resource removes the service from Envoy's xDS config, but with `ALLOW_ANY` (the default), unknown destinations fall through as passthrough TCP. You need `REGISTRY_ONLY` or an AuthorizationPolicy DENY rule to actually block the traffic. This is a common security misconfiguration.

---

### Q: Does Envoy handle DNS resolution in Istio?

**A:** No, not by default. Istio's iptables rules only redirect **TCP** traffic to Envoy. DNS queries (UDP port 53) go directly to kube-dns/CoreDNS, bypassing Envoy entirely. Envoy only sees the resulting TCP connection to the resolved IP.

Envoy identifies the destination service post-resolution by matching the destination IP:port against its known clusters, or by inspecting the Host header (HTTP) or SNI (TLS) for shared listeners.

There is an opt-in feature (Istio DNS Proxying, `ISTIO_META_DNS_CAPTURE=true`) where `istio-agent` (not Envoy) intercepts DNS on port 15053. This is primarily needed for ServiceEntry destinations (no ClusterIP to match on) and multi-cluster setups.

---

### Q: Why does Envoy use a shared `0.0.0.0` listener instead of per-IP listeners?

**A:** When multiple Kubernetes services use the same port (e.g., many services on port 80), creating per-ClusterIP listeners would be wasteful and complex. Istio collapses them into a single `0.0.0.0:<port>` listener with route rules that use the **Host header** (HTTP) or **SNI** (TLS) to match the correct Envoy cluster.

```
0.0.0.0:80 listener
  ├─ Host: cart-svc.ns.svc...    → outbound|80||cart-svc
  ├─ Host: payment-svc.ns.svc... → outbound|80||payment-svc
  └─ Host: order-svc.ns.svc...   → outbound|80||order-svc
```

You can verify this with `istioctl proxy-config listeners <pod> --port 80` (shows `0.0.0.0`) and `istioctl proxy-config routes <pod> --name 80` (shows the Host-based routing table).

For plain TCP (non-HTTP) traffic, Envoy can only match by IP:port since there's no Host header or SNI — this is why Istio protocol detection matters.
