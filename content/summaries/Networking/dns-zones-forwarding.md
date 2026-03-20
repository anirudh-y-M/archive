---
title: "Summary: DNS Zones & Forwarding Rules"
---

> **Full notes:** [[notes/Networking/dns-zones-forwarding|DNS Zones & Forwarding Rules -->]]

## Key Concepts

### DNS Zone

A DNS Zone is a container for DNS records that defines a domain namespace (e.g., `psc.internal`). **Public zones** are visible to the entire internet and anyone can resolve them. **Private zones** are only visible to specific VPCs listed in the `private_visibility_config` -- the public internet cannot see them, and other VPCs cannot resolve them unless explicitly added.

In Terraform, a private zone is created with `google_dns_managed_zone` setting `visibility = "private"` and specifying which VPC networks can see it via `private_visibility_config.networks`.

### DNS Record

A DNS Record maps a hostname to an IP address (or other values). For PSC endpoints, this is typically an A record mapping a friendly name (e.g., `octopus.lab.psc.internal`) to the PSC endpoint's reserved internal IP (e.g., `10.36.200.x`). Created via `google_dns_record_set` in Terraform, referencing the managed zone and the compute address resource. TTL controls caching duration.

### Forwarding Rule (PSC Endpoint)

A Forwarding Rule in the PSC context is **NOT about DNS** -- it is a **network traffic routing rule**. It tells GCP: "When traffic arrives at this IP, forward it to this destination." For PSC, the destination is a **Service Attachment** in another project. The forwarding rule has `load_balancing_scheme = ""` (empty) to distinguish it from a load balancer forwarding rule.

The forwarding rule is created with `google_compute_forwarding_rule`, specifying the reserved IP (`ip_address`), the target Service Attachment, and the subnet the endpoint lives in.

### How They Work Together (Complete Flow)

The three components form a chain connected by the same IP address (Compute Address resource):

1. **Application** calls `curl https://octopus.lab.psc.internal/api`
2. **DNS Resolution**: The query hits the private DNS zone `psc.internal`, finds the A record for `octopus.lab.psc.internal`, returns IP `10.36.200.x`
3. **Network Connection**: App connects to `10.36.200.x`
4. **Forwarding Rule**: GCP sees traffic arriving at `10.36.200.x`, the forwarding rule routes it to the target Service Attachment (`octopus-server-psc` in the provider project)
5. **PSC Tunnel**: Traffic is delivered to the provider's service through the Private Service Connect tunnel

The DNS record and forwarding rule are linked by the same Compute Address resource -- the DNS record resolves to the IP, and the forwarding rule routes traffic arriving at that IP.

### Summary Table

| Component | What It Is | What It Does |
|---|---|---|
| **DNS Zone** | Container for DNS records | Defines `psc.internal` namespace, controls visibility |
| **DNS Record** | Hostname --> IP mapping | `octopus.lab.psc.internal` --> `10.36.200.x` |
| **Compute Address** | Reserved internal IP | Allocates `10.36.200.x` for PSC endpoint |
| **Forwarding Rule** | Traffic routing rule | Routes `10.36.200.x` --> Octopus Service Attachment |
| **Service Attachment** | PSC publisher | Exposes Octopus service for PSC consumers |

## Quick Reference

```
curl octopus.lab.psc.internal
    |
    v
DNS Zone (psc.internal, private)
    | A record lookup
    v
10.36.200.x (Compute Address)
    |
    v
Forwarding Rule (load_balancing_scheme = "")
    | target = Service Attachment
    v
PSC tunnel --> Octopus Lab server (provider project)
```

```
Terraform resource chain:

google_dns_managed_zone (psc.internal, private)
    |
google_dns_record_set (octopus.lab.psc.internal --> IP)
    |                                                 \
    |                                          uses same IP
    |                                                 /
google_compute_address (10.36.200.x)
    |
google_compute_forwarding_rule (IP --> Service Attachment)
```

## Key Takeaways

- Private DNS zones are only visible to VPCs listed in `private_visibility_config` -- not the public internet, not other VPCs.
- A PSC forwarding rule uses `load_balancing_scheme = ""` to distinguish it from a regular load balancer forwarding rule.
- The DNS record and forwarding rule are connected by the same Compute Address resource (the reserved IP).
- This pattern enables cross-project service access via Private Service Connect without VPC peering.
- The forwarding rule is about network traffic routing, NOT DNS forwarding -- these are different concepts despite similar names.
