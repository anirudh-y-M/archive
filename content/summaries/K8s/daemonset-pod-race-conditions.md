---
title: "Summary: DaemonSet Pod Race Conditions"
---

> **Full notes:** [[notes/K8s/daemonset-pod-race-conditions|DaemonSet Pod Race Conditions →]]

## Key Concepts

### The Problem

When a DaemonSet (e.g., mitmproxy) runs alongside regular pods (e.g., CI runners), there is a race condition during **node scale-up**: a new node joins the cluster, and both the DaemonSet pod and a runner pod get scheduled simultaneously. The runner may start before the DaemonSet pod is ready, hitting "connection refused" when trying to use the proxy. This is the core problem -- two independently scheduled pods with an implicit ordering dependency.

### Solution 1: Init Container (Simple)

Add an init container to the runner pod that polls `nc -z ${NODE_IP} <port>` in a loop until the DaemonSet pod's port is reachable. Uses the Kubernetes Downward API (`status.hostIP`) to inject the node's IP. The main containers won't start until the init container exits successfully. Pros: self-contained, no extra RBAC. Cons: adds startup latency from polling, and if the DaemonSet crashes permanently, the runner hangs forever. Always add a timeout (e.g., 60s) that exits 0 to avoid infinite hangs -- the runner proceeds without the proxy rather than blocking indefinitely.

### Solution 2: Taint/Toleration (Scheduling-Level)

Prevent the race entirely at the scheduler level. Taint the node pool with `proxy-not-ready=true:NoSchedule`. The DaemonSet tolerates the taint (so it schedules anyway). Once the DaemonSet pod is ready, a `postStart` lifecycle hook removes the taint via `kubectl taint nodes`. Runner pods don't tolerate the taint, so they can't be scheduled until it's gone. Pros: strongest guarantee -- runners never start on a node without a ready proxy. Cons: requires RBAC for the DaemonSet to patch node taints, and if the DaemonSet crashes, the taint returns and blocks all new pods on that node.

### Solution 3: internalTrafficPolicy: Local (Complementary)

Setting `internalTrafficPolicy: Local` on a Service tells kube-proxy to only route traffic to pods on the same node. This keeps traffic node-local (important for per-node observability). **Important caveat:** this does NOT solve the race condition. If the local DaemonSet pod isn't ready, there are zero eligible endpoints and the connection fails. Unlike the default policy, `Local` has no fallback to pods on other nodes -- it actually makes the race worse if used alone. Always pair it with solution 1 or 2.

### Real-World Example: Istio Sidecar Injection

Istio solves the same race condition at scale. Every pod gets an Envoy sidecar proxy injected. The startup order is: (1) `istio-init` init container sets up iptables rules redirecting all inbound/outbound traffic through Envoy, (2) `istio-proxy` sidecar starts, (3) app container starts. The iptables rules work at the kernel level -- traffic is captured regardless of whether the app knows about the proxy. Even if the app starts before Envoy is fully ready, traffic queues in the kernel until Envoy accepts connections.

```
# What istio-init does (simplified):
iptables -t nat -A OUTPUT -p tcp -j REDIRECT --to-port 15001     # outbound → Envoy
iptables -t nat -A PREROUTING -p tcp -j REDIRECT --to-port 15006  # inbound → Envoy
```

### Why Istio Uses Init Containers Instead of Taints

Three reasons: (1) **Scale** -- Istio runs on every pod (thousands), making taint lifecycle management impractical. (2) **Transparency** -- apps don't need `http_proxy` env vars; iptables redirect is invisible. (3) **No DaemonSet dependency** -- the sidecar runs in the same pod, so there's no cross-pod race.

### Key Difference: Istio vs DaemonSet Proxy

| | Istio | DaemonSet Proxy (mitmproxy) |
|---|---|---|
| Proxy location | Same pod (sidecar) | Same node (DaemonSet) |
| Traffic capture | iptables redirect (kernel) | `http_proxy` env var (app-level) |
| Init container role | Set up iptables rules | Poll until proxy port is reachable |
| Race risk | Minimal (co-scheduled) | Real (separate pod scheduling) |

Istio's sidecar is co-scheduled in the same pod -- they always start together. A DaemonSet proxy is a separate pod on the same node, creating a real cross-pod race.

### holdApplicationUntilProxyStarts

Even with Istio's init container, there's a brief window where the app starts before Envoy is fully ready. Istio added `holdApplicationUntilProxyStarts: true` to delay the app container until Envoy's readiness probe passes -- the same concept as the init container polling approach, but built into Istio's injection logic.

### Recommendation

For **debugging/observability proxies** (dev/lab): use the init container approach. Simple, self-contained, and the timeout fallback means runners aren't permanently blocked. For **production-critical proxies** (traffic MUST go through the proxy): use the taint/toleration approach for the stronger scheduling-level guarantee. Either way, add `internalTrafficPolicy: Local` on the Service.

## Quick Reference

```
Node scale-up timeline:

  Without fix:               With init container:        With taint/toleration:
  ┌─────────────┐            ┌─────────────┐            ┌───────────────────┐
  │ Runner starts│            │ Init: poll   │──→ wait   │ Taint: NoSchedule │
  │ Proxy: ???  │ ← FAIL     │ Proxy ready  │           │ DaemonSet starts  │
  │ Proxy ready │            │ Runner starts│ ← OK      │ Taint removed     │
  └─────────────┘            └─────────────┘            │ Runner scheduled  │ ← OK
                                                        └───────────────────┘
```

| Approach | Guarantee Level | Complexity | Best For |
|---|---|---|---|
| Init container | Eventual (polling) | Low | Dev/lab proxies |
| Taint/toleration | Scheduling-level (absolute) | High (RBAC needed) | Production-critical proxies |
| internalTrafficPolicy: Local | Keeps traffic node-local | Low | Complementary only (pair with above) |

## Key Takeaways

- Node scale-up is the primary trigger for DaemonSet race conditions -- both pods get scheduled simultaneously on a fresh node
- Init container with `nc -z` polling is the simplest fix; always add a timeout to prevent infinite hangs
- Taint/toleration is the strongest guarantee but requires RBAC and has failure-mode complexity (stuck taints block all pods)
- `internalTrafficPolicy: Local` is NOT a race fix -- it removes fallback to other nodes, making the race worse if used alone
- Istio avoids the cross-pod race entirely by co-locating the proxy as a sidecar and using kernel-level iptables redirection
- `holdApplicationUntilProxyStarts` is Istio's built-in equivalent of the init container polling pattern
- The fundamental difference: sidecar proxies (same pod) eliminate the race; DaemonSet proxies (same node, different pod) have a real scheduling race
