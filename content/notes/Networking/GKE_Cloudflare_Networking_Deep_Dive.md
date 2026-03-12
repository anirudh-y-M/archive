---
title: "GKE & Cloudflare Networking — Architecture, Packet Flow, TLS & Security"
---

Detailed analysis of packet flow, load balancing, NAT, Anycast, TLS termination, and security mechanisms for a GKE cluster fronted by Cloudflare.

## Architecture & Infrastructure Setup

When you deploy a Service and Ingress in GKE with **Container Native Load Balancing**, the following infrastructure chain is provisioned:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  User (Paris)                                                           │
│    │                                                                    │
│    │ DNS: www.yourdomain.com → Cloudflare Anycast IP                   │
│    ▼                                                                    │
│  ┌──────────────────┐   TLS #1 (Edge Cert)                             │
│  │  Cloudflare Edge │   WAF / Cache / DDoS                             │
│  │  (Paris PoP)     │                                                   │
│  └────────┬─────────┘                                                   │
│           │  Re-encrypt with Origin Cert                                │
│           │  Direct Peering / IXP                                       │
│           ▼                                                             │
│  ┌──────────────────┐   TLS #2 (Google Managed Cert)                   │
│  │  Google GFE      │   Anycast #2 → enters Google network in Paris    │
│  │  (Paris PoP)     │                                                   │
│  └────────┬─────────┘                                                   │
│           │  Google private backbone (Paris → Iowa)                     │
│           ▼                                                             │
│  ┌──────────────────┐                                                   │
│  │  Google GLB      │   URL Map → NEG lookup → Pod selection           │
│  │  (us-central1)   │                                                   │
│  └────────┬─────────┘                                                   │
│           │  Direct-to-Pod (no DNAT, no kube-proxy)                     │
│           ▼                                                             │
│  ┌──────────────────┐                                                   │
│  │  Pod (10.4.1.5)  │   Application processes request                  │
│  └──────────────────┘                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key components:**

1. **Pod** — receives an ephemeral IP (e.g., `10.4.1.5`) from the VPC's secondary range
2. **Service (NEGs)** — Container Native Load Balancing creates a **Network Endpoint Group** — a dynamic registry of direct Pod IPs, bypassing traditional NodePort/kube-proxy logic
3. **Ingress (GLB)** — the GKE Ingress Controller provisions a **Google Global HTTPS Load Balancer** with a static global Anycast IP (frontend) linked to the NEG (backend)
4. **Certificates** — two layers of TLS:
   - **Edge Certificate** — managed by Cloudflare, terminates TLS for the user
   - **Origin Certificate** — Google Managed Certificate on the GLB, terminates TLS from Cloudflare
5. **DNS** — domain pointed to Cloudflare, which proxies traffic to the Google Static IP

## The Life of a Packet (5-Leg Flow)

Tracing a request from a user in Paris to a Pod in the USA and back — two TLS terminations, two Anycast hops.

### Leg 1: User → Cloudflare (The Edge)

The user's browser resolves `www.yourdomain.com` to a Cloudflare Anycast IP. Because of **Anycast**, the user connects to the physically closest Cloudflare data center (Paris). Cloudflare performs **TLS Termination #1** using the Edge Certificate, then applies WAF rules and checks cache. On a cache MISS, it prepares to forward to the origin.

### Leg 2: Cloudflare → Google (The "Middle Mile")

Cloudflare re-encrypts the packet using the Google Origin Certificate. The packet leaves Cloudflare and enters Google's network via **Direct Peering** (PNI) or a local Internet Exchange Point (IXP) — likely still in Paris. Traffic stays local because Google also uses Anycast for the Static IP.

### Leg 3: Google Edge → GLB

The packet hits a Google Front End (GFE) at the closest Point of Presence. The GLB performs **TLS Termination #2**, then consults the URL Map and NEG availability. If pods are only in `us-central1`, the packet travels over Google's private global fiber backbone from Europe to the US.

### Leg 4: GLB → Pod (Container Native Mode)

The GLB sends the packet directly to the Pod IP (`10.4.1.5`). The packet is encapsulated (Geneve/VXLAN) to traverse the VPC. In Container Native mode, **no DNAT** occurs on the Node — the packet is delivered straight to the Pod's network namespace.

### Leg 5: Return Path

The Pod generates a response. VPC connection tracking (conntrack) routes the packet back through the exact same path: Pod → Google Backbone → GFE (Paris) → Cloudflare (Paris) → User.

## Load Balancing & NAT Inventory

