---
title: "Summary: Private Service Connect (PSC)"
---

> **Full notes:** [[notes/GCP/PSC|Architecture Overview - The PSC Bridge →]]

## Key Concepts

### What is PSC?

Private Service Connect lets you access a Google-managed service (e.g., Vertex AI Vector Search) as if it were sitting on your own local network. Traffic never touches the public internet -- it flows entirely over Google's private backbone.

### The Reserved Address (`google_compute_address`)

This resource reserves an **internal IP** from a specific subnet's CIDR range. The `subnetwork` field determines which subnet to carve the IP from -- critical in Shared VPC setups where the subnet lives in a Host Project while your resources live in a Service Project. The `address_type = "INTERNAL"` flag ensures the IP is non-routable over the public internet and exists only within the VPC.

### The Forwarding Rule (`google_compute_forwarding_rule`)

This is the connection logic that ties everything together. The `target` field points to a **Service Attachment** URI in a Google-managed Tenant Project (e.g., `projects/cb2...-tp/...`), tunneling traffic from your local IP into the Google-owned backend. `load_balancing_scheme = ""` (empty string) signals this is a **direct PSC endpoint** (1:1 NAT mapping), not a load balancer. The `ip_address` field anchors the rule to the reserved internal IP -- any traffic hitting that IP triggers the forwarding rule.

### Why the `network` Field is Mandatory

Even though the address resource already has a `subnetwork`, the forwarding rule needs the `network` for two reasons. First, **routing context**: internal IPs (e.g., `10.x.x.x`) are only unique within a VPC, so the forwarding rule must know which VPC routing table it belongs to. Second, **Shared VPC visibility**: explicitly specifying the network ensures the endpoint is advertised to the entire VPC, allowing resources in other service projects to reach it (if firewall rules permit).

### Private DNS

To avoid hardcoding IPs like `10.50.0.5` in application code, you wrap the PSC endpoint in a Private DNS Zone. A `google_dns_managed_zone` (visibility: private, linked to your Shared VPC network) and a `google_dns_record_set` (A record mapping a friendly hostname to the PSC IP) let your app call something like `image-embedding.vertex-ai.internal` instead of a raw IP.

### End-to-End Flow

```
Your App --> DNS lookup (image-embedding.vertex-ai.internal)
  |
  v
Cloud DNS returns 10.x.x.x (reserved PSC IP)
  |
  v
Forwarding Rule "listens" on that IP within the VPC
  |
  v
Encapsulates packet --> sends to Service Attachment (Google Tenant Project)
  |
  v
Vertex AI processes request --> response returns via same private tunnel
  |
  v
Your App receives response
```

| Step | Action | Logic |
|------|--------|-------|
| Request | App calls `image-embedding.vertex-ai.internal` | Readable hostname |
| DNS | Cloud DNS returns `10.x.x.x` | Resolves to reserved PSC IP |
| VPC Routing | Traffic hits Forwarding Rule | Rule listening on that IP within the `network` |
| Tunneling | Encapsulation | Rule wraps packet, sends to target Service Attachment |
| Processing | Vertex AI responds | Response returns through private tunnel |

### Security, Performance, and Compliance

**Security:** Traffic is immune to internet-based DDoS or snooping since it never enters the public internet. **Performance:** Traffic moves across Google's dedicated fiber backbone with the lowest possible latency. **Compliance:** Satisfies "Private Link" requirements for industries (Fintech, Healthcare) that mandate data never leave a private network.

## Quick Reference

| Resource | Purpose |
|----------|---------|
| `google_compute_address` | Reserve internal IP from your subnet (INTERNAL, tied to subnetwork) |
| `google_compute_forwarding_rule` | Connect that IP to Google's Service Attachment (target), empty `load_balancing_scheme` |
| `google_dns_managed_zone` | Private DNS zone linked to Shared VPC for hostname resolution |
| `google_dns_record_set` | A record mapping friendly hostname to the PSC IP |

## Key Takeaways

- PSC keeps all traffic on Google's private backbone -- no public internet exposure
- `load_balancing_scheme = ""` signals a direct PSC endpoint, not a load balancer
- The `network` field is mandatory even though `subnetwork` is set on the address -- they serve different purposes (routing context vs IP allocation)
- In Shared VPC setups, the PSC endpoint is visible across service projects if firewall rules allow
- Always pair PSC with Private DNS to avoid hardcoded IPs in application code
- The Service Attachment URI points to a Google-managed Tenant Project, not your own -- you're tunneling into Google's infrastructure
