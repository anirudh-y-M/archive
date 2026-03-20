---
title: "Summary: Kubernetes Core Concepts"
---

> **Full notes:** [[notes/K8s/kubernetes|Kubernetes Concepts →]]

## Key Concepts

**DaemonSet** -- Runs exactly one pod per node (or per matching node). Pods auto-created on new nodes, auto-removed when nodes leave. Used for node-level infra: log collectors, monitoring agents, network proxies.

**Node Pools** (GKE) -- Groups of VMs with different configs (machine type, disk, labels, taints) within a single cluster. Lets you separate workloads by resource needs or network requirements.

**nodeSelector** -- Pod-level field that constrains scheduling to nodes with specific labels. Simple affinity: "only run me on nodes labeled `pool=critical`."

**Taints and Tolerations** -- Taints are "keep out" signs on nodes. Tolerations are "I'm allowed past that sign" on pods. Two match modes: `Equal` (exact key+value) and `Exists` (any value for that key).

## Quick Reference

```
DaemonSet behavior:

  Node A          Node B          Node C (new)
  ┌──────┐        ┌──────┐        ┌──────┐
  │ ds-pod│        │ ds-pod│        │ ds-pod│ ← auto-scheduled
  └──────┘        └──────┘        └──────┘
```

| Scheduling Mechanism | Set On | Purpose |
|---|---|---|
| `nodeSelector` | Pod | "Only schedule me on nodes with this label" |
| Taint | Node | "Keep out unless tolerated" |
| Toleration | Pod | "I can handle this taint" |

| Toleration Operator | Behavior |
|---|---|
| `Equal` | Matches specific key + value |
| `Exists` | Matches key regardless of value |

**NAT connection:** Different node pools can use different subnets, which means different NAT IPs. Steering workloads to specific pools controls their outbound IP.

## Key Takeaways

- DaemonSets guarantee one pod per node -- essential for node-level infrastructure like proxies and log agents
- Node pools let you isolate workloads by machine type, labels, and network config (different subnets = different NAT IPs)
- `nodeSelector` is the simplest scheduling constraint; taints/tolerations are the inverse (deny-by-default)
- Use `operator: Exists` on tolerations to match all values of a taint key with a single rule
