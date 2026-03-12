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

PSC creates a **private tunnel** between VPCs without exposing services to the internet. It operates on a **Consumer-Producer** model over the Google Cloud backbone — the producer publishes a service via a Service Attachment, and the consumer creates a PSC Endpoint (an internal IP) in their own VPC that tunnels traffic privately to the producer.

### What PSC Solves (vs VPC Peering)

Before PSC, connecting VPCs required **VPC Peering**, which has three major limitations PSC resolves:

- **IP Address Overlaps** — PSC works even if consumer and producer use the same IP ranges (e.g., both use `10.0.0.0/24`). Peering fails in this scenario.
- **Security Radius** — PSC connects to a *specific service*, whereas peering opens connectivity to the *entire* network.
- **Operational Complexity** — no need to coordinate IP ranges and firewall rules between teams.

| Feature | PSC | VPC Peering |
|---|---|---|
| **Connectivity Scope** | One specific service | Entire networks |
| **IP Overlap** | Allowed | Not allowed |
| **Traffic Flow** | Unidirectional (Consumer → Producer) | Bidirectional |
| **Transitivity** | Accessible from on-prem/peered networks | Not transitive |
| **Administration** | Independent, no coordination needed | Requires mutual agreement on IP ranges |

### Primary Use Cases

- **Google APIs** — access BigQuery, Cloud Storage, Vertex AI via private internal IPs
- **SaaS consumption** — connect to MongoDB Atlas, Snowflake, Confluent within Google's network
- **Cross-organization access** — share services across teams/acquisitions without merging networks or refactoring IP addresses

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

## See also

- [[notes/GCP/PSC|PSC Terraform Resources]] — Terraform `google_compute_address` and `google_compute_forwarding_rule` for PSC endpoints
- [[notes/Networking/dns-zones-forwarding|DNS Zones & Forwarding Rules]] — private DNS zones for PSC endpoint hostname resolution
- [[notes/Networking/shared_vpc_knowledge|Shared VPC Knowledge]] — host/service project attachment and subnet sharing
- [[notes/Networking/cloud-nat-and-vpc-networking|Cloud NAT & VPC Networking]] — NAT gateway configuration for VPC egress

## Interview Prep

### Q: What is Private Service Connect and how does it differ from VPC Peering?

**A:** PSC is a networking capability that allows VPCs to access specific services privately without peering entire networks. Unlike VPC Peering — which connects entire networks, requires non-overlapping IP ranges, and is bidirectional — PSC connects to a single service, allows overlapping IPs, and is unidirectional (consumer → producer). PSC uses a Consumer-Producer model: the producer publishes a Service Attachment wrapping an Internal Load Balancer, and the consumer creates a PSC Endpoint (internal IP + forwarding rule) that tunnels traffic privately to that attachment.

### Q: Can PSC work when consumer and producer VPCs have overlapping IP ranges?

**A:** Yes. This is one of PSC's key advantages over VPC Peering. PSC creates a private tunnel at the SDN level — the consumer accesses the service via a local internal IP in their own VPC, and Google's network fabric routes it to the producer's service attachment. The two VPCs never merge routing tables, so overlapping CIDRs are not a problem.

### Q: Why must a PSC endpoint be in the same region as the service it connects to?

**A:** PSC endpoints connect to Service Attachments, which are regional resources backed by regional Internal Load Balancers. The forwarding rule and compute address that form the PSC endpoint must be in the same region as the target service attachment. If your runners are in Virginia but the service is in Tokyo, you create the PSC endpoint in a Tokyo subnet — cross-region routing within the same VPC handles the rest.

### Q: Walk through the complete data flow when a runner in Virginia connects to an Octopus server in Tokyo via PSC.

**A:** (1) The runner calls `octopus.lab.psc.internal`. (2) Cloud DNS resolves this via a private zone to the PSC endpoint's internal IP (e.g., `10.36.200.x`) in the Tokyo subnet. (3) The VPC routes the packet to Tokyo (same VPC, cross-region). (4) The forwarding rule on that IP matches and tunnels the packet to the producer's Service Attachment URI. (5) The Service Attachment checks the consumer project against its `consumer_accept_lists`. (6) If allowed, traffic reaches the producer's Internal Load Balancer, which forwards to the Octopus pods. The return path reverses through the same tunnel.

### Q: What is the `network` field in a PSC forwarding rule, and why is it required even when the address already specifies a subnetwork?

**A:** Internal IPs like `10.x.x.x` are only unique within a VPC. The `network` field tells the forwarding rule which VPC's routing table to register in. In a Shared VPC, the network is managed by the host project while the forwarding rule lives in a service project — the explicit network field ensures the endpoint is visible to the entire shared VPC, not just the service project's local scope.
