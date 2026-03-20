---
title: "Summary: GKE & Cloudflare Networking -- Architecture, Packet Flow, TLS & Security"
---

> **Full notes:** [[notes/Networking/GKE_Cloudflare_Networking_Deep_Dive|GKE & Cloudflare Networking Deep Dive -->]]

## Key Concepts

- **Double Anycast architecture**: User traffic hits Cloudflare's nearest PoP (Anycast #1), then Cloudflare connects to Google's nearest PoP (Anycast #2) via direct peering. Traffic enters private fiber almost immediately.

- **Two TLS terminations**: Cloudflare terminates TLS #1 with an Edge Certificate, re-encrypts, and Google Front End (GFE) terminates TLS #2 with a Google Managed Certificate.

- **GFE = GLB**: Google Front End is the infrastructure; Global Load Balancer is the product config running on it. They are not separate hops -- GFE terminates TLS and evaluates URL Maps/NEGs in the same process.

- **Container Native LB (NEGs)**: GFE sends traffic directly to Pod IPs, bypassing kube-proxy and NodePort. No DNAT on the node.

- **5-leg packet flow**: User --> Cloudflare Edge --> Google GFE (via peering) --> Google backbone --> Pod --> return via conntrack.

## Quick Reference

```
User (Paris)
  |  DNS --> Cloudflare Anycast IP
  v
Cloudflare Paris -- TLS #1 terminated, WAF/cache
  |  Re-encrypt, Direct Peering
  v
GFE Paris -- TLS #2 terminated, URL Map + NEG routing
  |  Google private backbone (Paris --> Iowa)
  v
Pod (10.4.1.5, us-central1) -- direct-to-pod, no DNAT
```

| Component | Layer | Role |
|---|---|---|
| Cloudflare | L7 | Anycast routing, DDoS, WAF, cache |
| Maglev | L3/L4 | Distributes packets to GFE instances |
| GFE (GLB) | L7 | TLS termination, URL Map, NEG selection |
| Cloud NAT | L3 | Outbound SNAT only (pod --> internet) |

## Key Takeaways

- Traffic stays "local" via double Anycast -- both Cloudflare and Google have PoPs in the same cities, connected by direct peering.
- Container Native LB eliminates the double-hop problem of traditional NodePort + kube-proxy.
- BGP + RPKI prevent IP hijacking; DV challenges prevent certificate forgery.
- Removing Cloudflare means you lose origin IP hiding and need Google Cloud Armor for DDoS/WAF.
- The `kubernetes.io/ingress.global-static-ip-name` annotation links a reserved Terraform IP to the GKE Ingress.
