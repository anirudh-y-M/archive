---
title: "DNS Zones & Forwarding Rules"
---

How private DNS zones and forwarding rules work together with PSC endpoints in GCP. This is a companion to [[notes/private-service-connect|GCP Private Service Connect & VPC Networking]].

## DNS Zone

A **DNS Zone** is a container for DNS records. It defines a domain namespace (like `psc.internal`) and holds all the records for that domain.

### Types of DNS Zones

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           DNS ZONE TYPES                                │
│                                                                         │
│  ┌─────────────────────────────┐    ┌─────────────────────────────┐    │
│  │      PUBLIC ZONE            │    │      PRIVATE ZONE           │    │
│  │                             │    │                             │    │
│  │  • Visible to the internet  │    │  • Only visible to          │    │
│  │  • Anyone can resolve       │    │    specific VPCs            │    │
│  │                             │    │  • Internal use only        │    │
│  │  Example:                   │    │                             │    │
│  │  citadelapps.com            │    │  Example:                   │    │
│  │  m.com                │    │  psc.internal               │    │
│  └─────────────────────────────┘    └─────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Private DNS Zone (Terraform)

```hcl
resource "google_dns_managed_zone" "psc_internal" {
  name        = "psc-internal"
  dns_name    = "psc.internal."        # The domain namespace
  visibility  = "private"              # Only visible internally

  private_visibility_config {
    networks {
      network_url = data.google_compute_network.shared_vpc_network_default.id
    }
  }
}
```

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    DNS ZONE: psc.internal                               │
│                                                                         │
│   Owner: k-github-actions-dev                                      │
│   Visibility: Private (dev shared VPC only)                             │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │  RECORDS in this zone:                                          │   │
│   │                                                                 │   │
│   │  NAME                          TYPE    VALUE                    │   │
│   │  ─────────────────────────────────────────────────────────────  │   │
│   │  octopus.lab.psc.internal      A       10.36.200.x              │   │
│   │  octopus.prod.psc.internal     A       10.36.200.y              │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│   WHO CAN RESOLVE THESE NAMES?                                          │
│   ✓ Any VM in k-shared-vpc-host-dev network                       │
│   ✗ Public internet (can't see this zone)                              │
│   ✗ Other VPCs (unless added to visibility config)                     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## DNS Record

A **DNS Record** maps a hostname to an IP address (or other values).

```hcl
resource "google_dns_record_set" "octopus_lab_psc_internal_A" {
  managed_zone = google_dns_managed_zone.psc_internal.name

  name    = "octopus.lab.${google_dns_managed_zone.psc_internal.dns_name}"
  # Result: octopus.lab.psc.internal.

  type    = "A"           # A record = maps to IPv4 address
  ttl     = 300           # Cache for 300 seconds

  rrdatas = [google_compute_address.psc_octopus_server_lab.address]
  # The IP of our PSC endpoint
}
```

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         DNS RESOLUTION                                  │
│                                                                         │
│   ArkCI Runner asks: "What is octopus.lab.psc.internal?"               │
│                                                                         │
│         │                                                               │
│         ▼                                                               │
│   ┌─────────────────────────────────────────┐                          │
│   │  DNS Zone: psc.internal                 │                          │
│   │                                         │                          │
│   │  Looking up: octopus.lab.psc.internal   │                          │
│   │  Found: A record → 10.36.200.x          │                          │
│   └─────────────────────────────────────────┘                          │
│         │                                                               │
│         ▼                                                               │
│   Answer: 10.36.200.x                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Forwarding Rule (PSC Endpoint)

A **Forwarding Rule** in the context of PSC is NOT about DNS. It's about **network traffic routing**.

It tells Google Cloud: "When traffic arrives at this IP, forward it to this destination."

### For Load Balancers (normal use)

```
Forwarding Rule: "Send traffic on IP 10.0.0.1:80 to my backend service"
```

### For PSC (our use)

```
Forwarding Rule: "Send traffic on IP 10.36.200.x to the PSC Service Attachment"
```

```hcl
resource "google_compute_forwarding_rule" "psc_octopus_server_lab" {
  name    = "psc-octopus-server-lab"
  region  = "asia-northeast1"

  # Empty = this is a PSC endpoint, not a load balancer
  load_balancing_scheme = ""

  # The IP address that will receive traffic
  ip_address = google_compute_address.psc_octopus_server_lab.id

  # Where to send the traffic (the PSC service attachment)
  target = "projects/k-octopus-lab/regions/asia-northeast1/serviceAttachments/octopus-server-psc"

  # Which subnet this endpoint lives in
  subnetwork = google_compute_subnetwork.k_github_actions_dev_tokyo.self_link
}
```

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    FORWARDING RULE (PSC Endpoint)                       │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                                                                 │   │
│   │  NAME: psc-octopus-server-lab                                   │   │
│   │                                                                 │   │
│   │  ┌──────────────┐         ┌──────────────────────────────────┐ │   │
│   │  │  IP ADDRESS  │         │  TARGET                          │ │   │
│   │  │              │  ────►  │                                  │ │   │
│   │  │ 10.36.200.x  │  routes │  Service Attachment:             │ │   │
│   │  │              │   to    │  octopus-server-psc              │ │   │
│   │  │              │         │  (in k-octopus-lab)         │ │   │
│   │  └──────────────┘         └──────────────────────────────────┘ │   │
│   │        ▲                                                       │   │
│   │        │                                                       │   │
│   │   Traffic to                                                   │   │
│   │   this IP gets                                                 │   │
│   │   forwarded                                                    │   │
│   └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## How They Work Together

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    COMPLETE FLOW                                        │
│                                                                         │
│   STEP 1: Application wants to connect                                  │
│   ─────────────────────────────────────                                 │
│   curl https://octopus.lab.psc.internal/api                            │
│                                                                         │
│                           │                                             │
│                           ▼                                             │
│                                                                         │
│   STEP 2: DNS Resolution                                                │
│   ──────────────────────────                                            │
│   ┌─────────────────────────────────────┐                              │
│   │  DNS ZONE: psc.internal             │                              │
│   │                                     │                              │
│   │  Q: octopus.lab.psc.internal = ?    │                              │
│   │  A: 10.36.200.x                     │                              │
│   └─────────────────────────────────────┘                              │
│                                                                         │
│                           │                                             │
│                           ▼                                             │
│                                                                         │
│   STEP 3: Network Connection                                            │
│   ──────────────────────────                                            │
│   App connects to 10.36.200.x                                          │
│                                                                         │
│                           │                                             │
│                           ▼                                             │
│                                                                         │
│   STEP 4: Forwarding Rule Routes Traffic                                │
│   ─────────────────────────────────────                                 │
│   ┌─────────────────────────────────────┐                              │
│   │  FORWARDING RULE                    │                              │
│   │                                     │                              │
│   │  IP 10.36.200.x → Service           │                              │
│   │                    Attachment       │                              │
│   │                    (octopus-lab)    │                              │
│   └─────────────────────────────────────┘                              │
│                                                                         │
│                           │                                             │
│                           ▼                                             │
│                                                                         │
│   STEP 5: PSC Tunnel to Provider                                        │
│   ──────────────────────────────                                        │
│   Traffic arrives at Octopus Lab server                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Summary

| Component | What It Is | What It Does |
|-----------|------------|--------------|
| **DNS Zone** | Container for DNS records | Defines `psc.internal` namespace |
| **DNS Record** | Hostname → IP mapping | `octopus.lab.psc.internal` → `10.36.200.x` |
| **Compute Address** | Reserved internal IP | Allocates `10.36.200.x` for PSC endpoint |
| **Forwarding Rule** | Traffic routing rule | Routes `10.36.200.x` → Octopus service attachment |
| **Service Attachment** | PSC publisher | Exposes Octopus for PSC consumers |
