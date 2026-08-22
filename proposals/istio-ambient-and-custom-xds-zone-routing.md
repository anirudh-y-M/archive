---
title: "Proposal — Migrate Istio Sidecar → Ambient, and add Custom-xDS Zone-Aware Routing"
---

# Migrating from Istio Sidecar to Ambient + Custom-xDS Zone-Aware Routing

A two-track proposal: **(1)** drop sidecars in favour of Istio Ambient — first in a single cluster, then across multiple — and **(2)** replace Istio's built-in zone-aware load balancing with a **custom xDS control plane** modelled on Spotify's "Nameless / Shameless / Zoneless" architecture (KubeCon EU 2026 Amsterdam).

---

## KubeCon EU 2026 Sessions

Three sessions were directly relevant to this proposal, with **Istio's ambient multicluster going Beta** as the headline:

1. **The Good, The Ugly, and The Bad: Leavling Sidecars Behind with Istio Ambient Mesh**
    Speakers: Alfonso Ming, Jorge Turrado (SCRM Lidl International Hub)
    A retail-scale adopter's honest report on a production sidecar → ambient migration.

2. **Istio's Ambient Mesh: The Real Cost of Sidecar-less Tracing**
    Deep dive on observability semantics when waypoints replace sidecars — what tracing assumptions break, what stays free.

3. **Smart Routing at Scale: How Spotify's xDS Control Plane Cut 75% of Cross-Zone Traffic**
    Speakers: Spotify R&D
    Custom xDS control plane ("Nameless / Shameless / Zoneless") replacing both DNS and Istio's built-in locality LB. **82% cross-zone networking cost reduction** on high-volume services.

### Why This Matters

- **Ambient multicluster hit Beta** at the conference (Istio 1.29, March 2026). The piece of the ambient story we'd been waiting for — sidecar-less mesh across clusters/networks — is now production-track.
- **Istio's stock locality-LB has a well-known failure mode** (the "death spiral" — cold pod in a small zone gets its host-share of traffic and crash-loops). Spotify proved a custom xDS plane fixes it cleanly with **LRS measurement + a dynamic capacity model**.
- **Both tracks compound.** Ambient gives us the data-plane substrate (ztunnel L4 + waypoints L7); custom xDS lets us push smarter EDS to the waypoints without fighting Istio's defaults.

---

## Project Maturity

| **Component** | **Status (as of KubeCon EU 2026)** |
| --- | --- |
| Istio Ambient (single cluster) | **GA** since Istio 1.24 (Nov 2024) |
| Ambient multicluster — same network | Beta (Istio 1.27) |
| Ambient multicluster — multi-network | **Beta** (Istio 1.29, Mar 2026) |
| Waypoint per-namespace / per-SA | GA |
| HBONE (CONNECT-based tunnel) | GA, now enriched with baggage headers for east-west peer metadata |
| go-control-plane (custom xDS) | Stable, widely used (Spotify, Datadog, Cilium) |

---

## Track 1 — Sidecar → Ambient (Single Cluster)

### How Ambient Works (vs Sidecar)

```
SIDECAR MODE                          AMBIENT MODE
─────────────────                     ─────────────────────────────
[ App Pod ]                           [ App Pod ]
   └── envoy sidecar  (L4+L7)            │ (no sidecar)
       per pod, lifecycle-coupled        ▼
                                      [ ztunnel ]  (per-node DaemonSet, L4 only, HBONE)
                                          │
                                          ▼ (optional, only if L7 needed)
                                      [ Waypoint Proxy ]  (per namespace / per SA, Envoy L7)
                                          │
                                          ▼
                                      [ Destination Pod ]
```

### Capability Comparison

