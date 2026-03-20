---
title: "Summary: GKE Networking - Subnet Allocation Q&A"
---

> **Full notes:** [[notes/Networking/gke-vpc-subnet-scenarios|GKE Networking - Subnet Allocation Q&A -->]]

## Key Concepts

- **Separate subnets per cluster** (best practice): Each GKE cluster gets its own non-overlapping subnet within the same VPC. Pods can natively route between clusters via internal IPs. Provides isolation, independent firewall rules, and dedicated IP pools.

- **Shared subnet**: Two clusters can share the same primary subnet (node IPs), but they **must** use different secondary ranges for Pods and Services. Simpler infra management, but risk of IP exhaustion and blast radius issues.

- **Nested (child) subnets**: Not allowed. GCP rejects overlapping CIDRs because Cloud Router cannot resolve ambiguous routing targets.

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

- Always use separate, non-overlapping subnets for GKE clusters -- this is GCP's recommended pattern.
- If sharing a subnet, ensure secondary ranges (pods/services) never overlap between clusters.
- GCP will block any attempt to create overlapping CIDR subnets at the API level.
- Each cluster needs three IP ranges: primary (nodes), secondary for pods, secondary for services.
