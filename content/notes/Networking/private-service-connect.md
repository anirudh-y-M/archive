---
title: "GCP Private Service Connect & VPC Networking"
---

How to connect services across VPCs privately using PSC, with Shared VPC and subnet design.

## The Goal

Allow **ArkCI dev runners** (GitHub Actions self-hosted runners) to connect to **Octopus servers** (lab and prod) privately via internal networking — no public internet exposure.

---

## Core Networking Concepts

### VPC (Virtual Private Cloud)

A VPC is an **isolated private network** in Google Cloud. Resources in different VPCs cannot communicate by default.

```
┌─────────────────────┐          ┌─────────────────────┐
│      VPC-A          │    ✗     │       VPC-B         │
│   10.0.0.0/16       │◄────────►│    10.1.0.0/16      │
│                     │  Can't   │                     │
│   Server A          │  talk    │    Server B         │
└─────────────────────┘          └─────────────────────┘
```

### Shared VPC

A **Shared VPC** allows multiple GCP projects to share a single VPC network. There's one **host project** that owns the VPC, and multiple **service projects** that use it.

```
┌─────────────────────────────────────────────────────────────────────────┐
│              SHARED VPC HOST: k-shared-vpc-host-dev                │
│                                                                         │
│   Network: shared-vpc-network-default                                   │
│                                                                         │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │
│   │ Subnet:         │  │ Subnet:         │  │ Subnet:         │       │
│   │ citadel-dev-    │  │ github-actions- │  │ github-actions- │       │
│   │ tokyo           │  │ dev-virginia    │  │ dev-tokyo [NEW] │       │
│   │ 10.32.x.x/xx   │  │ 10.39.x.x/xx   │  │ 10.36.200.0/24  │       │
│   └─────────────────┘  └─────────────────┘  └─────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
          │                      │                      │
          ▼                      ▼                      ▼
   ┌─────────────┐      ┌─────────────────┐    ┌─────────────────┐
   │ SERVICE     │      │ SERVICE         │    │ SERVICE         │
   │ PROJECT:    │      │ PROJECT:        │    │ PROJECT:        │
   │ m-jp- │      │ k-github-  │    │ k-github-  │
   │ citadel-dev │      │ actions-dev     │    │ actions-dev     │
   │             │      │ (runners)       │    │ (PSC endpoints) │
   └─────────────┘      └─────────────────┘    └─────────────────┘
```

### Subnets

