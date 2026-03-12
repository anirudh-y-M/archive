---
title: Cloud NAT & VPC Networking
---

## VPC (Virtual Private Cloud)

A VPC is your private network inside GCP. Think of it as your own isolated section of the cloud where your VMs, containers, and services talk to each other using private IPs. Traffic within a VPC stays private — the internet can't reach in unless you explicitly allow it.

A **Shared VPC** lets one "host" project own the network, while other "service" projects (like your GKE clusters) attach to it. This way, one team controls the network, and other teams just use it.

### Subnets

A VPC is divided into **subnets** — IP ranges assigned to a region. Each subnet lives in one region (e.g., `us-east4`). VMs and pods get their IPs from the subnet they're in.

Subnets matter for NAT because NAT rules can target specific subnets. If you want different NAT behavior for different workloads, you put those workloads on different subnets.

### Firewall Rules

VPC firewall rules control what traffic is allowed in and out. They operate at the network level — you define rules like "allow TCP port 443 from any source" or "deny all ingress from 10.0.0.0/8." These apply to VMs based on tags or service accounts.

## Cloud NAT

Cloud NAT lets VMs with only private IPs access the internet without exposing them publicly. It sits at the edge of your VPC and translates private IPs to public IPs for outbound traffic.

### How it works

```
Pod (private IP: 10.0.1.5)
  → leaves the VPC
  → Cloud NAT rewrites source to a public IP (e.g., 35.199.0.71)
  → request reaches GitHub
  → GitHub sees 35.199.0.71, not 10.0.1.5
  → response comes back to 35.199.0.71
  → Cloud NAT translates back to 10.0.1.5
  → Pod receives the response
```

### NAT IPs and Ports

Each public NAT IP has ~64K usable ports. Every outbound connection from a VM uses one port. So one IP can handle ~64K concurrent connections.

When you have multiple IPs, Cloud NAT distributes VMs across them. Each VM gets a reservation of ports (controlled by `min_ports_per_vm` and `max_ports_per_vm`).

### Port Allocation Settings

- **min_ports_per_vm** — ports reserved upfront per VM, even if idle. Lower = more VMs can share an IP. Higher = guaranteed headroom for bursts but fewer VMs per IP.
- **max_ports_per_vm** — cap on how many ports a single VM can grab. Prevents one bursty VM from eating an entire IP.
- **Dynamic port allocation** — VMs start at `min` and scale up to `max` as needed. There's a small lag when scaling up.
- **tcp_established_idle_timeout** / **tcp_time_wait_timeout** — how long ports stay reserved after connections close. Lower = ports recycle faster.

### NAT Rules

NAT rules let you route traffic to different IPs based on the destination. Each rule matches a destination IP range and assigns specific NAT IPs.

Example: if GitHub's servers resolve to 3 different IP ranges, you can create 3 rules, each with different NAT IPs. This controls which of your public IPs are used for which destinations.

The key learning: **Cloud NAT does not evenly distribute traffic across IPs within the same rule.** The allocation algorithm is not publicly documented, and in practice, traffic tends to concentrate on a few IPs. The fix: split into one IP per rule so there's no choice to make — each destination range gets exactly one IP.

### Endpoint-Independent Mapping

When **disabled**, Cloud NAT can reuse the same port for connections to different destinations. Port 12345 can be used for a connection to GitHub AND a connection to Google at the same time. This means one IP can handle more than 64K total connections — just not more than 64K to the same destination.

When **enabled**, each port is exclusively reserved regardless of destination. Simpler but wastes ports.

### OUT_OF_RESOURCES

This error means Cloud NAT ran out of ports to allocate. A VM tried to open a new connection but its port allocation was maxed out. Common during traffic bursts. Fix: increase `min_ports_per_vm` or `max_ports_per_vm`, add more NAT IPs, or reduce connection hold times.

### Monitoring

- **`nat/allocated_ports`** — ports currently reserved per VM per IP. Shows distribution.
- **`nat/dropped_sent_packets_count`** with reason `OUT_OF_RESOURCES` — packets dropped because no ports available.
- **`get-nat-mapping-info`** — live snapshot of which VMs have ports on which IPs. Not historical, just the current moment.

Cloud NAT operates at **Layer 3/4** (IP and TCP). It cannot see HTTP status codes, URLs, or headers. If GitHub returns a 401, Cloud NAT has no idea — it just forwards the TCP packets.

## GKE Secondary IP Ranges (Pod Ranges)

A GKE subnet has a **primary IP range** (for node IPs) and one or more **secondary IP ranges** (for pod IPs). When you create a node pool, you assign it a secondary range via `pod_range` — all pods on that pool get IPs from that range.

Multiple secondary ranges can live on the **same subnet**. This matters for NAT because Cloud NAT can target specific secondary ranges using `LIST_OF_SECONDARY_IP_RANGES`, giving you per-pool egress control without needing separate subnets.

## GKE Node Pools and NAT

See [[notes/kubernetes|Kubernetes Concepts]] for details on **Node Pools**, **nodeSelector**, and **Tolerations**.

Different node pools can use different pod ranges (secondary IP ranges). Cloud NAT can route different secondary ranges through different NAT gateways. By steering workloads to specific node pools, you control which egress IPs they use.

### Isolating Traffic with a Dedicated NAT

To route a subset of workloads through a specific egress IP:

1. **Add a new secondary IP range** to the existing subnet
2. **Create a new Cloud NAT** with its own static IP, targeting only that range
3. **Modify the existing NAT** to exclude the new range — switch from `ALL_IP_RANGES` to an explicit `LIST_OF_SECONDARY_IP_RANGES`
4. **Create a node pool** with `pod_range` pointing to the new range, plus a **taint** for scheduling control
5. **Configure workloads** to tolerate the taint

Key constraint: **Cloud NAT does not allow two gateways on the same router to cover the same IP range.** When carving out a dedicated range, you must explicitly enumerate all other ranges in the existing NAT.

## See also

- [[notes/GCP/gke-subnet-ip-allocation|GKE Subnet & IP Allocation]] — primary vs secondary ranges, per-node pod CIDR blocks
- [[notes/Networking/gke-vpc-subnet-scenarios|GKE VPC Subnet Scenarios]] — subnet overlap, shared subnet, and nested subnet patterns
- [[notes/Networking/gke-snat-ip-masquerade|GKE SNAT & IP Masquerading]] — ip-masq-agent, iptables, how pod IPs get rewritten before reaching Cloud NAT
- [[notes/Networking/shared_vpc_knowledge|Shared VPC Knowledge]] — host/service project attachment, subnet sharing across projects
