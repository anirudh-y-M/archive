---
title: "Summary: Istio Service Discovery, DNS Resolution, and Envoy Listener Architecture"
---

> **Full notes:** [[notes/Networking/istio-service-discovery-dns-listeners|Istio Service Discovery, DNS & Listeners -->]]

## Key Concepts

### Service Discovery Is Independent of Mesh Membership

istiod gets endpoint information from the **Kubernetes API server** (Services, Endpoints/EndpointSlices), not from sidecars. Kubernetes populates Endpoints based on pod label selectors — sidecar presence is irrelevant. So a client-side Envoy can load-balance across destination pods that have no sidecar.

**What mesh membership affects** — not discovery, but capabilities:

| Works without dest sidecar | Doesn't work without dest sidecar |
|---|---|
| Client-side load balancing | mTLS STRICT (no sidecar to terminate) |
| Client-side retries/timeouts | Server-side AuthorizationPolicy |
| mTLS PERMISSIVE (falls back to plaintext) | Server-side telemetry |

### Sidecar Egress Whitelisting + outboundTrafficPolicy

The Sidecar resource's `egress.hosts` removes services from Envoy's xDS config. But **filtering config ≠ blocking traffic**:

```
Sidecar excludes "other-ns" from egress.hosts
    │
    ├─ outboundTrafficPolicy: ALLOW_ANY (DEFAULT)
    │   └─ PassthroughCluster → traffic GOES THROUGH (plain TCP, no L7)
    │
    └─ outboundTrafficPolicy: REGISTRY_ONLY
        └─ BlackHoleCluster → traffic BLOCKED (502/reset)
```

**Gotcha:** Most teams set up Sidecar whitelisting expecting isolation, but with default `ALLOW_ANY`, unknown destinations just fall through as passthrough TCP. Need `REGISTRY_ONLY` or an AuthorizationPolicy DENY to actually enforce.

### DNS Resolution — kube-dns, Not Envoy

Istio's iptables rules only redirect **TCP** traffic. DNS queries (UDP port 53) bypass Envoy entirely and go to kube-dns/CoreDNS. Envoy only sees the resulting TCP connection.

| Scenario | DNS resolver |
|---|---|
| Default Istio | kube-dns/CoreDNS |
| DNS Proxying enabled (`ISTIO_META_DNS_CAPTURE=true`) | istio-agent (port 15053), falls back to kube-dns |
| No mesh | kube-dns/CoreDNS |

DNS Proxying is opt-in, needed mainly for ServiceEntry destinations (no ClusterIP) and multi-cluster.

### Envoy Shared Listeners (0.0.0.0)

When many services share the same port (e.g., port 80), Istio collapses them into a **single catch-all listener** on `0.0.0.0:<port>` instead of per-ClusterIP listeners. Disambiguation:

| Traffic type | How Envoy identifies destination |
|---|---|
| HTTP (shared listener) | **Host header** — matches route table |
| TLS / mTLS passthrough | **SNI** — from TLS ClientHello |
| Plain TCP | IP:port only |

### Envoy "Cluster" ≠ Kubernetes Cluster

In Envoy, a **cluster** = a logical group of pod endpoints for one service. Naming: `outbound|80||cart-svc.default.svc.cluster.local`. Contains pod IPs from EDS. Envoy's load balancer picks an endpoint from the cluster.

### Useful Debug Commands

```bash
istioctl proxy-config listeners <pod> --port 80   # shows 0.0.0.0 shared listener
istioctl proxy-config routes <pod> --name 80       # Host → cluster mapping
istioctl proxy-config clusters <pod>               # all Envoy clusters
istioctl proxy-config endpoints <pod> --cluster "outbound|80||svc-name.ns.svc.cluster.local"
```