Every point of load balancing and NAT in this architecture:

| Component | OSI Layer | Type | Function |
|---|---|---|---|
| **Cloudflare** | L7 | GSLB / Anycast | Routes users to nearest Cloudflare Edge data center |
| **Google Edge** | L3/L4 | Anycast / Maglev | Distributes packets from fiber backbone to GFE servers. Maglev is Google's software network LB |
| **Google GLB** | L7 | HTTP(S) Proxy | Terminates TLS. Routes to Regions/Zones based on latency and capacity |
| **VPC Network** | L3 | SDN Routing | Routes packets from GFE to the specific Node |
| **Kube-Proxy** | L4 | IPTables / IPVS | *Bypassed* in Container Native LB. Only used with traditional NodePort setup |
| **Cloud NAT** | L3 | SNAT | **Outbound only.** Maps Pod IP to a shared public Static IP when pods call external APIs |

## The Mechanics of Anycast

Anycast allows a single IP address to exist on multiple servers in different physical locations simultaneously using **BGP (Border Gateway Protocol)**.

**Anycast #1 (User → Cloudflare):**
The user resolves `www.yourdomain.com` to a Cloudflare IP announced from 300+ cities. Internet routers send the user to the closest location (Paris).

**Anycast #2 (Cloudflare → Google):**
Cloudflare targets the Google Static IP (`34.x.x.x`). Google announces this IP from 100+ Edge locations. Cloudflare's routers in Paris see that Google is reachable locally — traffic enters Google's network immediately in Paris rather than traversing the public internet to the US.

**Result:** Traffic stays "local" as long as possible, jumping onto high-speed private fiber almost immediately.

## Terraform & Static IP Reservation

The `google_compute_global_address` resource reserves a permanent Static IP that survives Load Balancer recreation:

```hcl
resource "google_compute_global_address" "ingress_ip" {
  name = "my-global-ingress-ip"
}
```

The connection to GKE is made via a Kubernetes annotation in the Ingress YAML:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  annotations:
    kubernetes.io/ingress.global-static-ip-name: "my-global-ingress-ip"
spec:
  rules:
  - host: www.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-service
            port:
              number: 80
