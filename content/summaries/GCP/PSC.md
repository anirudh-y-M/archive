---
title: "Summary: Private Service Connect (PSC)"
---

> **Full notes:** [[notes/GCP/PSC|Architecture Overview - The PSC Bridge →]]

## Key Concepts

**Private Service Connect (PSC)** lets you access a Google-managed service (e.g., Vertex AI) via a private IP on your own VPC -- traffic never touches the public internet.

Two Terraform resources make it work:
- **`google_compute_address`** -- reserves an internal IP from your subnet
- **`google_compute_forwarding_rule`** -- maps that IP to a Google-managed Service Attachment (the backend), creating a 1:1 private tunnel

The `network` field on the forwarding rule is required because internal IPs are only unique within a VPC -- it tells the VPC router where to advertise the endpoint.

**Private DNS** wraps the raw IP in a friendly hostname so your app doesn't hardcode IPs.

## Quick Reference

```
Your App
  |
  |  1. DNS lookup: image-embedding.vertex-ai.internal
  v
Cloud DNS --> returns 10.x.x.x (reserved PSC IP)
  |
  |  2. Traffic hits forwarding rule on that IP
  v
Forwarding Rule (your VPC)
  |
  |  3. Tunnels to Service Attachment
  v
Google Tenant Project (Vertex AI backend)
  |
  |  4. Response returns via same private path
  v
Your App
```

| Resource | Purpose |
|----------|---------|
| `google_compute_address` | Reserve internal IP from your subnet |
| `google_compute_forwarding_rule` | Connect IP to Google's Service Attachment |
| `google_dns_managed_zone` | Private DNS zone for hostname resolution |
| `google_dns_record_set` | A record mapping hostname to PSC IP |

## Key Takeaways

- PSC keeps all traffic on Google's private backbone -- no public internet exposure
- `load_balancing_scheme = ""` signals a direct PSC endpoint, not a load balancer
- The `network` field is mandatory even though `subnetwork` is set on the address -- different purpose (routing context vs IP allocation)
- In Shared VPC setups, the PSC endpoint is visible across service projects if firewall rules allow
- Always pair PSC with Private DNS to avoid hardcoded IPs in application code
