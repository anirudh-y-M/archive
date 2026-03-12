---
title: Shared VPC Knowledge
---

## Q: What does `terraform/modules/gcp-shared-vpc-service` do?

**A:** The `gcp-shared-vpc-service` module is responsible for **attaching a service project to a Shared VPC host project** and setting up all the necessary permissions. It performs the following key functions:

### 1. **Attaches Service Project to Shared VPC**
   - Creates a `google_compute_shared_vpc_service_project` resource that officially registers your service project with the host project's Shared VPC network
   - This is the foundational step that establishes the relationship between host and service projects

### 2. **Grants GKE Permissions** (if `has_gke = true`)
   - Grants `roles/container.hostServiceAgentUser` to GKE's service agent
   - Grants `roles/compute.securityAdmin` so GKE can manage firewall rules for load balancers and ingress
   - Required for Kubernetes clusters to function properly in Shared VPC

### 3. **Grants CI/CD Permissions** (if `uses_secure_ci = true`)
   - Grants `roles/compute.networkViewer` to the plan service account (read-only access)
   - Grants `roles/compute.networkUser` to the apply service account (can use the network)
   - Allows automated CI/CD pipelines to create and manage network resources

### 4. **Grants AlloyDB Permissions** (if `enable_alloydb = true`)
   - Grants `roles/dns.reader` to the plan service account
   - Grants custom `AlloyDBDNSManager` role to the apply service account
   - Required for AlloyDB (Google's managed PostgreSQL) to manage DNS entries

### 5. **Creates Dependency Marker**
   - Outputs a null resource ID that ensures proper ordering
   - The subnetwork module depends on this to ensure attachment happens before subnet creation

---

## Q: What's the difference between `gcp-shared-vpc-service` and `gcp-shared-vpc-service-subnetwork`?

**A:** These modules serve different purposes and operate at different levels:

### `gcp-shared-vpc-service` (Project-Level)
- **Scope:** Project-level attachment and permissions
- **Purpose:** Establishes the relationship between service project and host project
- **What it creates:**
  - Project attachment (`google_compute_shared_vpc_service_project`)
  - Host project IAM permissions for service accounts
- **When to use:** First step - must be run before creating any subnets
- **Key outputs:** Dependency marker for subnetwork module

### `gcp-shared-vpc-service-subnetwork` (Network-Level)
- **Scope:** Network/subnet-level resources
- **Purpose:** Creates actual subnets within the Shared VPC and grants subnet-specific permissions
- **What it creates:**
  - Subnet resources (`google_compute_subnetwork`) in the host project
  - Subnet-level IAM permissions for users, groups, and service accounts
- **When to use:** Second step - after service project is attached
- **Key outputs:** Subnet ID, name, region, and self-link

### Key Differences Summary

| Aspect | `gcp-shared-vpc-service` | `gcp-shared-vpc-service-subnetwork` |
|--------|-------------------------|-------------------------------------|
| **Level** | Project-level | Network/subnet-level |
| **Primary Action** | Attach project | Create subnet |
| **IAM Scope** | Host project permissions | Subnet-specific permissions |
| **Order** | Must run first | Runs after attachment |
| **Dependency** | Independent | Depends on service module |

---

## Q: Why can't I just create a subnet from the Shared VPC and grant IAM role to a service account of some other project without the `gcp-shared-vpc-service` module?

**A:** You **cannot skip** the `gcp-shared-vpc-service` module because:

### 1. **GCP Requires Project Attachment First**
   - Google Cloud Platform **enforces** that a service project must be attached to a Shared VPC host project before it can use any Shared VPC resources
   - Without the attachment, GCP will reject any attempts to create subnets or use the network, even if you have IAM permissions
   - The error you'll see: `Project "your-service-project" is not attached to Shared VPC host project`

### 2. **Attachment Creates the Foundation**
   - The `google_compute_shared_vpc_service_project` resource is what officially registers your service project
   - This registration is what tells GCP: "This project is authorized to use the Shared VPC"
   - IAM permissions alone are not sufficient - the attachment relationship must exist first

### 3. **Subnet Creation Explicitly Depends on Attachment**
   - The subnetwork module has a `depends_on` clause that waits for the attachment to complete
   - The code enforces this dependency through a null resource pattern
   - Terraform will fail if you try to create subnets before attachment

### 4. **The Dependency Chain**
   ```
   gcp-shared-vpc-service (attachment)
        ↓
   [Dependency Marker Output]
        ↓
   gcp-shared-vpc-service-subnetwork (subnet creation)
   ```
   - The subnetwork module receives `shared_vpc_service_null_resource_id` from the service module
   - This ensures proper ordering and prevents race conditions

### 5. **What Happens If You Try to Skip It**
   - **Scenario:** You create a subnet and grant IAM without attachment
   - **Result:** GCP API will reject the subnet creation with an error
   - **Reason:** The service project isn't recognized as authorized to use the Shared VPC

### Real-World Analogy
Think of Shared VPC like a **gated community**:
- **Attachment** = Getting registered as a resident (required first step)
- **IAM permissions** = Keys to specific buildings (useless without registration)
- **Creating subnets** = Building something in the community (requires registration)

You can't build or use keys until you're registered. The attachment is the registration step that GCP requires.

---

## Q: Why is the `gcp-shared-vpc-service` module needed?

**A:** The module is needed for several critical reasons:

### 1. **Centralized Network Management**
   - Allows one team (host project) to manage the network infrastructure
   - Other teams (service projects) can use the network without managing it
   - Prevents duplicate networks and simplifies security policies

### 2. **Security and Isolation**
   - Network policies are enforced centrally
   - Service projects can't accidentally break the network
   - Easier to audit and control network access

### 3. **Cost Efficiency**
   - One network instead of many separate networks
   - Shared resources (load balancers, VPNs, etc.) reduce costs
   - Better resource utilization

### 4. **Required Permissions Setup**
   - GCP requires explicit permissions for service projects to use Shared VPC
   - The module automatically grants all necessary permissions:
     - GKE service agent permissions
     - CI/CD service account permissions
     - AlloyDB permissions (if needed)
   - Without the module, you'd have to manually configure all these permissions

### 5. **Automation and Consistency**
   - Without this module, you'd manually need to:
     - Attach the project via `gcloud` or console
     - Grant IAM permissions for GKE
     - Configure CI/CD permissions
     - Set up AlloyDB permissions
     - Ensure proper ordering
   - The module does all of this consistently and repeatably
   - Prevents human error and ensures best practices

### 6. **Dependency Management**
   - Ensures proper ordering of operations
   - Prevents race conditions
   - Makes Terraform state management predictable

---

## Q: What is the correct order of operations for using Shared VPC?

**A:** The correct order is:

1. **Attach Service Project** (`gcp-shared-vpc-service` module)
   - Creates `google_compute_shared_vpc_service_project`
   - Grants necessary IAM permissions
   - Outputs dependency marker

2. **Create Subnets** (`gcp-shared-vpc-service-subnetwork` module)
   - Waits for attachment via `depends_on`
   - Creates subnet in host project
   - Grants subnet-level IAM permissions

3. **Use the Network**
   - Deploy resources (VMs, GKE clusters, etc.)
   - Resources can now use the Shared VPC subnets

---

## Q: What happens if I try to create a subnet without attaching the service project first?

**A:** You will get an error from GCP:

```
Error: Error creating Subnetwork: googleapi: Error 403: 
Project "your-service-project-id" is not attached to Shared VPC host project "host-project-id"
```

Even if you have IAM permissions like `roles/compute.networkUser`, GCP will reject the operation because the project attachment relationship doesn't exist.

---

## Q: Can I attach a service project without using this module?

**A:** Technically yes, but not recommended:

- You could manually run: `gcloud compute shared-vpc associated-projects add SERVICE_PROJECT_ID --host-project=HOST_PROJECT_ID`
- However, you'd still need to manually:
  - Grant GKE permissions (if using Kubernetes)
  - Grant CI/CD permissions (if using secure CI)
  - Grant AlloyDB permissions (if using AlloyDB)
  - Manage dependencies for Terraform
  - Ensure consistency across environments

The module automates all of this and ensures consistency, making it the recommended approach.

---

## Q: What permissions does the module grant and why?

**A:** The module grants different permissions based on configuration:

### For GKE (`has_gke = true`):
- **`roles/container.hostServiceAgentUser`**: Allows GKE to use the Shared VPC network
- **`roles/compute.securityAdmin`**: Allows GKE to manage firewall rules for load balancers and ingress

### For CI/CD (`uses_secure_ci = true`):
- **`roles/compute.networkViewer`** (plan SA): Read-only access to view network configuration
- **`roles/compute.networkUser`** (apply SA): Can use the network to create resources

### For AlloyDB (`enable_alloydb = true`):
- **`roles/dns.reader`** (plan SA): Can read DNS records
- **`AlloyDBDNSManager`** (apply SA): Can manage AlloyDB DNS entries

These permissions are granted at the **host project level** because the service project needs to operate within the host project's network infrastructure.

---

## Additional Notes

- The modules use a null resource pattern to manage dependencies between Terraform modules
- The attachment is a one-time operation per service project
- Multiple subnets can be created after a single attachment
- The host project must have Shared VPC enabled before any service projects can attach

## See also

- [[notes/GCP/gke-subnet-ip-allocation|GKE Subnet & IP Allocation]] — primary vs secondary ranges, Alias IP allocation
- [[notes/Networking/gke-vpc-subnet-scenarios|GKE VPC Subnet Scenarios]] — subnet design patterns for GKE clusters
- [[notes/Networking/gke-snat-ip-masquerade|GKE SNAT & IP Masquerading]] — egress traffic masquerading in GKE
- [[notes/Networking/cloud-nat-and-vpc-networking|Cloud NAT & VPC Networking]] — NAT gateway setup for shared VPC environments
