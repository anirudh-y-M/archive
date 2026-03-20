---
title: "Summary: DNS Zones & Forwarding Rules"
---

> **Full notes:** [[notes/Networking/dns-zones-forwarding|DNS Zones & Forwarding Rules -->]]

## Key Concepts

- **DNS Zone**: A container for DNS records that defines a domain namespace (e.g., `psc.internal`). Public zones are internet-visible; private zones are only visible to specific VPCs.

- **DNS Record**: Maps a hostname to an IP. Example: `octopus.lab.psc.internal` --> `10.36.200.x` (A record pointing to a PSC endpoint IP).

- **Forwarding Rule (PSC context)**: NOT about DNS -- it's a network traffic routing rule. Tells GCP: "When traffic arrives at this IP, forward it to this PSC Service Attachment." Used to create PSC endpoints.

- **How they work together**: App resolves hostname via private DNS zone --> gets PSC endpoint IP --> sends traffic to that IP --> forwarding rule routes it to the Service Attachment --> PSC tunnel delivers it to the provider.

## Quick Reference

```
curl octopus.lab.psc.internal
    |
    v
DNS Zone (psc.internal) --> A record --> 10.36.200.x
    |
    v
App connects to 10.36.200.x
    |
    v
Forwarding Rule: 10.36.200.x --> Service Attachment (octopus-lab)
    |
    v
PSC tunnel --> Octopus Lab server
```

| Component | What It Is | What It Does |
|---|---|---|
| DNS Zone | Record container | Defines `psc.internal` namespace |
| DNS Record | Hostname --> IP | Maps name to PSC endpoint IP |
| Compute Address | Reserved IP | Allocates IP for the PSC endpoint |
| Forwarding Rule | Traffic router | Routes IP --> Service Attachment |
| Service Attachment | PSC publisher | Exposes service for PSC consumers |

## Key Takeaways

- Private DNS zones are only visible to VPCs listed in `private_visibility_config` -- not the public internet.
- A PSC forwarding rule has `load_balancing_scheme = ""` to distinguish it from a load balancer forwarding rule.
- The DNS record and forwarding rule are connected by the same IP address (Compute Address resource).
- This pattern enables cross-project service access without VPC peering.
