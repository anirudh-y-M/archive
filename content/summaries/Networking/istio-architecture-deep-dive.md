---
title: "Summary: Istio Architecture, xDS, Sidecar Injection, Traffic Interception, and Ambient Mode"
---

> **Full notes:** [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive -->]]

## Key Concepts

### Architecture: Control Plane vs Data Plane

**istiod** is a single Go binary consolidating Pilot (watches K8s API, translates to Envoy config, pushes via xDS), Citadel (CA, issues SPIFFE X.509 certs, delivers via SDS), Galley (validates Istio CRDs), and xDS server (maintains gRPC streams to all proxies). istiod is stateless -- reconstructs all state from K8s API on startup. Multiple replicas for HA.

**Data plane**: every meshed pod runs an `istio-proxy` container with two processes. **pilot-agent** generates Envoy bootstrap config, fetches certs from istiod via SDS, manages Envoy lifecycle, serves health checks (port 15021). **Envoy** handles L4/L7 proxying, mTLS, load balancing, retries/timeouts, metrics (port 15090), admin API (port 15000).

### Well-Known Ports

| Port | Owner | Purpose |
|------|-------|---------|
| 15001 | Envoy | VirtualOutbound (captures outbound) |
| 15006 | Envoy | VirtualInbound (captures inbound) |
| 15000 | Envoy | Admin API |
| 15010/15012 | istiod | xDS plaintext/mTLS |
| 15017 | istiod | Webhook (injection, validation) |
| 15020/15021 | pilot-agent | Merged metrics / health check |
| 15090 | Envoy | Prometheus metrics |

### xDS Protocol

gRPC-based protocol for dynamic config delivery from istiod to Envoy. Six APIs: **LDS** (listeners -- bind address, filter chains), **RDS** (routes -- virtual hosts, match rules), **CDS** (clusters -- LB policy, circuit breakers, TLS context), **EDS** (endpoints -- pod IP:port, health, locality), **SDS** (secrets -- TLS certs and keys), **ADS** (aggregated -- single gRPC stream multiplexing all types with ordering guarantees).

K8s resources map to xDS: VirtualService -> RDS, DestinationRule -> CDS, Service/Endpoints -> CDS+EDS, PeerAuthentication -> LDS filter chains.

**Ordering**: CDS -> EDS -> LDS -> RDS (prevents traffic blackholes from routing to non-existent clusters).

**SotW vs Delta**: State-of-the-World sends complete resource sets per push (simple but wasteful). Delta (incremental, default since Istio 1.22) sends only changed resources -- critical for large meshes.

### Sidecar Injection

Uses a Kubernetes **Mutating Admission Webhook**. When a pod is created in a namespace labeled `istio-injection=enabled`, istiod's webhook (port 15017) mutates the pod spec: adds `istio-init` init container (sets up iptables), adds `istio-proxy` sidecar container, adds volumes (envoy config, SDS socket, projected SA token). No Deployment changes needed.

The `istio-init` container runs `istio-iptables` with key args: `-p 15001` (outbound capture), `-z 15006` (inbound capture), `-u 1337` (Envoy UID excluded from capture). Requires `NET_ADMIN` capability, or can be replaced by the Istio CNI plugin (node-level DaemonSet, eliminates `NET_ADMIN` requirement).

### Traffic Interception with iptables

Custom chains in the **NAT table** transparently redirect TCP through Envoy:

```
Inbound:  PREROUTING -> ISTIO_INBOUND -> ISTIO_IN_REDIRECT -> port 15006
  (excludes ports 15008, 15090, 15021, 15020 via RETURN rules)

Outbound: OUTPUT -> ISTIO_OUTPUT -> ISTIO_REDIRECT -> port 15001
  (excludes: src 127.0.0.6, uid-owner 1337, gid-owner 1337, dst 127.0.0.1)
```

**Loop prevention**: Envoy runs as UID 1337. When Envoy sends a packet, the OUTPUT chain sees `--uid-owner 1337` and RETURNs, letting the packet go to the network. Without this, Envoy's traffic would redirect back to itself infinitely. **Never run your app as UID 1337** or all its traffic bypasses the sidecar.

### Request Lifecycle End-to-End

App A sends to `reviews:8080` -> kernel iptables redirects to port 15001 (uid!=1337) -> Envoy outbound reads original dest via `SO_ORIGINAL_DST`, routes via RDS/CDS/EDS, selects endpoint, initiates mTLS -> packet crosses pod network -> Pod B kernel redirects to port 15006 -> Envoy inbound terminates mTLS, validates SPIFFE identity, evaluates AuthorizationPolicy -> forwards to `127.0.0.1:8080` as uid 1337 (bypasses iptables) -> App B processes request.

### Ambient Mode (ztunnel + Waypoint Proxy)