```

## Domain, DNS & Identity

The domain is **not** registered on Google. The registration chain:

1. **Registrar** (GoDaddy/Namecheap) — point **Nameservers** to Cloudflare (`ns1.cloudflare.com`)
2. **Cloudflare DNS** — create an **A Record**: `www` → Google Static IP (e.g., `34.98.10.5`), with **Proxy Status: Proxied** (Orange Cloud)
3. **Google** — does not "own" the domain. The GLB listens for the `Host` header matching the Ingress rules. Traffic arriving without the correct Host header gets rejected (404/403)

## Security & Attack Mitigation

### BGP Hijacking Prevention

You cannot steal traffic by configuring the same Static IP on a rogue server. Google (ASN 15169) announces ownership of the IP block via BGP. **RPKI (Resource Public Key Infrastructure)** provides cryptographic proof — Google signs a Route Origin Authorization (ROA) telling the world only its AS is allowed to announce these IPs. Upstream routers reject unauthorized announcements.

### Certificate Forgery Prevention

Public CAs enforce **Domain Validation (DV)**. You can generate a CSR claiming any domain, but the CA requires proof of ownership:
- **DNS Challenge** — add a TXT record (impossible without Cloudflare access)
- **HTTP Challenge** — upload a file to the live server (impossible without server access)
- **Email Challenge** — respond to `admin@yourdomain.com` (impossible without email access)

Self-signed certificates are rejected by Cloudflare (Error 502: Bad Gateway) because the issuer isn't trusted.

## Removing Cloudflare (Direct-to-Google)

Without Cloudflare, the architecture changes from a "Double Anycast" proxy setup to **Direct Exposure**:

- Users resolve `www.yourdomain.com` directly to the Google Static IP
- Google terminates TLS immediately using the Google Managed Certificate
- You must move DNS to Google Cloud DNS and enable **Google Cloud Armor** for DDoS/WAF protection

| Feature | With Cloudflare | Without Cloudflare |
|---|---|---|
| **Visible IP** | Cloudflare Anycast IP (hidden origin) | Google Static IP (public) |
| **DDoS Protection** | Cloudflare Edge | Google Cloud Armor (must enable) |
| **Latency** | Extremely low (double private fiber) | Very low (Google private fiber) |
| **SSL Management** | Dual (Edge + Origin) | Single (Google Managed) |
| **Cost** | Cloudflare + GCP | GCP only (Armor costs extra) |

## See also

- [[notes/Networking/tls-1.3-handshake|TLS 1.3 Handshake]] — wire-level TLS 1.3 handshake, certificate chain of trust, ECDHE key exchange
- [[notes/Networking/proxies-and-tls-termination|Proxies & TLS Termination]] — forward vs reverse proxy, TLS termination mechanics
- [[notes/Networking/cloud-nat-and-vpc-networking|Cloud NAT & VPC Networking]] — Cloud NAT for outbound pod traffic
- [[notes/GCP/gke-subnet-ip-allocation|GKE Subnet & IP Allocation]] — primary vs secondary IP ranges for nodes and pods

## Interview Prep

### Q: Trace a full request from a user in Paris to a GKE Pod in the US, identifying every TLS termination and Anycast hop.

**A:** (1) User resolves `www.yourdomain.com` → Cloudflare Anycast IP. Connects to Cloudflare Paris (Anycast #1). (2) Cloudflare terminates TLS #1 (Edge Cert), applies WAF/cache. (3) Cloudflare re-encrypts with Origin Cert and sends to Google Static IP. Due to Anycast #2, traffic enters Google's network in Paris via Direct Peering. (4) GFE in Paris decrypts (TLS #2), GLB checks URL Map/NEG, routes over Google backbone to us-central1. (5) GLB sends directly to Pod IP via Container Native LB (no DNAT). (6) Return path reverses via conntrack: Pod → backbone → GFE Paris → Cloudflare Paris → user.

### Q: What is "Double Anycast" and why does it matter for latency?

**A:** Both Cloudflare and Google announce their IPs from hundreds of global locations via BGP Anycast. A user in Paris hits Cloudflare Paris (Anycast #1), then Cloudflare connects to Google Paris (Anycast #2) via direct peering. The packet enters private fiber almost immediately — it never bounces across the slow public internet. The only long-haul segment is Google's private backbone (Paris → Iowa), which is faster than any public path.

### Q: Why is Container Native Load Balancing (NEGs) better than the traditional NodePort approach?

**A:** Traditional: GLB → Node IP → kube-proxy iptables → random Pod (double-hop, possible cross-zone). Container Native: GLB → Pod IP directly via NEG (single hop, zone-aware). NEGs give the GLB visibility into individual pod health and location, enabling better load distribution and eliminating the extra hop through kube-proxy.

### Q: Can an attacker steal traffic by configuring the same Google Static IP on their own server?

**A:** No. BGP and RPKI prevent this. Google (AS15169) announces ownership of the IP block. RPKI provides cryptographic proof via a signed ROA — upstream routers verify this signature and reject unauthorized announcements. Even if the attacker configures the IP on their NIC, their ISP's router drops the packets because the route doesn't match Google's authenticated BGP path.

### Q: What changes operationally if you remove Cloudflare from this architecture?

**A:** Three things: (1) DNS must move to Google Cloud DNS with an A record pointing directly to the Google Static IP. (2) DDoS/WAF protection must be replaced with Google Cloud Armor on the GLB. (3) TLS simplifies from dual (Edge + Origin) to single (Google Managed Cert only). The origin IP becomes publicly visible, removing the privacy layer Cloudflare provides.

### Q: How does the `kubernetes.io/ingress.global-static-ip-name` annotation work?

**A:** This annotation tells the GKE Ingress Controller to use an existing reserved `google_compute_global_address` resource instead of allocating a new ephemeral IP. The string value must exactly match the Terraform resource `name`. This ensures the IP survives Load Balancer recreation and stays consistent in Cloudflare's DNS A record.

### Q: Why does Google GLB reject traffic that arrives without the correct Host header?

**A:** The GLB's URL Map routes based on the HTTP `Host` header matching the Ingress `spec.rules[].host` field. If traffic arrives at the Google Static IP with no Host header or a mismatched one, the GLB has no matching rule and returns 404 (or 403 with a default backend configured to deny). This prevents random scanners from reaching your backend just by knowing the IP.

### Q: What is the role of Direct Peering between Cloudflare and Google?

**A:** Direct Peering (PNI — Private Network Interconnect) is a physical cable connecting Cloudflare and Google routers in the same facility. It eliminates public internet hops between the two networks. When Cloudflare Paris needs to reach Google's Anycast IP, the packet crosses one link into Google's network. Without peering, the packet would traverse multiple ISP hops, adding latency and unpredictability. Most major CDN-to-cloud paths use peering.
