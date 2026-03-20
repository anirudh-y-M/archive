---
title: "Summary: GCP Shared VPC Knowledge"
---

> **Full notes:** [[notes/Networking/shared_vpc_knowledge|Shared VPC Knowledge -->]]

## Key Concepts

### What `gcp-shared-vpc-service` Does

The module attaches a service project to a Shared VPC host project and sets up all necessary permissions. It creates a `google_compute_shared_vpc_service_project` resource (the foundational attachment), grants GKE permissions if `has_gke=true` (`container.hostServiceAgentUser` + `compute.securityAdmin`), grants CI/CD permissions if `uses_secure_ci=true` (`compute.networkViewer` for plan, `compute.networkUser` for apply), and grants AlloyDB permissions if `enable_alloydb=true` (`dns.reader` + custom `AlloyDBDNSManager`). It outputs a dependency marker (null resource ID) that the subnetwork module depends on.

### Difference Between the Two Modules

**`gcp-shared-vpc-service` (Project-Level):** Handles project attachment and host-project IAM. Must run first. Creates `google_compute_shared_vpc_service_project` and grants permissions. Independent -- no dependencies on other modules.

**`gcp-shared-vpc-service-subnetwork` (Network-Level):** Creates actual subnets (`google_compute_subnetwork`) within the Shared VPC in the host project and grants subnet-level IAM for users, groups, and service accounts. Depends on the service module completing first (enforced via `shared_vpc_service_null_resource_id`). Outputs subnet ID, name, region, and self-link.

| Aspect | `gcp-shared-vpc-service` | `gcp-shared-vpc-service-subnetwork` |
|---|---|---|
| Level | Project | Network/subnet |
| Primary Action | Attach project + IAM | Create subnet + subnet IAM |
| Order | Must run first | Runs after attachment |
| Dependency | Independent | Depends on service module |

### Why You Cannot Skip Project Attachment

GCP enforces at the API level that a service project must be attached to a Shared VPC host before it can use any Shared VPC resources. Without the attachment, GCP rejects subnet creation with error: `Project "..." is not attached to Shared VPC host project`. IAM permissions alone are not sufficient -- the attachment relationship must exist first. The subnetwork module has an explicit `depends_on` clause enforced through a null resource pattern.

```
gcp-shared-vpc-service (attachment)
     |
[Dependency Marker Output]
     |
gcp-shared-vpc-service-subnetwork (subnet creation)
```

### Why the Module is Needed

**Centralized network management:** One team (host project) manages network infrastructure; other teams use it. **Security and isolation:** Network policies enforced centrally; service projects can't accidentally break the network. **Cost efficiency:** One shared network instead of many separate ones. **Required permissions:** GCP requires explicit permissions for service projects; the module automates granting them all. **Automation and consistency:** Without the module, you'd manually attach via `gcloud`, grant GKE/CI/CD/AlloyDB permissions, and ensure ordering -- error-prone and inconsistent.

### Correct Order of Operations

1. **Attach Service Project** -- `gcp-shared-vpc-service` creates the attachment and grants IAM
2. **Create Subnets** -- `gcp-shared-vpc-service-subnetwork` waits for attachment, then creates subnets and subnet-level IAM
3. **Use the Network** -- Deploy VMs, GKE clusters, and other resources

### Permissions Granted and Why

**GKE (`has_gke=true`):** `roles/container.hostServiceAgentUser` lets GKE use the Shared VPC network. `roles/compute.securityAdmin` lets GKE manage firewall rules for load balancers and ingress.

**CI/CD (`uses_secure_ci=true`):** `roles/compute.networkViewer` (plan SA) for read-only network access. `roles/compute.networkUser` (apply SA) for creating resources using the network.

**AlloyDB (`enable_alloydb=true`):** `roles/dns.reader` (plan SA) for reading DNS records. Custom `AlloyDBDNSManager` (apply SA) for managing AlloyDB DNS entries.

All granted at the **host project level** because the service project operates within the host's network infrastructure.

### Can You Attach Without the Module?

Technically yes (`gcloud compute shared-vpc associated-projects add ...`), but you'd still need to manually grant GKE, CI/CD, and AlloyDB permissions, manage Terraform dependencies, and ensure consistency across environments. The module automates all of this.

## Quick Reference

```
Dependency Chain:
  gcp-shared-vpc-service (project attachment + IAM)
       |
  [dependency marker output]
       |
  gcp-shared-vpc-service-subnetwork (subnet creation + subnet IAM)
       |
  Deploy resources (VMs, GKE clusters, etc.)
```

| Permission | Role | When | Granted To |
|---|---|---|---|
| GKE network use | `container.hostServiceAgentUser` | `has_gke=true` | GKE service agent |
| GKE firewall | `compute.securityAdmin` | `has_gke=true` | GKE service agent |
| CI plan | `compute.networkViewer` | `uses_secure_ci=true` | Plan SA |
| CI apply | `compute.networkUser` | `uses_secure_ci=true` | Apply SA |
| AlloyDB read | `dns.reader` | `enable_alloydb=true` | Plan SA |
| AlloyDB manage | `AlloyDBDNSManager` | `enable_alloydb=true` | Apply SA |

**Analogy:** Shared VPC is a gated community. Attachment = resident registration (required first). IAM = keys to specific buildings. Subnets = building something inside.

## Key Takeaways

- You cannot skip project attachment -- GCP enforces it at the API level before any network resource creation. You'll get a 403 error.
- The two modules serve different scopes: project-level attachment vs. network-level subnet creation. Both are needed, in order.
- All permissions are granted at the host project level because the service project operates within the host's network infrastructure.
- One attachment supports multiple subnets. The attachment is a one-time operation per service project.
- The host project must have Shared VPC enabled before any service projects can attach.
- The null resource dependency pattern ensures Terraform creates the attachment before attempting subnet creation.
- Manual attachment is possible but not recommended -- the module automates permissions, ordering, and consistency.
