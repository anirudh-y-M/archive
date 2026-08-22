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

When many services share the same port (e.g., port 80), Istio collapses them into a **single catch-all listener** on `0.0.0.0:<port>` instead of per-ClusterIP listeners. Because the listener address no longer identifies the service, Envoy has to disambiguate from the request itself — Host header for HTTP, SNI for TLS (full matrix in Quick Reference below).

### Envoy "Cluster" ≠ Kubernetes Cluster

In Envoy, a **cluster** = a logical group of pod endpoints for one service. Naming: `outbound|80||cart-svc.default.svc.cluster.local`. Contains pod IPs from EDS. Envoy's load balancer picks an endpoint from the cluster.

## Quick Reference

### Where endpoints actually come from

```
K8s API (Services + Endpoints/EndpointSlices)
      │  populated by pod label selectors — sidecar-agnostic
      │  watch/list
      ▼
   istiod
      │  xDS push:  CDS = clusters,  EDS = pod IPs
      ▼
 client Envoy  ──▶ load-balances across pods that have no sidecar
```

### Making Sidecar whitelisting actually enforce

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Sidecar
metadata: { name: default, namespace: client-ns }
spec:
  outboundTrafficPolicy:
    mode: REGISTRY_ONLY        # ← without this, default ALLOW_ANY lets traffic pass
  egress:
  - hosts: ["istio-system/*", "client-ns/*"]   # other-ns omitted → blocked
```

Alternative that works regardless of outbound mode — an `AuthorizationPolicy` with `action: DENY` matching `hosts: ["*.other-ns.svc.cluster.local"]`.

### Enabling DNS proxying (opt-in, Istio ~1.8+)

```yaml
meshConfig:
  defaultConfig:
    proxyMetadata:
      ISTIO_META_DNS_CAPTURE: "true"
      ISTIO_META_DNS_AUTO_ALLOCATE: "true"
```

### How Envoy identifies the destination

| Traffic type | Envoy matches on |
|---|---|
| HTTP to a unique ClusterIP | IP:port (Host available but not required) |
| HTTP via shared `0.0.0.0` listener | **Host header** — required to disambiguate |
| TLS / mTLS passthrough | **SNI** from the TLS ClientHello |
| Plain TCP (non-HTTP) | IP:port only — no Host, no SNI |

### Debug commands

```bash
istioctl proxy-config listeners <pod> --port 80   # shows 0.0.0.0 shared listener
istioctl proxy-config routes <pod> --name 80      # Host → cluster mapping
istioctl proxy-config clusters <pod>              # all Envoy clusters
istioctl proxy-config endpoints <pod> --cluster "outbound|80||svc-name.ns.svc.cluster.local"
```

## Key Takeaways

- Service discovery is **Kubernetes-derived, not mesh-derived**. istiod watches the same Services/Endpoints data `kube-proxy` uses, so a meshed client can load-balance across destination pods that have no sidecar at all.
- Mesh membership buys **capabilities, not visibility**: STRICT mTLS, server-side `AuthorizationPolicy`, and server-side telemetry all need a destination sidecar. Discovery and client-side LB/retries/timeouts do not.
- PERMISSIVE mode **silently falls back to plaintext** when the destination has no sidecar. Traffic keeps working, which is exactly why people believe it is encrypted when it is not.
- `Sidecar.egress.hosts` filters **config, not traffic**. It removes services from the proxy's xDS config; it does not block packets.
- With the default `ALLOW_ANY`, excluded destinations still get through via **PassthroughCluster** as plain TCP — no L7 features, no Istio metrics, kube-proxy doing the balancing. This is one of the most common Istio security misconfigurations.
- Only `REGISTRY_ONLY` (→ **BlackHoleCluster**, 502/reset) or an `AuthorizationPolicy` DENY actually enforces isolation.
- **Envoy never sees DNS by default.** Istio's iptables rules redirect TCP only; UDP/53 goes straight to kube-dns/CoreDNS. Envoy acts strictly after resolution, on the resolved IP.
- DNS proxying (`istio-agent` on port 15053) is opt-in and exists mainly for **ServiceEntry** destinations, which have no ClusterIP for Envoy to match on, and for multi-cluster resolution.
- Same-port services collapse into a single `0.0.0.0:<port>` listener, so **Host header or SNI carries the routing decision**. Plain TCP has neither — which is why protocol detection and Service port naming matter.
- An Envoy **"cluster" is one service's endpoint group** (`outbound|80||cart-svc.default.svc.cluster.local`) populated by EDS. It has nothing to do with a Kubernetes cluster.
