---
title: "Summary: Istio Architecture, xDS, Sidecar Injection, Traffic Interception, and Ambient Mode"
---

> **Full notes:** [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive -->]]

## Key Concepts

- **Control plane (istiod)**: Single Go binary combining Pilot (config translation), Citadel (CA/certs), Galley (validation), and xDS server. Stateless -- reconstructs from K8s API on startup.

- **Data plane**: Envoy sidecar (`istio-proxy`) in every pod. Contains pilot-agent (bootstrap, cert fetch, lifecycle) + Envoy (the actual proxy).

- **xDS protocol**: gRPC-based dynamic config delivery from istiod to Envoy. Six APIs: LDS (listeners), RDS (routes), CDS (clusters), EDS (endpoints), SDS (secrets/certs), ADS (aggregated, ensures ordering).

- **Sidecar injection**: Kubernetes Mutating Admission Webhook intercepts pod creation, adds `istio-init` (iptables setup) and `istio-proxy` (Envoy) containers.

- **iptables interception**: NAT table rules redirect all inbound TCP to port 15006 and all outbound TCP to port 15001. UID 1337 (Envoy) is excluded to prevent infinite loops.

- **Ambient mode**: Sidecar-less architecture. ztunnel (Rust, DaemonSet, L4 only) handles mTLS per-node. Optional waypoint proxy (Envoy deployment) for L7 features. 90%+ memory reduction.

## Quick Reference

```
Request Lifecycle:
  App A ──iptables──> Envoy A (15001) ──mTLS──> Envoy B (15006) ──> App B
         OUTPUT→15001                  network  PREROUTING→15006    localhost:8080
         (uid!=1337)                            (redirected)        (uid=1337, bypass)
```

| xDS API | Configures | K8s/Istio Source |
|---------|-----------|-----------------|
| LDS | Listeners (bind address, filters) | PeerAuthentication |
| RDS | HTTP routes (hosts, paths) | VirtualService |
| CDS | Upstream clusters (LB, circuit breaker) | DestinationRule |
| EDS | Pod IP:port endpoints | Service/Endpoints |
| SDS | TLS certs and keys | istiod CA |

**Key ports:** 15001 (outbound), 15006 (inbound), 15000 (admin), 15012 (xDS mTLS), 15017 (webhook), 15021 (health), 15090 (metrics)

**xDS ordering:** CDS -> EDS -> LDS -> RDS (prevents routing to non-existent clusters)

## Key Takeaways

- Traffic interception is transparent via iptables -- never run your app as UID 1337 or it bypasses the sidecar entirely.
- If istiod goes down, existing proxies keep working with cached config, but no new config pushes, cert rotation, or sidecar injection occurs.
- Ambient mode splits L4 (ztunnel per node) from L7 (waypoint per namespace) -- most services only need L4.
- Always name K8s service ports with protocol prefixes (`http-`, `grpc-`) or set `appProtocol`, otherwise Istio treats traffic as opaque TCP.
- Use `holdApplicationUntilProxyStarts: true` to avoid init container race conditions where the app starts before Envoy is ready.
