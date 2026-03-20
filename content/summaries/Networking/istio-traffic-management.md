---
title: "Summary: Istio Traffic Management"
---

> **Full notes:** [[notes/Networking/istio-traffic-management|Istio Traffic Management: VirtualService, DestinationRule, Gateway API, Service Entries, and Network Resilience -->]]

## Key Concepts

**Sidecar Traffic Interception** -- Istio injects an init container (`istio-init`) that sets up iptables REDIRECT rules in each pod's network namespace. Outbound traffic goes to Envoy on port 15001, inbound to 15006. Envoy's own traffic (UID 1337) skips redirection to avoid loops.

**VirtualService** -- Defines *how* requests to a hostname are routed. Maps to Envoy's Route Discovery Service (RDS). Match rules: conditions within one block are ANDed; multiple blocks are ORed. First match wins. Always include a default catch-all route or unmatched requests get 404.

**DestinationRule** -- Defines *how* traffic reaches a destination after routing. Configures Envoy clusters: load balancing, connection pools, circuit breakers, outlier detection, TLS, and subsets. Subsets partition endpoints by pod labels (e.g., `version: v1`).

**Kubernetes Gateway API** -- The recommended ingress API (Istio 1.22+). Three-tier model: GatewayClass (infra provider) -> Gateway (cluster operator) -> HTTPRoute (app developer). Istio auto-provisions Envoy Deployment + Service when a Gateway resource is created. Replaces the legacy Istio Gateway CRD.

**ServiceEntry** -- Registers external services into the mesh so Envoy can apply retries, timeouts, circuit breaking, and metrics to outbound traffic that would otherwise use a passthrough cluster.

**Sidecar Resource** -- Limits which services a proxy knows about. Reduces xDS config size and memory (10x+ in large meshes).

**Network Resilience** -- Timeouts (overall request), retries (`attempts` = total calls including first), circuit breaking (caps concurrent connections/requests, returns 503), outlier detection (ejects unhealthy endpoints), fault injection (delay/abort at L7).

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

| Resilience Feature | Configured In      | What It Does                          |
|--------------------|--------------------|---------------------------------------|
| Timeout            | VirtualService     | Total request deadline                |
| Retries            | VirtualService     | Re-attempt failed requests            |
| Circuit Breaking   | DestinationRule    | Caps connections/requests -> 503      |
| Outlier Detection  | DestinationRule    | Ejects bad endpoints from LB pool    |
| Fault Injection    | VirtualService     | Injects delays/errors for testing     |

**Istio Gateway CRD vs K8s Gateway API:**

| Aspect              | Istio CRD           | K8s Gateway API         |
|---------------------|----------------------|-------------------------|
| Provisioning        | Manual               | Automatic               |
| Role separation     | Weak                 | Strong (3-tier)         |
| Cross-namespace     | Implicit             | Explicit (ReferenceGrant) |
| Portability         | Istio-only           | Multi-implementation    |

## Key Takeaways

- VirtualService owns a host's routing completely -- no fallback to K8s default if no match exists (you get 404).
- `attempts: 3` means 3 total calls (1 original + 2 retries), not 3 retries after the first.
- Circuit breaking (connectionPool) protects the upstream from overload; outlier detection (outlierDetection) protects the caller from bad endpoints. They complement each other.
- Use the Kubernetes Gateway API for new deployments -- it auto-provisions Envoy and cleanly separates infra/platform/app roles.
- In large meshes, define a Sidecar resource per namespace to restrict egress scope and dramatically reduce proxy memory.
