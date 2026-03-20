---
title: "Summary: GCP Shared VPC Knowledge"
---

> **Full notes:** [[notes/Networking/shared_vpc_knowledge|Shared VPC Knowledge -->]]

## Key Concepts

**Shared VPC** -- A GCP networking model where one host project owns the VPC network and multiple service projects share it. Centralizes network management, security policies, and cost.

**`gcp-shared-vpc-service` Module (Project-Level)** -- Attaches a service project to the Shared VPC host project. Grants required IAM permissions for GKE, CI/CD, and AlloyDB. Must run first -- GCP rejects all network operations until the project attachment exists.

**`gcp-shared-vpc-service-subnetwork` Module (Network-Level)** -- Creates subnets within the Shared VPC and grants subnet-level IAM. Depends on the service module completing first (enforced via Terraform dependency marker).

**Mandatory Order** -- (1) Attach service project, (2) Create subnets, (3) Deploy resources. Skipping step 1 results in a GCP 403 error: "Project is not attached to Shared VPC host project."

**Permissions Granted:**
- GKE: `container.hostServiceAgentUser` + `compute.securityAdmin`
- CI/CD: `compute.networkViewer` (plan) + `compute.networkUser` (apply)
- AlloyDB: `dns.reader` + custom `AlloyDBDNSManager`

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

| Module                            | Level   | Primary Action    | Order |
|-----------------------------------|---------|-------------------|-------|
| `gcp-shared-vpc-service`          | Project | Attach + IAM      | First |
| `gcp-shared-vpc-service-subnetwork`| Network | Create subnet     | Second|

**Analogy:** Shared VPC is a gated community. Attachment = resident registration (required first). IAM = keys to specific buildings. Subnets = building something inside.

## Key Takeaways

- You cannot skip project attachment -- GCP enforces it at the API level before any network resource creation.
- The two modules serve different scopes: project-level attachment vs. network-level subnet creation. Both are needed.
- All permissions are granted at the host project level because the service project operates within the host's network infrastructure.
- One attachment supports multiple subnets. The attachment is a one-time operation per service project.
- The host project must have Shared VPC enabled before any service projects can attach.
