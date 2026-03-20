---
title: "Summary: GKE & Cloudflare Networking -- Architecture, Packet Flow, TLS & Security"
---

> **Full notes:** [[notes/Networking/GKE_Cloudflare_Networking_Deep_Dive|GKE & Cloudflare Networking Deep Dive -->]]

## Key Concepts

### Architecture & Infrastructure Setup

A GKE cluster fronted by Cloudflare uses Container Native Load Balancing (NEGs), which provisions a direct path from Google's edge to Pod IPs. The infrastructure chain is: Cloudflare Edge --> GFE (Google Front End) at a nearby PoP --> Google private backbone --> Pod. GFE and GLB are not separate hops -- GFE is Google's distributed reverse-proxy fleet, GLB is the customer-facing product config running on it. TLS termination and URL Map evaluation happen in the same GFE process.

Key components: Pods get IPs from VPC secondary ranges, NEGs register direct Pod IPs (bypassing NodePort/kube-proxy), the GKE Ingress Controller provisions a Global External Application Load Balancer with a static Anycast IP, and two certificate layers (Cloudflare Edge + Google Managed Origin) provide end-to-end encryption.

### The Life of a Packet (5-Leg Flow)

**Leg 1 (User --> Cloudflare):** Browser resolves domain to Cloudflare Anycast IP, connects to nearest PoP (e.g., Paris). Cloudflare performs TLS Termination #1 (Edge Cert), applies WAF, checks cache.

**Leg 2 (Cloudflare --> Google):** Cloudflare re-encrypts with Origin Cert. Packet enters Google's network via Direct Peering (PNI) or IXP -- stays local in Paris because Google also uses Anycast for the Static IP.

**Leg 3 (GFE -- TLS & Routing):** Maglev (L3/L4 software LB) distributes to a GFE instance. GFE performs TLS Termination #2, evaluates URL Map, selects a Pod via NEG with health-check awareness. Forwards over private backbone to the target region.

**Leg 4 (GFE --> Pod):** Direct-to-Pod delivery via Container Native mode. No DNAT on the Node. Packet encapsulated (Geneve/VXLAN) across VPC.

**Leg 5 (Return):** Conntrack routes the response back through the exact reverse path.

### Load Balancing & NAT Inventory

```
| Component    | Layer | Type                      | Function                                   |
|--------------|-------|---------------------------|--------------------------------------------|
| Cloudflare   | L7    | GSLB / Anycast            | Routes to nearest edge PoP                 |
| Maglev       | L3/L4 | Consistent-hash LB        | Distributes to GFE instances               |
| GFE (GLB)    | L7    | HTTP(S) Reverse Proxy     | TLS termination, URL Map, NEG selection    |
| VPC Network  | L3    | SDN Routing               | Routes GFE --> Node                        |
| kube-proxy   | L4    | iptables/IPVS             | BYPASSED in Container Native LB            |
| Cloud NAT    | L3    | SNAT                      | Outbound only (Pod --> internet)           |
```

### The Mechanics of Anycast

Both Cloudflare and Google announce their IPs from hundreds of global locations via BGP. A user in Paris hits Cloudflare Paris (Anycast #1), then Cloudflare connects to Google Paris (Anycast #2) via direct peering. Traffic enters private fiber almost immediately -- the only long-haul segment is Google's private backbone between PoPs.

### Terraform & Static IP Reservation

`google_compute_global_address` reserves a permanent Static IP surviving LB recreation. The `kubernetes.io/ingress.global-static-ip-name` annotation on the Ingress YAML links it to the GKE Ingress Controller. The annotation value must exactly match the Terraform resource name.

### Domain, DNS & Identity

DNS chain: Registrar points nameservers to Cloudflare --> Cloudflare creates A record to Google Static IP (Proxy: On) --> Google GLB routes based on Host header matching Ingress rules. Google does not "own" the domain; traffic without the correct Host header is rejected (404/403).

### Security & Attack Mitigation

**BGP Hijacking Prevention:** RPKI (Resource Public Key Infrastructure) provides cryptographic proof via signed ROAs (Route Origin Authorizations). Google (AS15169) signs ROAs telling upstream routers only its AS may announce these IP blocks. Unauthorized BGP announcements are rejected.

**Certificate Forgery Prevention:** CAs enforce Domain Validation (DV) before issuing certificates -- DNS challenge (TXT record), HTTP challenge (file upload), or email challenge. Self-signed certs are rejected by Cloudflare (502 Bad Gateway).

### Removing Cloudflare (Direct-to-Google)

Without Cloudflare: users resolve directly to Google Static IP, single TLS termination (Google Managed), origin IP becomes public, DDoS/WAF must be replaced by Google Cloud Armor (extra cost). Latency remains very low via Google private fiber but you lose origin IP hiding and Cloudflare's edge caching.

## Quick Reference

```
User (Paris)
  |  DNS --> Cloudflare Anycast IP
  v
Cloudflare Paris -- TLS #1 terminated, WAF/cache
  |  Re-encrypt, Direct Peering / IXP
  v
GFE Paris -- Maglev distributes, TLS #2 terminated, URL Map + NEG routing
  |  Google private backbone (Paris --> Iowa)
  v
Pod (10.4.1.5, us-central1) -- direct-to-pod, no DNAT, no kube-proxy
  |
  v  Return: conntrack reverses entire path
```

| Feature | With Cloudflare | Without Cloudflare |
|---|---|---|
| Visible IP | Cloudflare Anycast (hidden origin) | Google Static IP (public) |
| DDoS/WAF | Cloudflare Edge | Google Cloud Armor (must enable) |
| SSL | Dual (Edge + Origin) | Single (Google Managed) |
| Latency | Extremely low (double private fiber) | Very low (Google private fiber) |

## Key Takeaways

- Traffic stays "local" via double Anycast -- both Cloudflare and Google have PoPs in the same cities, connected by direct peering or IXP.
- GFE = GLB at the infrastructure level. There is no separate "GLB box" -- GFE terminates TLS and evaluates URL Maps/NEGs in the same process.
- Container Native LB (NEGs) eliminates the double-hop problem of traditional NodePort + kube-proxy by routing directly to Pod IPs.
- BGP + RPKI prevent IP hijacking; DV challenges prevent certificate forgery. Self-signed certs fail at Cloudflare.
- Removing Cloudflare means losing origin IP hiding and requiring Cloud Armor for DDoS protection.
- The `kubernetes.io/ingress.global-static-ip-name` annotation links a reserved Terraform IP to the GKE Ingress, surviving LB recreation.
- The GLB rejects traffic without the correct Host header, preventing random scanners from reaching backends by IP alone.
