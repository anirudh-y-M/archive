---
title: "Summary: Kubernetes Core Concepts"
---

> **Full notes:** [[notes/K8s/kubernetes|Kubernetes Concepts →]]

## Key Concepts

### DaemonSet

A Deployment says "run N copies somewhere." A DaemonSet says "run exactly one copy on every node" (or every node matching a label selector). Pods are auto-created when nodes join the cluster and auto-removed when nodes leave. Used for node-level infrastructure that must run on every machine: log collectors, monitoring agents, network proxies. For the proxy use case, a DaemonSet means each node gets its own proxy instance -- runners access it at the node's IP, keeping traffic local and avoiding a single bottleneck.

### Node Pools

A GKE cluster can have multiple **node pools** -- groups of VMs with different configurations (machine type, disk, labels, taints). This lets you separate workloads by resource needs or network requirements. For example, a "default" pool for general workloads and a "critical" pool for important CI jobs.

### nodeSelector and Tolerations

Two mechanisms for controlling which pods land on which nodes:

**nodeSelector** is a pod-level field that constrains scheduling to nodes with specific labels. Simple affinity: `nodeSelector: {pool: critical}` means the pod only runs on nodes labeled `pool=critical`.

**Taints and tolerations** work in the opposite direction. A **taint** on a node is a "keep out" sign -- don't schedule anything here unless it explicitly tolerates the taint. A **toleration** on a pod says "I'm allowed past that sign." Two matching modes: `operator: Equal` (default) matches a specific taint key+value and requires one toleration per value. `operator: Exists` matches a taint key regardless of value -- one toleration covers all values of that key (e.g., `{key: runner-type, operator: Exists, effect: NoSchedule}` tolerates `runner-type=android`, `runner-type=image-cached`, etc.).

### Why This Matters for NAT

Different node pools can use different subnets. Different subnets can have different NAT rules and outbound IPs. By steering workloads to specific node pools via `nodeSelector` and taints/tolerations, you control which NAT IPs they use -- separating critical traffic from noisy traffic.

## Quick Reference

```
DaemonSet behavior:

  Node A          Node B          Node C (new)
  ┌──────┐        ┌──────┐        ┌──────┐
  │ ds-pod│        │ ds-pod│        │ ds-pod│ ← auto-scheduled on join
  └──────┘        └──────┘        └──────┘

  Node D (removed)
  ┌──────┐
  │ ds-pod│ ← auto-removed on leave
  └──────┘
```

```
Scheduling control:

  nodeSelector (pod-level):    "Only run me on nodes with label X"
  Taint (node-level):         "Keep out unless tolerated"
  Toleration (pod-level):     "I can handle taint X"

  Node pool → Subnet → NAT IP
  Steering pods to specific pools = controlling their outbound IP
```

| Scheduling Mechanism | Set On | Direction | Purpose |
|---|---|---|---|
| `nodeSelector` | Pod | Pod selects node | "Only schedule me on nodes with this label" |
| Taint | Node | Node rejects pods | "Keep out unless tolerated" |
| Toleration | Pod | Pod accepts taint | "I can handle this taint" |

| Toleration Operator | Behavior | Use Case |
|---|---|---|
| `Equal` (default) | Matches specific key + value | One taint value per toleration |
| `Exists` | Matches key regardless of value | One toleration covers all values of a key |

## Key Takeaways

- DaemonSets guarantee one pod per node -- essential for node-level infrastructure like proxies, log agents, and monitoring
- Node pools let you isolate workloads by machine type, labels, and network config (different subnets = different NAT IPs)
- `nodeSelector` is the simplest scheduling constraint (positive selection); taints/tolerations are the inverse (deny-by-default)
- Use `operator: Exists` on tolerations to match all values of a taint key with a single rule -- avoids maintaining one toleration per value
- The node pool -> subnet -> NAT IP chain is how you control outbound IPs for specific workloads in GKE
