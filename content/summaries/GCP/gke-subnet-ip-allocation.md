---
title: "Summary: GKE Subnet & IP Allocation"
---

> **Full notes:** [[notes/GCP/gke-subnet-ip-allocation|GKE Subnet & IP Allocation for Node Pools →]]

## Key Concepts

In VPC-native GKE, IPs come from three separate pools on the subnet:

| Component | Source | Changeable per node pool? |
|-----------|--------|--------------------------|
| **Nodes** | Primary range (`ip_cidr_range`) | Yes |
| **Pods** | Secondary range (Alias IP) | Yes |
| **Services** | Secondary range (cluster-wide) | No |

**Per-node-pool override:** A node pool can use a different subnet via `network_config.subnetwork` + `network_config.pod_range` -- must be same VPC and region.

**Multi-subnet clusters:** GKE auto-selects subnets based on IP availability -- you lose control over placement. Avoid if you need deterministic subnet assignment.

**Primary vs Secondary ranges** are siblings, not parent/child. No overlap allowed. `pod_range` must reference a secondary range name, never a primary range or raw CIDR.

## Quick Reference

```
Subnet Resource
 |-- Primary Range: 10.0.0.0/20      --> Node IPs (VM NICs)
 |-- Secondary "pods": 10.4.0.0/14   --> Pod IPs (Alias IP)
 +-- Secondary "services": 10.8.0.0/20 --> ClusterIP
```

**Common gotcha:** Each node reserves a full CIDR block (default /24 = 256 IPs) for pods regardless of actual usage. A /14 pod range with /24-per-node supports only ~1,024 nodes max.

**Shared VPC:** GKE service account needs `compute.networkUser` on every subnet it uses (including overrides).

## Key Takeaways

- Pods use Alias IPs on secondary ranges -- this makes the cluster "VPC-native" with no overlay network needed
- You can override subnet per node pool, but Services range is always cluster-wide and immutable
- Multi-subnet cluster feature removes your control over which subnet a node pool lands on -- use per-node-pool `network_config` if you need deterministic placement
- Pod IP exhaustion happens long before node IP exhaustion due to per-node block reservation
- Reducing `max_pods_per_node` (e.g., to 32 = /26 block) conserves pod range at the cost of pod density
