---
title: "GKE Subnet & IP Allocation for Node Pools"
---

## How GKE Assigns IPs

In a VPC-native GKE cluster, IP assignment follows a strict hierarchy tied to the subnet's ranges:

**Nodes** get their internal IPs from the subnet's **primary range** (`ip_cidr_range`). This is identical to how any Compute Engine VM gets its IP — GKE creates a VM, and Google Cloud assigns it an address from the primary pool.

**Pods** get their IPs from a **secondary range** on the subnet, via Alias IP. GKE carves out a CIDR slice (e.g., a `/24`) from the secondary range and attaches it to each node's network interface. Every pod on that node draws from that slice. Because these are VPC-native alias IPs, the VPC router natively knows which node owns which pod IP — no overlay network or encapsulation needed.

**Services** (ClusterIP) get their IPs from a separate **secondary range**, also defined on the subnet. This range is cluster-wide and immutable per node pool.

| Component | IP Source | Defined In |
| --- | --- | --- |
| Node (VM) | Primary range | `ip_cidr_range` |
| Pods | Secondary range A | `secondary_ip_range` block |
| Services (ClusterIP) | Secondary range B | `secondary_ip_range` block |

A common gotcha: each node reserves a whole chunk of pod IPs (e.g., a `/24` = 256 addresses) regardless of how many pods are actually running. You can exhaust the pod range long before running out of node IPs.

---

## Linking a Node Pool to Subnet Ranges

The cluster-level `ip_allocation_policy` maps secondary ranges by **name** (not CIDR):

```hcl
resource "google_container_cluster" "primary" {
  name       = "my-gke-cluster"
  location   = var.region
  network    = data.google_compute_network.shared_vpc.self_link
  subnetwork = google_compute_subnetwork.shared_vpc_subnetwork.self_link

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods-range"      # matches range_name in subnet
    services_secondary_range_name = "services-range"   # matches range_name in subnet
  }

  networking_mode = "VPC_NATIVE"
}
```

The strings passed to `cluster_secondary_range_name` and `services_secondary_range_name` must **exactly match** the `range_name` values defined in the subnet's `secondary_ip_range` blocks.

---

## Per-Node-Pool Subnet and Pod Range Override

A node pool can override the cluster's default subnet and pod range using `network_config`:

```hcl
resource "google_container_node_pool" "isolated_pool" {
  name     = "isolated-pool"
  cluster  = google_container_cluster.primary.id
  location = var.region

  network_config {
    subnetwork           = "projects/host-project/regions/us-central1/subnetworks/isolated-subnet"
    pod_range            = "isolated-pods-range"
    enable_private_nodes = true
  }

  node_config {
    machine_type = "e2-medium"
  }
}
```

When you set `subnetwork` in `network_config`, the VMs in this node pool pull their primary IPs from that subnet's primary range. The `pod_range` must be a secondary range **on that same subnet** — you cannot point to a secondary range on a different subnet.

### Constraints

- **Same VPC**: The override subnet must be in the same VPC as the cluster.
- **Same Region**: The subnet must be in the same region as the cluster.
- **Services range stays cluster-wide**: You cannot change the Services (ClusterIP) range per node pool — it's set once at the cluster level.

| Resource | Can be changed per node pool? | Source |
| --- | --- | --- |
| Node IP | Yes | Primary range of `network_config.subnetwork` |
| Pod IP | Yes | Secondary range of `network_config.subnetwork` |
| Service IP | No | Secondary range defined at cluster level |

### Use cases for per-node-pool subnet override

- **Address exhaustion**: The original pod range is full, and a new secondary range was added to the subnet (or a new subnet was created).
- **Network isolation**: Front-end and back-end nodes in different subnets for firewall rule separation.
- **NAT routing**: Different subnets can be routed through different Cloud NAT gateways with different egress IPs. See [[notes/Networking/cloud-nat-and-vpc-networking|Cloud NAT & VPC Networking]].

---

## Multi-Subnet Clusters (GKE Feature)

GKE supports adding "additional subnets" to a cluster for IP exhaustion scaling. When you register additional subnets at the cluster level, GKE manages them as a shared pool.

**The critical limitation:** you cannot control which non-default subnet a new node pool uses. GKE evaluates IP availability across all registered subnets and automatically selects the one with the best availability.

From the [GCP documentation](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/multi-subnet-cluster):

> You can't control which non-default subnet a new node pool uses. For example, if your cluster has a default subnet and two non-default subnets, you can't specify which of the non-default subnets a new node pool should use.

The Terraform `subnetwork` field in `network_config` may be ignored in multi-subnet mode — GKE overrides it with its own placement logic based on IP utilization. Once a node pool is assigned a subnet, it is immutable.

**If you need deterministic subnet placement** (e.g., for security or firewall reasons), do not use the multi-subnet cluster feature. Use separate clusters or the per-node-pool `network_config.subnetwork` override on a standard (single-subnet) cluster instead.

---

## Primary vs Secondary Ranges: The Sibling Relationship

Secondary ranges are **not** children or subsets of the primary range. They are siblings — completely independent CIDR blocks attached to the same subnet resource.

**No overlap allowed**: Google Cloud strictly prohibits primary and secondary ranges from overlapping. If you define a primary range of `10.0.0.0/16`, you cannot create a secondary range of `10.0.1.0/24`. The API will reject it with an overlap error.

**`pod_range` must be a secondary range name, not a CIDR**: The GKE API expects the `range_name` string (a label), not a raw CIDR block. It looks up that name in the subnet's secondary range definitions.

**`pod_range` cannot be a primary range**: Primary ranges are reserved exclusively for VM network interfaces (node IPs). Pod IPs use the Alias IP mechanism, which only works with secondary ranges.

