---
title: "Summary: GCP Private Service Connect & VPC Networking"
---

> **Full notes:** [[notes/Networking/private-service-connect|GCP Private Service Connect & VPC Networking -->]]

## Key Concepts

### The Goal

Allow services in one VPC (e.g., ArkCI dev runners) to connect to services in another VPC (e.g., Octopus servers) privately via internal networking with no public internet exposure.

### Core Networking: VPC, Shared VPC, Subnets

A **VPC** is an isolated private network in GCP. Resources in different VPCs cannot communicate by default. A **Shared VPC** lets multiple GCP projects share one VPC -- a host project owns the VPC, and service projects use it. **Subnets** are regional IP ranges within a VPC; resources must be created in a subnet that exists in their target region.

The note's example uses two subnets: runners in Virginia (closer to GitHub) and PSC endpoints in Tokyo (where Octopus servers live). PSC endpoints must be in the same region as the service they connect to.

### Private Service Connect (PSC)

PSC creates a private tunnel between VPCs on the Google Cloud backbone using a Consumer-Producer model. The producer publishes a Service Attachment wrapping an Internal Load Balancer. The consumer creates a PSC Endpoint (an internal IP + forwarding rule) in their own VPC. Traffic to that IP is tunneled privately to the producer's service.

### PSC vs VPC Peering

PSC solves three major VPC Peering limitations: (1) IP overlaps -- PSC works even if both VPCs use the same CIDR ranges; (2) security radius -- PSC connects to a specific service, not the entire network; (3) operational complexity -- no IP coordination needed between teams.

| Feature | PSC | VPC Peering |
|---|---|---|
| Scope | One specific service | Entire networks |
| IP Overlap | Allowed | Not allowed |
| Traffic Flow | Unidirectional (consumer -> producer) | Bidirectional |
| Transitivity | Accessible from peered/on-prem networks | Not transitive |
| Administration | Independent | Requires mutual IP coordination |

### PSC Use Cases

Accessing Google APIs (BigQuery, Cloud Storage, Vertex AI) via private IPs. SaaS consumption (MongoDB Atlas, Snowflake, Confluent) within Google's network. Cross-organization service sharing without merging networks or refactoring IPs.

### PSC Components

```
PRODUCER VPC                              CONSUMER VPC
+-----------------+                       +------------------+
| Pods -> ILB ->  |                       | PSC Endpoint     |
|  Service        |  PSC private tunnel   |  (Compute Address|
|  Attachment     |<======================|   + Forwarding   |
|  (whitelists    |                       |   Rule -> SA URI)|
|   consumers)    |                       |  10.36.200.x     |
+-----------------+                       +------------------+
```

The Service Attachment wraps an ILB and has `consumer_accept_lists` to whitelist allowed consumer projects. The PSC Endpoint consists of a Compute Address (internal IP) and a Forwarding Rule targeting the Service Attachment URI. The `network` field on the forwarding rule is required even when the address specifies a subnetwork, because internal IPs are only unique within a VPC.

### How PSC Works (Step by Step)

1. Provider creates a Service Attachment wrapping an ILB
2. Provider whitelists consumer projects via `consumer_accept_lists`
3. Consumer creates a PSC Endpoint (address + forwarding rule)
4. The endpoint gets a private IP in the consumer's VPC
5. Traffic to that IP is tunneled to the provider's service

### DNS Configuration

A private DNS zone (e.g., `psc.internal`) maps friendly hostnames to PSC endpoint IPs. The zone is only visible to the shared VPC. Records like `octopus.lab.psc.internal -> 10.36.200.x` let services connect using hostnames instead of IPs.

### Complete Data Flow

```
Runner (Virginia) → DNS lookup → psc.internal zone → PSC endpoint IP (Tokyo)
  → VPC cross-region routing → Forwarding rule → PSC tunnel
  → Service Attachment (checks consumer_accept_lists)
  → ILB → Octopus Pods (Tokyo)
```

### Why Not Public URLs?

Public URLs are simpler but expose services to the internet and require firewall rules. PSC keeps traffic entirely within Google's network, requires no public IP exposure, and provides fine-grained access control via `consumer_accept_lists`.

## Quick Reference

| PSC Component | Role |
|---|---|
| Service Attachment | Producer publishes service (wraps ILB, whitelists consumers) |
| Compute Address | Internal IP in consumer VPC for the PSC endpoint |
| Forwarding Rule | Routes traffic from that IP to the Service Attachment URI |
| Private DNS Zone | Maps hostname to PSC endpoint IP |

**Data flow:** Runner (Virginia) -> DNS `psc.internal` -> PSC endpoint IP (Tokyo subnet) -> PSC tunnel -> Service Attachment -> ILB -> Pods (Tokyo)

## Key Takeaways

- PSC is preferred over VPC Peering when you need to expose a single service, have overlapping IP ranges, or want independent administration between teams.
- Traffic never leaves Google's network -- no public IP exposure needed.
- PSC endpoints are regional: create them in the same region as the target service attachment, even if consumers are in a different region.
- Access control is via `consumer_accept_lists` on the Service Attachment -- fine-grained per-project whitelisting.
- DNS private zones map friendly hostnames to PSC endpoint IPs for transparent access.
- The `network` field on forwarding rules ensures the endpoint is visible to the entire shared VPC, not just the service project's scope.
- PSC allows IP overlap between consumer and producer VPCs because routing tables never merge.