| Capability | Sidecar Mode | Ambient Mode |
| --- | --- | --- |
| Proxy deployment unit | 1 Envoy injected per pod | 1 ztunnel per node + 1 waypoint per ns/SA (only if L7 needed) |
| Per-pod memory overhead | ~50–100 MB × N pods | ~10 MB ztunnel/node, amortized across all pods |
| Pod startup dependency | ✅ blocked on sidecar init container | ❌ no mesh init dependency |
| L4 mTLS | ✅ enforced by sidecar | ✅ enforced by ztunnel (HBONE tunnel) |
| L7 features (retries, traffic shifting, JWT, header rewrite) | ✅ always loaded in every sidecar | Opt-in — deploy a waypoint per ns/SA |
| `AuthorizationPolicy` (L4) | ✅ | ✅ enforced by ztunnel |
| `AuthorizationPolicy` (L7) | ✅ | Requires waypoint in path |
| Mesh upgrade impact on app pods | Pod restart per upgrade (rolling) | DaemonSet / Deployment rollout — no app restart |
| Blast radius if proxy fails | 1 pod | All pods on node (ztunnel) — but DaemonSet recovers in seconds |
| Per-pod metrics / traces | ✅ each sidecar emits per-pod | Per-namespace / per-waypoint granularity |
| Per-pod resource attribution | ✅ sidecar billed to pod | Shared across node / namespace |
| Sidecar-injection webhook required | ✅ | ❌ |
| Co-existence (mixed mode) | n/a | ✅ ambient + sidecar workloads can share a mesh |
| Multi-cluster maturity | GA, mature | Multi-network multicluster Beta (Istio 1.29, Mar 2026) |
| Maturity | GA since Istio 1.0 | Ambient GA since 1.24 (Nov 2024) |

### Benefits in a Single Cluster

<aside>
🪶

**Resource & cost win.** One ztunnel/node replaces N sidecars/node. On a 100-pod-per-node cluster, sidecar memory alone is 5–10 GB/node; ambient is in the low hundreds of MB. Same story for CPU.

</aside>

<aside>
🔁

**Upgrades stop being app-team theatre.** ztunnel is a DaemonSet; waypoints are independent Deployments. We can roll Istio without coordinating a fleet-wide pod restart with every service owner.

</aside>

<aside>
🧱

**L4-only by default, L7 by exception.** Many services just want mTLS + auth-policies — they don't need retries, traffic shifting, or HTTP filters. Ambient gives them L4 for free and L7 only where they ask for it (deploy a Waypoint in that namespace/SA).

</aside>

<aside>
⏱️

**Faster pod startup.** No sidecar init container, no race between app readiness and Envoy bootstrap. Reduces tail-latency on autoscale events.

</aside>

<aside>
🤝

**Co-existence is supported.** Sidecar and ambient pods talk to each other in the same mesh. Migration is per-namespace, not big-bang.

</aside>

### Migration Pattern (Single Cluster)