Sidecar-less architecture splitting L4 from L7. **ztunnel** (Zero Trust Tunnel): Rust-based, deployed as DaemonSet per node, handles mTLS, L4 authz, TCP telemetry. Uses HBONE (HTTP CONNECT over mTLS with H2 multiplexing) between ztunnels. Creates listening sockets inside each pod's network namespace via Istio CNI agent (no iptables needed).

**Waypoint Proxy**: standard Envoy deployment per-namespace or per-service. Only needed for L7 features (HTTP routing, header-based authz, retries, fault injection). If no waypoint deployed, traffic flows directly between ztunnels (L4 only).

| Aspect | Sidecar | Ambient |
|--------|---------|---------|
| Proxy per pod | Yes (Envoy) | No (shared ztunnel/node) |
| Resource overhead | High | Low (90%+ memory reduction) |
| L7 features | Always | Only with waypoint |
| App restart to mesh | Yes | No (label namespace) |
| Interception | iptables REDIRECT | ztunnel sockets in pod netns |

### Common Gotchas

**Port naming**: Istio uses K8s service port name prefixes (`http-`, `grpc-`, `tcp-`, etc.) or `appProtocol` to detect protocol. Without it, traffic is treated as opaque TCP -- no HTTP routing, retries, or metrics.

**Protocol detection**: When no hint is available, Envoy sniffs first bytes. Adds latency for server-first protocols (MySQL, Redis) -- up to 5s detection timeout.

**App binding**: App should bind to `0.0.0.0`, not `127.0.0.1`, for external health checks to work.

**Init container race**: If app starts faster than Envoy, iptables redirects traffic to port 15001 where Envoy isn't ready yet. Fix: `holdApplicationUntilProxyStarts: true` or use Istio CNI.

**istiod unavailability**: Existing proxies continue with cached config, but no config updates, cert rotation (certs expire after 24h), sidecar injection, or endpoint propagation. Run multiple replicas.

### Debugging

```
istioctl proxy-status              # SYNCED/STALE status of all proxies
istioctl proxy-config listeners    # LDS dump
istioctl proxy-config routes       # RDS dump
istioctl proxy-config clusters     # CDS dump
istioctl proxy-config endpoints    # EDS dump
kubectl port-forward 15000:15000   # Envoy admin API
curl localhost:15000/config_dump   # Full config
curl localhost:15000/clusters      # Upstream health
curl localhost:15000/logging?level=debug  # Runtime log level
kubectl exec -c istio-proxy -- iptables -t nat -S  # View NAT rules
```

## Quick Reference

```
Request Lifecycle:
  App A ──iptables──> Envoy A (15001) ──mTLS──> Envoy B (15006) ──> App B
         OUTPUT->15001                  network  PREROUTING->15006    localhost:8080
         (uid!=1337)                             (redirected)         (uid=1337, bypass)

Loop Prevention:
  App (uid!=1337) -> iptables -> 15001 -> Envoy processes -> sends as uid 1337 -> RETURN -> network

Ambient Mode:
  Without waypoint: Pod A -> ztunnel (node A) --HBONE--> ztunnel (node B) -> Pod B
  With waypoint:    Pod A -> ztunnel -> waypoint (L7) -> ztunnel -> Pod B
```

| xDS API | Configures | K8s/Istio Source |
|---------|-----------|-----------------|
| LDS | Listeners (bind address, filter chains) | PeerAuthentication |
| RDS | HTTP routes (hosts, paths, weights) | VirtualService |
| CDS | Upstream clusters (LB, circuit breaker) | DestinationRule |
| EDS | Pod IP:port endpoints (health, locality) | Service/Endpoints |
| SDS | TLS certs and keys | istiod CA |

**xDS ordering:** CDS -> EDS -> LDS -> RDS (prevents routing to non-existent clusters)

## Key Takeaways

- Traffic interception is transparent via iptables in the NAT table. Never run your app as UID 1337 or it bypasses the sidecar entirely.
- xDS delivers config dynamically over persistent gRPC streams. Delta xDS (default since 1.22) sends only changes, critical for large meshes.
- If istiod goes down, existing proxies keep working with cached config, but no new config, cert rotation, or sidecar injection occurs. Run 2-3 replicas.
- Ambient mode splits L4 (ztunnel per node, Rust) from L7 (waypoint per namespace, Envoy). Most services only need L4, saving 90%+ memory.
- Always name K8s service ports with protocol prefixes (`http-`, `grpc-`) or set `appProtocol`, otherwise Istio treats traffic as opaque TCP with no HTTP features.
- Use `holdApplicationUntilProxyStarts: true` to avoid race conditions where the app starts before Envoy is ready.
- `istioctl proxy-status` is the first debugging command -- shows SYNCED/STALE status. `proxy-config` dumps the actual Envoy config per proxy.
