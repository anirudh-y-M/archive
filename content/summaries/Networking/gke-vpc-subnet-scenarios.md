---
title: "Summary: GKE Networking - Subnet Allocation Q&A"
---

> **Full notes:** [[notes/Networking/gke-vpc-subnet-scenarios|GKE Networking - Subnet Allocation Q&A -->]]

## Key Concepts

### Separate Subnets per Cluster (Best Practice)

Each GKE cluster gets its own non-overlapping subnet within the same VPC. This enables native pod-to-pod routing between clusters using internal IPs without extra configuration. Each cluster has dedicated IP pools for nodes, pods, and services. VPC firewall rules can target individual subnets without cross-cluster impact. The trade-off is consuming more total IP address space from the VPC.

### Shared Subnet (Same Primary Range)

Two clusters can share a single primary subnet for node IPs, but they **must** use different secondary ranges for pods and services. This simplifies shared infrastructure management (e.g., a single NAT gateway or one set of firewall rules). The risks are significant: you must manually prevent secondary range overlaps, the primary range can exhaust (blocking node scaling for both clusters), and a networking issue in the shared subnet impacts both clusters simultaneously.

### Nested (Child) Subnets -- Forbidden

Google Cloud blocks the creation of a subnet whose CIDR is a subset of an existing subnet. The API returns an error. The reason is that Cloud Router cannot determine whether traffic for an IP should go to the "parent" or "child" subnet, creating a routing conflict. VPCs require all subnet ranges to be unique and non-overlapping.

## Quick Reference

| Scenario | Allowed? | Recommendation | Key Risk |
|----------|----------|----------------|----------|
| Separate subnets | Yes | Best practice | Needs more total IP space |
| Shared subnet | Yes | Small clusters only | IP exhaustion, shared blast radius |
| Nested subnet | No | Do not attempt | Routing conflict, API error |

```
VPC CIDR: 10.0.0.0/16
  Cluster 1 Subnet: 10.0.1.0/24  (nodes)
       Secondary:   10.1.0.0/16   (pods)
       Secondary:   10.2.0.0/20   (services)

  Cluster 2 Subnet: 10.0.2.0/24  (nodes)   <-- non-overlapping = good
       Secondary:   10.3.0.0/16   (pods)
       Secondary:   10.4.0.0/20   (services)
```

## Key Takeaways

- Always use separate, non-overlapping subnets for GKE clusters -- this is GCP's recommended pattern for isolation and easy routing.
- If sharing a subnet, ensure secondary ranges (pods/services) never overlap between clusters, and accept the blast radius risk.
- GCP will block any attempt to create overlapping CIDR subnets at the API level -- Cloud Router cannot resolve ambiguous routes.
- Each cluster needs three IP ranges: primary (nodes), secondary for pods, secondary for services.
