---
title: "Summary: GKE Subnet & IP Allocation"
---

> **Full notes:** [[notes/GCP/gke-subnet-ip-allocation|GKE Subnet & IP Allocation for Node Pools →]]

## Key Concepts

### How GKE Assigns IPs

In a VPC-native GKE cluster, nodes get internal IPs from the subnet's **primary range** (just like any Compute Engine VM). Pods get IPs from a **secondary range** via Alias IP -- GKE carves a CIDR slice (e.g., `/24`) from the secondary range per node, and pods on that node draw from it. The VPC router natively knows which node owns which pod IP, so no overlay network or encapsulation is needed. Services (ClusterIP) use a separate **secondary range** that is cluster-wide and immutable.

| Component | IP Source | Defined In |
|-----------|-----------|------------|
| Node (VM) | Primary range | `ip_cidr_range` |
| Pods | Secondary range A | `secondary_ip_range` block |
| Services | Secondary range B | `secondary_ip_range` block |

**Common gotcha:** Each node reserves a whole CIDR block (default `/24` = 256 IPs) for pods regardless of actual pod count. You can exhaust the pod range long before running out of node IPs.

### Linking a Node Pool to Subnet Ranges

The cluster-level `ip_allocation_policy` maps secondary ranges by **name** (not CIDR). The `cluster_secondary_range_name` and `services_secondary_range_name` strings must exactly match the `range_name` values in the subnet's `secondary_ip_range` blocks. The cluster must also set `networking_mode = "VPC_NATIVE"`.

### Per-Node-Pool Subnet and Pod Range Override

A node pool can override the cluster's default subnet and pod range using the `network_config` block. Setting `subnetwork` tells VMs to pull primary IPs from that subnet, and `pod_range` specifies a secondary range **on that same subnet**. Constraints: same VPC, same region, and Services range stays cluster-wide (cannot be changed per node pool).

| Resource | Can be changed per node pool? | Source |
|----------|------------------------------|--------|
| Node IP | Yes | Primary range of `network_config.subnetwork` |
| Pod IP | Yes | Secondary range of `network_config.subnetwork` |
| Service IP | No | Secondary range at cluster level |

**Use cases:** address exhaustion (original ranges are full), network isolation (different firewall rules per subnet), NAT routing (different Cloud NAT gateways with different egress IPs per subnet).

### Multi-Subnet Clusters

GKE supports registering additional subnets at the cluster level for IP exhaustion scaling. The critical limitation: **you cannot control which non-default subnet a new node pool uses** -- GKE evaluates IP availability across all registered subnets and auto-selects. The Terraform `subnetwork` field in `network_config` may be ignored in multi-subnet mode. Once assigned, a node pool's subnet is immutable. If you need deterministic subnet placement, avoid multi-subnet clusters and use per-node-pool `network_config` overrides instead.

### Primary vs Secondary Ranges

Secondary ranges are **siblings** of the primary range, not children or subsets. Google Cloud strictly prohibits overlap between them. `pod_range` must be a secondary range **name** (a string label), not a raw CIDR block, and it cannot point to a primary range. Primary ranges are reserved exclusively for VM network interfaces (node IPs); pod IPs use Alias IP which only works with secondary ranges.

```
Subnet Resource
 +-- Primary Range: 10.0.0.0/20       --> Node IPs (VM NICs)
 +-- Secondary "pods": 10.4.0.0/14    --> Pod IPs (Alias IPs)
 +-- Secondary "services": 10.8.0.0/20 --> Service IPs (ClusterIP)
```

### Shared VPC Permissions

In a Shared VPC (host project owns the network, service projects run GKE), the GKE service account in the service project needs the `compute.networkUser` role on every subnet it uses, including any per-node-pool override subnets.

## Quick Reference

**IP exhaustion math:** With a `/14` pod range (262,144 addresses) and `/24` per-node allocation, you support at most **1,024 nodes** -- even if most nodes run only 10 pods each. Reducing `max_pods_per_node` to 32 uses a `/26` (64 addresses) per node, supporting ~4,096 nodes but limiting pod density.

**Deterministic subnet placement decision:**

```
Need control over which subnet a node pool uses?
  |
  +-- YES --> Use per-node-pool network_config.subnetwork
  |           (standard single-subnet cluster)
  |
  +-- NO  --> Multi-subnet cluster is fine
              (GKE auto-selects based on IP availability)
```

## Key Takeaways

- Pods use Alias IPs on secondary ranges -- this makes the cluster "VPC-native" with no overlay network
- You can override subnet per node pool, but Services range is always cluster-wide and immutable
- Multi-subnet cluster feature removes your control over subnet placement -- use `network_config` if you need determinism
- Pod IP exhaustion happens long before node IP exhaustion due to per-node block reservation
- Reducing `max_pods_per_node` conserves pod range at the cost of pod density
- Primary and secondary ranges are siblings with no overlap allowed; `pod_range` must reference a secondary range name
- Shared VPC requires `compute.networkUser` on every subnet the GKE service account touches