```
Subnet Resource
├── Primary Range: 10.0.0.0/20    → Node IPs (VM NICs)
├── Secondary Range "pods": 10.4.0.0/14    → Pod IPs (Alias IPs on nodes)
└── Secondary Range "services": 10.8.0.0/20    → Service IPs (ClusterIP)
```

If you want pods isolated in their own address space, create a subnet with a small primary range (e.g., `/28` for nodes) and a large secondary range (e.g., `/14` for pods). They remain logically separated in the VPC routing table even though they belong to the same subnet resource.

---

## Shared VPC Permissions

When using a Shared VPC (host project owns the network, service projects run GKE), the GKE service account in the service project needs the `compute.networkUser` role on the specific subnet in the host project. If you override the subnet per node pool, the service account needs this role on the new subnet as well.

---

## See also

- [[notes/Networking/cloud-nat-and-vpc-networking|Cloud NAT & VPC Networking]]
- [[notes/K8s/kubernetes|Kubernetes Concepts]]
- [GKE Multi-Subnet Clusters](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/multi-subnet-cluster)
- [GKE VPC-Native Clusters](https://cloud.google.com/kubernetes-engine/docs/concepts/alias-ips)
- [Terraform: google_container_node_pool](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/container_node_pool)

---

## Interview Prep

### Q: In a VPC-native GKE cluster, how do nodes, pods, and services each get their IP addresses?

**A:** The subnet has one primary range and one or more secondary ranges. Nodes (the Compute Engine VMs) get their internal IPs from the **primary range**, exactly like any regular VM. For pods, GKE uses **Alias IP ranges** — each node is allocated a slice (e.g., a `/24`) from a designated **secondary range**, and every pod scheduled on that node draws an IP from that slice. Because these are alias IPs, the VPC router natively knows which node owns which pod IP without any overlay network or encapsulation. Services (ClusterIP) get virtual IPs from a separate **secondary range** defined at cluster creation. The key architectural point is that alias IPs are attached to the node's network interface as additional addresses, so the VPC routing table can route pod traffic directly to the correct node — this is what makes GKE clusters "VPC-native" as opposed to older routes-based clusters that required custom static routes.

### Q: Can a GKE node pool use a different subnet than the rest of the cluster?

**A:** Yes, via the `network_config` block on `google_container_node_pool`. You can set `subnetwork` to point to a different subnet and `pod_range` to a secondary range on that subnet. The constraints are: the subnet must be in the **same VPC** and **same region** as the cluster, and the `pod_range` must be a secondary range defined on that specific subnet (you can't cross-reference ranges from different subnets). The Services (ClusterIP) range remains cluster-wide and cannot be overridden per node pool. This is commonly used for IP exhaustion (original ranges are full) or network isolation (different firewall rules per subnet). However, if you're using the GKE **multi-subnet cluster** feature (which registers additional subnets at the cluster level for automatic scaling), you lose this control — GKE auto-selects the subnet based on IP availability and ignores your `subnetwork` field.

### Q: Can `pod_range` point to a primary CIDR range of another subnet? Can a secondary range be a subset of the primary range?

**A:** No to both. `pod_range` must be a **secondary range name** — a string label that matches a `range_name` in the subnet's `secondary_ip_range` block. The GKE API does not accept raw CIDR blocks in this field. Primary ranges are reserved exclusively for VM network interfaces (node IPs). Pod IPs use the Alias IP mechanism, which only works with secondary ranges.

For the second part: secondary ranges and the primary range are **siblings**, not parent/child. Google Cloud strictly prohibits overlap between them. If your primary range is `10.0.0.0/16`, you cannot create a secondary range of `10.0.1.0/24` — the API will reject it with an overlap error. They are independent CIDR blocks that happen to be attached to the same subnet resource. The primary range handles node traffic; secondary ranges handle pod and service traffic. They coexist on the same subnet but occupy completely separate address spaces in the VPC routing table.

### Q: What happens when you use the GKE multi-subnet cluster feature? Can you control which subnet a new node pool lands on?

**A:** No. When you register additional subnets at the cluster level (via `additional_ip_ranges`), GKE manages them as a shared pool for IP exhaustion scaling. When you create a new node pool, GKE evaluates IP availability across all registered subnets — default plus additional — and automatically selects the one with the best availability. You cannot force a node pool onto a specific non-default subnet. The Terraform `subnetwork` field in `network_config` may be overridden by GKE's placement logic. Once assigned, the subnet is immutable for that node pool.

This matters for teams that need deterministic subnet placement for security or firewall reasons. If you need to control exactly which subnet a node pool uses, don't use multi-subnet clusters. Instead, use a standard cluster and override the subnet per node pool via `network_config.subnetwork`, or use separate clusters entirely.

### Q: Why does each node reserve a whole block of pod IPs even if it's running only a few pods?

**A:** Because of how Alias IP allocation works. When GKE schedules a node, it pre-allocates a contiguous CIDR block (typically a `/24` = 256 addresses, configurable via `max_pods_per_node`) from the pod secondary range and attaches it to the node's network interface as an alias range. This block is reserved for the lifetime of the node, regardless of actual pod count. The VPC routing table has a single entry for that block pointing to that node — it doesn't track individual pod IPs.

This design enables fast pod scheduling (no need to allocate individual IPs from a central pool) and simple routing (one route per node, not per pod). But it means you can exhaust the pod range long before running out of node IPs. For example, with a `/14` pod range (262,144 addresses) and `/24` per-node allocation, you can support at most 1,024 nodes before the pod range is full — even if most nodes are running only 10 pods each. Reducing `max_pods_per_node` (e.g., to 32, which uses a `/26` = 64 addresses) makes more efficient use of the range at the cost of limiting pod density per node.