A **subnet** is a range of IP addresses within a VPC, tied to a specific **region**. Resources must be created in a subnet that exists in their target region.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SHARED VPC NETWORK                               │
│                                                                         │
│    VIRGINIA (us-east4)              TOKYO (asia-northeast1)             │
│   ┌─────────────────────┐          ┌─────────────────────┐             │
│   │ k-github-      │          │ k-github-      │             │
│   │ actions-dev-virginia│          │ actions-dev-tokyo   │             │
│   │                     │          │                     │             │
│   │ • ArkCI runners     │          │ • PSC endpoints     │             │
│   │   run here          │          │   (to reach Tokyo   │             │
│   │                     │          │    Octopus servers) │             │
│   └─────────────────────┘          └─────────────────────┘             │
└─────────────────────────────────────────────────────────────────────────┘
```

**Why two subnets?**
- ArkCI runners are in **Virginia** (closer to GitHub, better performance)
- Octopus servers are in **Tokyo** (where most infrastructure lives)
- PSC endpoints must be in the **same region** as the service they connect to

---

## Private Service Connect (PSC)

PSC creates a **private tunnel** between VPCs without exposing services to the internet.

### Components of PSC

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           SERVICE PROVIDER                              │
│                         (k-octopus-lab)                            │
│                                                                         │
│   ┌─────────────┐      ┌─────────────────┐      ┌──────────────────┐  │
│   │  Octopus    │      │  Internal Load  │      │  SERVICE         │  │
│   │  Pods       │─────►│  Balancer (ILB) │─────►│  ATTACHMENT      │  │
│   │             │      │                 │      │                  │  │
│   └─────────────┘      └─────────────────┘      │  "I'm publishing │  │
│                                                  │   this service"  │  │
│                                                  │                  │  │
│                                                  │  Allowed:        │  │
│                                                  │  • citadel-dev   │  │
│                                                  │  • citadel-lab   │  │
│                                                  │  • github-actions│  │
│                                                  │    -dev [NEW]    │  │
│                                                  └────────┬─────────┘  │
└───────────────────────────────────────────────────────────┼─────────────┘
                                                            │
                                              PSC Connection│(private)
                                                            │
┌───────────────────────────────────────────────────────────┼─────────────┐
│                           SERVICE CONSUMER                │             │
│                     (k-github-actions-dev)           │             │
│                                                           ▼             │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │                      PSC ENDPOINT                                │  │
│   │                                                                  │  │
│   │  ┌─────────────────────┐      ┌─────────────────────┐           │  │
│   │  │  COMPUTE ADDRESS    │      │  FORWARDING RULE    │           │  │
│   │  │                     │      │                     │           │  │
│   │  │  Internal IP:       │◄────►│  Target: Service    │           │  │
│   │  │  10.36.200.x        │      │  Attachment URI     │           │  │
│   │  │                     │      │                     │           │  │
│   │  │  "Traffic to this   │      │  "Route traffic to  │           │  │
│   │  │   IP goes to PSC"   │      │   the provider"     │           │  │
│   │  └─────────────────────┘      └─────────────────────┘           │  │
│   └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### How PSC Works

1. **Provider** creates a **Service Attachment** that wraps an Internal Load Balancer
2. **Provider** whitelists allowed consumer projects (`consumer_accept_lists`)
3. **Consumer** creates a **PSC Endpoint** (address + forwarding rule)
4. The endpoint gets a **private IP** in the consumer's VPC
5. Traffic to that IP is **tunneled** to the provider's service

---

## DNS Configuration

For services to connect using a **hostname** instead of IP, we need DNS. See [[notes/dns-zones-forwarding|DNS Zones & Forwarding Rules]] for full details.

### Private DNS Zone

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    PRIVATE DNS ZONE: psc.internal                       │
│                    (k-github-actions-dev)                          │
│                                                                         │
│   Visibility: Private (only visible to the dev shared VPC)              │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │  DNS RECORDS                                                    │   │
│   │                                                                 │   │
│   │  octopus.lab.psc.internal  ──►  10.36.200.x (PSC endpoint IP)  │   │
│   │  octopus.prod.psc.internal ──►  10.36.200.y (PSC endpoint IP)  │   │
│   └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ArkCI Dev Runner (Virginia)                                            │
│                                                                         │
│  curl https://octopus.lab.psc.internal/api                             │
│       │                                                                 │
│       │ Step 1: DNS Lookup                                              │
│       ▼                                                                 │
│  ┌─────────────────────────────────────────────┐                       │
│  │  Private DNS Zone (psc.internal)            │                       │
│  │  octopus.lab.psc.internal → 10.36.200.x     │                       │
│  └─────────────────────────────────────────────┘                       │
│       │                                                                 │
│       │ Step 2: Connect to IP                                           │
│       ▼                                                                 │
│  ┌─────────────────────────────────────────────┐                       │
│  │  PSC Endpoint (Tokyo subnet)                │                       │
│  │  10.36.200.x                                │                       │
│  │                                             │                       │
│  │  Forwarding Rule targets:                   │                       │
│  │  octopus-lab service attachment             │                       │
│  └─────────────────────────────────────────────┘                       │
│       │                                                                 │
│       │ Step 3: PSC Tunnel (private, cross-VPC)                         │
│       ▼                                                                 │
└───────┼─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Octopus Lab Server (Tokyo)                                             │
│                                                                         │
│  ┌─────────────────────────────────────────────┐                       │
│  │  Service Attachment                         │                       │
│  │  octopus-server-psc                         │                       │
│  │                                             │                       │
│  │  Accepts: k-github-actions-dev ✓       │                       │
│  └─────────────────────────────────────────────┘                       │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────────────────────────────┐                       │
│  │  Internal Load Balancer → Octopus Pods      │                       │
│  └─────────────────────────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Why Not Just Use Public URLs?

| Approach | Pros | Cons |
|----------|------|------|
| **Public URL** (`octopus.lab.citadelapps.com`) | Simple, no setup | Exposed to internet, requires firewall rules |
| **PSC** (`octopus.lab.psc.internal`) | Private, secure, no internet exposure | More complex setup |

PSC is preferred for **internal services** because:
- Traffic never leaves Google's network
- No public IP exposure
- Fine-grained access control via `consumer_accept_lists`
