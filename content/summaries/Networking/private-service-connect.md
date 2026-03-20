---
title: "Summary: GCP Private Service Connect & VPC Networking"
---

> **Full notes:** [[notes/Networking/private-service-connect|GCP Private Service Connect & VPC Networking -->]]

## Key Concepts

**Private Service Connect (PSC)** -- A GCP networking feature that creates private tunnels between VPCs to access specific services without exposing them to the internet. Uses a Consumer-Producer model over Google's backbone.

**Consumer-Producer Model** -- The producer publishes a Service Attachment (wrapping an Internal Load Balancer). The consumer creates a PSC Endpoint (an internal IP + forwarding rule) in their VPC. Traffic to that IP tunnels privately to the producer's service.

**PSC vs VPC Peering** -- Peering connects entire networks (requires non-overlapping IPs, bidirectional). PSC connects to a single service (allows IP overlaps, unidirectional, no IP coordination needed).

**Shared VPC** -- Multiple GCP projects share one VPC network. A host project owns the VPC; service projects use it. Resources in different regions need subnets in those regions.

**PSC Regional Requirement** -- PSC endpoints must be in the same region as the service attachment they connect to. Cross-region routing within the same VPC handles traffic from other regions.

## Quick Reference

```
PRODUCER VPC                              CONSUMER VPC
+-----------------+                       +------------------+
| Pods -> ILB ->  |                       | PSC Endpoint     |
|  Service        |  PSC private tunnel   |  10.36.200.x     |
|  Attachment     |<=====================>|  (forwarding     |
|  (whitelists    |                       |   rule -> SA URI)|
|   consumers)    |                       |                  |
+-----------------+                       +------------------+
```

| Feature           | PSC                    | VPC Peering            |
|--------------------|------------------------|------------------------|
| Scope              | One service            | Entire network         |
| IP overlap         | Allowed                | Not allowed            |
| Direction          | Unidirectional         | Bidirectional          |
| Transitivity       | Yes (from peered nets) | No                     |

**Data flow:** Runner (Virginia) -> DNS resolves `psc.internal` -> PSC endpoint IP (Tokyo subnet) -> PSC tunnel -> Service Attachment -> ILB -> Pods (Tokyo)

## Key Takeaways

- PSC is preferred over VPC Peering when you need to expose a single service, have overlapping IP ranges, or want independent administration.
- Traffic never leaves Google's network -- no public IP exposure needed.
- PSC endpoints are regional: create them in the same region as the target service, even if consumers are elsewhere.
- Access control is via `consumer_accept_lists` on the Service Attachment -- fine-grained per-project whitelisting.
- DNS private zones map friendly hostnames to PSC endpoint IPs for transparent access.
