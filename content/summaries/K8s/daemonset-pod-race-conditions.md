---
title: "Summary: DaemonSet Pod Race Conditions"
---

> **Full notes:** [[notes/K8s/daemonset-pod-race-conditions|DaemonSet Pod Race Conditions →]]

## Key Concepts

**The race** -- During node scale-up, a DaemonSet pod (e.g., proxy) and a regular pod (e.g., CI runner) get scheduled simultaneously. The runner may start before the DaemonSet pod is ready, causing "connection refused" failures.

**Init container fix (simple)** -- Add an init container that polls `nc -z ${NODE_IP} <port>` until the DaemonSet pod is reachable. Uses the Downward API (`status.hostIP`) to get the node IP. Add a timeout to avoid hanging forever.

**Taint/toleration fix (strong)** -- Taint nodes with `NoSchedule`, let the DaemonSet tolerate it, and have the DaemonSet remove the taint once ready. Regular pods can't schedule until the taint is gone. Stronger guarantee but more complex (needs RBAC for node patching).

**internalTrafficPolicy: Local** -- Keeps Service traffic on the same node. Does NOT solve the race -- if the local pod isn't ready, there are zero endpoints (no fallback). Use alongside one of the above fixes.

**Istio comparison** -- Istio solves the same problem differently: the proxy (Envoy) runs as a sidecar in the same pod, and an init container sets up iptables rules at the kernel level. No cross-pod race because they're co-scheduled.

## Quick Reference

```
Node scale-up timeline:

  Without fix:               With init container:
  ┌─────────────┐            ┌─────────────┐
  │ Runner starts│            │ Init: poll   │──→ wait ──→ ready!
  │ Proxy: ???  │ ← FAIL     │ Runner starts│ ← proxy is up
  │ Proxy ready │            │ Proxy ready  │
  └─────────────┘            └─────────────┘
```

| Approach | Guarantee | Complexity | Best For |
|---|---|---|---|
| Init container | Eventual (polling) | Low | Dev/lab proxies |
| Taint/toleration | Scheduling-level | High | Production-critical proxies |
| internalTrafficPolicy | Keeps traffic local | Low | Complementary (pair with above) |

| | Istio Sidecar | DaemonSet Proxy |
|---|---|---|
| Proxy location | Same pod | Same node |
| Traffic capture | iptables (kernel) | http_proxy env var |
| Race risk | Minimal | Real |

## Key Takeaways

- Node scale-up is the primary trigger for DaemonSet race conditions -- both pods get scheduled at the same time on a fresh node
- Init container with `nc -z` polling is the simplest fix; always add a timeout to prevent infinite hangs
- Taint/toleration is the strongest guarantee but requires RBAC and has failure-mode complexity (stuck taints block all pods)
- `internalTrafficPolicy: Local` is not a race fix -- it removes fallback to other nodes, making the race worse if used alone
- Istio avoids this entirely by co-locating the proxy as a sidecar + using kernel-level iptables redirection