1. Install ambient profile alongside existing sidecar control plane.
2. Pick a low-risk namespace, label it `istio.io/dataplane-mode=ambient`.
3. Restart pods → sidecars gone, ztunnel handles L4 mTLS.
4. If that namespace uses L7 policies, deploy a Waypoint for it.
5. Validate metrics/tracing parity (the "Real Cost of Sidecar-less Tracing" talk's checklist applies here — span propagation moves from sidecar to waypoint, some span IDs differ).
6. Repeat per namespace.

---

## Track 2 — Sidecar/Ambient Single Cluster → Ambient Multi-Cluster

### Benefits When Going Multi-Cluster

<aside>
🌐

**East-west gateway is sidecar-less too.** With sidecar-mode multicluster, every pod's sidecar terminates cross-cluster mTLS. With ambient multicluster, the east-west gateway + ztunnel + waypoint handle it. Far fewer moving parts per app.

</aside>

<aside>
🧬

**HBONE + baggage headers carry peer metadata across networks.** Istio 1.29 (KubeCon EU 2026) added baggage propagation through east-west gateways — so waypoint and ztunnel exchange peer identity, locality, and source workload info transparently across clusters. This is what makes cross-cluster L7 policy actually work.

</aside>

<aside>
🛰️

**Multi-primary, multi-network is now Beta.** Each cluster has its own istiod; clusters are joined via an east-west gateway. Workloads in cluster-A can call services in cluster-B by their normal mesh DNS name — no app changes.

</aside>

<aside>
🛡️

**Failure isolation.** Sidecar-mode multicluster couples every pod's sidecar to the topology of the remote cluster. Ambient pushes that coupling to the gateway + ztunnel layer, so a remote cluster's churn doesn't ripple into every local pod's Envoy.

</aside>

<aside>
⚙️

**Cleaner operational story for the platform team.** No `istio-cni` + sidecar-injection-webhook coordination across clusters. Just ztunnel DaemonSet + east-west gateway per cluster.

</aside>

### Topology

```
   CLUSTER A (network-a)                       CLUSTER B (network-b)
   ────────────────────                        ────────────────────
   [ App ]                                     [ App ]
     │                                           │
     ▼                                           ▼
   [ ztunnel ] ───HBONE───► [ E-W Gateway ] ──► [ E-W Gateway ] ───► [ ztunnel ]
                              (cluster-A)        (cluster-B)              │
                                                                          ▼
                                                                       [ Waypoint ]
                                                                          │
                                                                          ▼
                                                                       [ App Pod ]

   Both istiods peer; service discovery is mesh-wide; mTLS is end-to-end.
```

---

## Track 3 — Custom xDS Control Plane for Zone-Aware Routing

The Spotify talk's core argument: **Istio's `localityLbSetting` (and Envoy's stock zone-aware heuristic) are wrong in a non-trivial number of real production scenarios** — and a custom xDS control plane is a cleaner fix than trying to tune them.

### Why Istio's Native Zone-Aware Routing Falls Short

Envoy's built-in heuristic assumes:
1. `downstream host distribution = downstream traffic distribution`
2. `upstream host distribution = upstream capacity distribution`

Both break at scale. The second one breaks **especially badly**:

```
INCIDENT (from Spotify's slides)
────────────────────────────────
Service X, us-east1, ~300k req/s
Zone B: 9 healthy pods   ← serving everything
Zone C: 1 cold pod just placed  ← JVM warming, caches empty

Envoy's model: "Zone C has 1/10 of hosts → send 10% of traffic = 30k req/s"
Reality      : "Cold pod, real capacity ≈ 0"
Result       : queue builds → GC stalls → 100% errors → pod killed
               → replacement is also cold → same story → repeats 2+ hours
               → only fix: disable zone-aware routing entirely
```

This is the **"death spiral"**. It's not a bug in Envoy — it's the assumption that host count == capacity.

### The Spotify Heuristic (and Why a Custom Plane Needs to Serve It)

**Step 1 — Same-zone weight (greedy fill):**
$$w_\text{local} = \min\left(1, \frac{\text{capacity}}{\text{demand}}\right)$$

**Step 2 — Distribute spillover by residual capacity:**
$$\text{spill}_{x \to y} = (1 - w_\text{local}) \times \frac{\text{residual}_y}{\sum \text{residual}}$$

**The fix to the "host count == capacity" assumption — measure, don't assume:**

- Clients self-report per-zone request counts every 10s via **LRS (Load Reporting Service)**.
- Control plane aggregates → real per-zone traffic distribution → substitutes into the formula.

**The fix to the death spiral — dynamic capacity model:**

$$\text{capacity}(X) = H_X \times \frac{I_X}{I_X + Q_X}$$

Where `H` = healthy hosts, `I` = issued requests, `Q` = queued (outstanding) requests. Queue depth is a **leading indicator** — it spikes before errors do, so traffic shifts away *before* the pod death-spirals.

**Slow-start protection (`ramp`) — prevents thundering herd on cold pods:**

$$\text{ramp}(X) = \max\left(0.05,\ \frac{S_X \cdot \sum H_Z}{S_X \cdot \sum H_Z + H_X \cdot \sum S_Z}\right)$$

A zone must **earn** its capacity share by successfully handling probe traffic (`S` = successful requests). Cold pods start at ~1% of fair share and ramp over ~100s.

**Effective capacity = `ramp(X) × capacity(X)`** — capacity detects problems fast (leading), ramp prevents overreaction (trailing).

### Architecture (Maps Directly to the Spotify Slides)

```
                        ┌──────────────────────────────────────────────┐
                        │            Custom xDS Control Plane           │
                        │                                              │
                        │   ┌──────────────┐      ┌──────────────┐    │
                        │   │  Shameless   │◄────►│   Zoneless   │    │
                        │   │ (xDS server) │ LRS  │ (aggregator) │    │
                        │   └──────┬───────┘      └──────────────┘    │
                        │          │ EDS push (zone weights)            │
                        └──────────┼──────────────────────────────────┘
                                   │
                  ┌────────────────┼────────────────┐
                  ▼                ▼                ▼
            [ Waypoint A ]   [ Waypoint B ]   [ Waypoint C ]
              (zone-a)         (zone-b)         (zone-c)
```

- **istiod** keeps generating LDS/RDS/CDS as today.
- **Custom control plane** owns **EDS only** — pushes weighted endpoints to waypoints (or sidecars during migration).
- Waypoints/sidecars source EDS from the custom plane via a static bootstrap cluster + an `EnvoyFilter` patching `eds_cluster_config` on target clusters.
- LRS flows the other direction: waypoints report per-zone load every 10s.

### Capability Comparison: Istio Native vs Custom xDS

| Capability | Istio Native | Spotify Custom xDS |
| --- | --- | --- |
| Locality priority (region/zone failover) | ✅ `localityLbSetting.failover` | ✅ |
| Static weighted distribution | ✅ `localityLbSetting.distribute` | ✅ |
| Host-count-based weighting | ✅ (Envoy default) | ✅ (fallback only) |
| **Measured traffic distribution (LRS)** | ❌ — assumes `host = traffic` | ✅ — clients self-report every 10s |
| **Queue-depth-aware capacity** | ❌ | ✅ `capacity(X) = H × I/(I+Q)` |
| **Success-rate-based slow start per zone** | Partial — Envoy `slow_start_config` is per-host, not per-zone | ✅ `ramp(X)` with 5% floor |
| **Reaction time to noisy neighbour / GC pressure** | Slow — relies on outlier detection ejecting hosts after errors | Fast — next 10s LRS cycle |
| **Min-cluster-size guard** | ✅ default 6 — blunt: disables locality routing below threshold | Dynamic — no hard cutoff, ramps weight by measured success |
| Cross-cluster locality weighting | Limited (priority-based failover only) | ✅ same formula extended with cluster as a locality dimension |
| Fallback when control plane unavailable | n/a (always-on) | ✅ falls back to host-count distribution automatically |

The bolded rows are the ones that close real production failure modes — chatty clients, cold pods in small zones, noisy-neighbour-induced degradation. Everything else is parity.

### Why Custom xDS (Not `DestinationRule` / `ServiceEntry`)

| Approach | Verdict for our use-case |
| --- | --- |
| `DestinationRule.localityLbSetting.distribute` | Static, configured per-service. Doesn't react to cold starts, noisy neighbours, GC. Same failure mode as Envoy's stock heuristic. |
| Dynamic `ServiceEntry` controller | Workable but pushes through `kube-apiserver` etcd — won't scale to per-second updates across thousands of services. |
| **Custom xDS EDS plane + LRS** | **Push frequency decoupled from k8s API. Reacts to real load. Built-in fallback to host-count if the custom plane is unavailable.** |

### Single-Cluster Benefit

Even before we go multi-cluster, this fixes the **single biggest production hazard with stock zone-aware routing on heterogeneous-zone clusters** — the cold-pod death spiral — and recovers ~75–85% same-zone traffic without overload.

### Multi-Cluster Benefit

In a multi-cluster ambient mesh, the same EDS plane can publish **cross-cluster locality** (cluster + region + zone) and weight cross-cluster spillover the same way it weights cross-zone spillover. This is exactly what ambient's east-west gateway + baggage-header metadata exchange (new in 1.29) enables.

---

## Why The Two Tracks Compose

```
                  ┌─────────────────────────────────────┐
                  │  Track 1 + 2 — Ambient data plane   │
                  │  (ztunnel + waypoints, multi-cluster)│
                  └──────────────┬──────────────────────┘
                                 │
                                 │  receives EDS from
                                 ▼
                  ┌─────────────────────────────────────┐
                  │  Track 3 — Custom xDS EDS plane     │
                  │  (LRS-measured, dynamic capacity)   │
                  └─────────────────────────────────────┘
```

- Waypoints are full Envoys — they speak vanilla xDS, so they consume our custom EDS exactly like sidecars would.
- Fewer moving parts to retrofit: waypoint count ≪ sidecar count, so static-bootstrap injection and `EnvoyFilter`-based EDS redirection roll out across a handful of Deployments instead of every pod.

---

## Proposal: Phased Plan

### Phase 1 — Lab: Stand up Ambient in a Single Cluster

- Install Istio 1.29 with ambient profile in the lab cluster.
- Pick one non-critical namespace, label it `dataplane-mode=ambient`, restart pods.
- Validate: mTLS, AuthorizationPolicy, metrics, traces (especially span continuity — see KubeCon talk on tracing cost).
- Compare per-node memory/CPU vs sidecar baseline.

### Phase 2 — Lab: Custom xDS PoC (EDS only)

- Stand up a minimal `go-control-plane` server serving EDS for one service.
- Inject as a static cluster via `sidecar.istio.io/bootstrapOverride` ConfigMap on the waypoint.
- Add `EnvoyFilter` to patch `eds_cluster_config` for the target cluster only.
- Implement LRS receiver + the `capacity(X) × ramp(X)` model.
- Drive synthetic cold-start / degradation / recovery scenarios (Spotify's experimental matrix).

### Phase 3 — Production: Sidecar → Ambient, Namespace by Namespace

- Roll ambient to production, one namespace at a time, low-risk first.
- Keep sidecar control plane installed in parallel (co-existence is supported).
- Decommission sidecar-injection webhook only when the last namespace migrates.

### Phase 4 — Production: Custom EDS Plane for Hot Services

- Start with services that have history of zone-aware-routing incidents (cold-start sensitive, JVM-heavy, GPU-heterogeneous zones).
- Keep istiod fallback (`ads: {}`) as the default; switch services in one at a time via `EnvoyFilter` selector.
- Measure: cross-zone traffic % (target: ↑ same-zone to 75–85%), p99 latency, cold-start error rates, GCP inter-zone egress bill.

### Phase 5 — Multi-Cluster Ambient + Cross-Cluster EDS

- Bring a second cluster online; configure ambient multi-primary multi-network.
- Extend the custom EDS plane to publish `cluster + zone` locality.
- Use cross-cluster locality as a *lower priority* than cross-zone — i.e., spill within cluster first, then across cluster, weighted by residual capacity.

---

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Tracing semantics change moving from sidecar → waypoint | Validate span propagation in Phase 1; the KubeCon "Real Cost of Sidecar-less Tracing" talk's checklist is our starting checklist. |
| Custom xDS plane becomes a SPOF | Same pattern as Spotify: **fallback to host-count distribution** when the custom plane is unavailable. Envoy keeps the last-known EDS. |
| `EnvoyFilter` fragility across Istio upgrades | Scope the filter narrowly (single workload selector), gate per-service, version-pin Istio in the env that uses it. |
| Ambient multicluster is fresh Beta | Lab-validate east-west gateway, peer metadata propagation, and failure modes (gateway down, network partition) before any production rollout. |
| LRS reporting overhead at scale | Spotify rejected per-message PubSub for this reason — use gRPC bidi streaming, batch every 10s, aggregate in the control plane (not per-message). |

---

## References

### KubeCon EU 2026 Amsterdam
- [Istio at KubeCon Europe 2026 — official Istio blog](https://istio.io/latest/blog/2026/kubecon-eu/)
- [Istio Brings Future-Ready Service Mesh to the AI Era — Ambient Multicluster, Inference Extension](https://www.cncf.io/announcements/2026/03/25/istio-brings-future-ready-service-mesh-to-the-ai-era-with-new-ambient-multicluster-gateway-api-inference-extension-and-more/)
- [Ambient Multi-Network Multicluster Support is Now Beta](https://istio.io/latest/blog/2026/ambient-multinetwork-multicluster-beta/)
- [KubeCon EU 2026 Schedule](https://kccnceu2026.sched.com/)

### Istio Ambient
- [Istio Ambient Overview](https://istio.io/latest/docs/ambient/overview/)
- [Sidecar or Ambient?](https://istio.io/latest/docs/overview/dataplane-modes/)
- [Ambient Data Plane Architecture](https://istio.io/latest/docs/ambient/architecture/data-plane/)
- [ztunnel Architecture (istio/istio)](https://github.com/istio/istio/blob/master/architecture/ambient/ztunnel.md)
- [Install Ambient Multi-Primary Multi-Network](https://istio.io/latest/docs/ambient/install/multicluster/multi-primary_multi-network/)
- [Introducing Multicluster Support for Ambient (Alpha → Beta)](https://istio.io/latest/blog/2025/ambient-multicluster/)

### Custom xDS / Spotify
- *Smart Routing at Scale — How Spotify's xDS Control Plane Cut 75% of Cross-Zone Traffic* — slides referenced above
- *How We Moved Spotify To a Proxyless gRPC Service Mesh* — Erik Lindblad & Erica Manno, KubeCon EU 2025
- [Envoy xDS REST and gRPC protocol](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol)
- [Envoy Locality-Weighted Load Balancing](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/locality_weight)
- [istio/samples/custom-bootstrap — bootstrap override mechanism](https://github.com/istio/istio/tree/master/samples/custom-bootstrap)
- [Istio EnvoyFilter reference](https://istio.io/latest/docs/reference/config/networking/envoy-filter/)
- [go-control-plane (custom xDS server library)](https://github.com/envoyproxy/go-control-plane)
