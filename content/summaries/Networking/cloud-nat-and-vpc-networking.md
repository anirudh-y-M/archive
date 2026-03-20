---
title: "Summary: Cloud NAT & VPC Networking"
---

> **Full notes:** [[notes/Networking/cloud-nat-and-vpc-networking|Cloud NAT & VPC Networking -->]]

## Key Concepts

### VPC (Virtual Private Cloud)

A VPC is your private network inside GCP -- an isolated section where VMs, containers, and services communicate via private IPs. Traffic within a VPC stays private unless you explicitly allow internet access. A **Shared VPC** lets one "host" project own the network while "service" projects attach to it, centralizing network control.

### Subnets

VPCs are divided into **subnets** -- IP ranges assigned to a region. Each subnet lives in one region (e.g., `us-east4`). VMs and Pods get IPs from their subnet. NAT rules can target specific subnets, enabling different NAT behavior for different workloads.

### Firewall Rules

VPC firewall rules control ingress/egress at the network level. Defined as allow/deny rules for specific protocols and ports, applied to VMs based on tags or service accounts.

### Cloud NAT -- How It Works

Cloud NAT translates private IPs to public IPs for **outbound-only** traffic. Pods/VMs with only private IPs can reach the internet without being publicly exposed. The flow: Pod sends with private IP --> Cloud NAT rewrites source to public IP --> request reaches destination --> response returns to public IP --> Cloud NAT translates back to private IP --> Pod receives response.

### NAT IPs and Ports

Each NAT public IP has ~64K usable ports. Every outbound connection uses one port, so one IP handles ~64K concurrent connections. With multiple IPs, Cloud NAT distributes VMs across them. Each VM gets a port reservation controlled by `min_ports_per_vm` and `max_ports_per_vm`.

### Port Allocation Settings

- **`min_ports_per_vm`** -- ports reserved upfront per VM (even if idle). Lower = more VMs per IP. Higher = guaranteed burst headroom.
- **`max_ports_per_vm`** -- cap on ports a single VM can grab. Prevents one bursty VM from consuming an entire IP.
- **Dynamic port allocation** -- VMs start at `min` and scale up to `max` as needed. Small lag when scaling up.
- **`tcp_established_idle_timeout` / `tcp_time_wait_timeout`** -- how long ports stay reserved after connections close. Lower = faster port recycling.

### NAT Rules

NAT rules route traffic to different NAT IPs based on destination IP ranges. Key learning: **Cloud NAT does NOT evenly distribute traffic across IPs within the same rule.** The allocation algorithm is undocumented and traffic tends to concentrate on a few IPs. Fix: split into **one IP per rule** so each destination range gets exactly one IP -- no ambiguity.

### Endpoint-Independent Mapping

When **disabled**: the same port can be reused for connections to different destinations simultaneously (e.g., port 12345 for both GitHub and Google). One IP can handle more than 64K total connections -- just not more than 64K to the same destination. When **enabled**: each port is exclusively reserved regardless of destination. Simpler but wastes ports.

### OUT_OF_RESOURCES

This error means Cloud NAT ran out of ports for a VM. The VM tried to open a new connection but its port allocation was maxed. Common during traffic bursts. Fix: increase `min_ports_per_vm` or `max_ports_per_vm`, add more NAT IPs, or reduce connection hold times.

### Monitoring

- **`nat/allocated_ports`** -- ports currently reserved per VM per IP (shows distribution).
- **`nat/dropped_sent_packets_count`** with reason `OUT_OF_RESOURCES` -- packets dropped due to no available ports.
- **`get-nat-mapping-info`** -- live snapshot of which VMs have ports on which IPs (current moment only, not historical).

Cloud NAT operates at **L3/L4** (IP and TCP). It cannot see HTTP status codes, URLs, or headers.

### GKE Secondary IP Ranges (Pod Ranges)

A GKE subnet has a **primary range** (node IPs) and **secondary ranges** (pod IPs). Multiple secondary ranges can live on the same subnet. Cloud NAT can target specific secondary ranges using `LIST_OF_SECONDARY_IP_RANGES`, enabling per-node-pool egress control without separate subnets.

### GKE Node Pools and NAT

Different node pools can use different secondary ranges. Cloud NAT routes different secondary ranges through different NAT gateways. By steering workloads to specific node pools (via nodeSelector + tolerations), you control which egress IPs they use.

### Isolating Traffic with a Dedicated NAT

To route a subset of workloads through a specific egress IP:
1. Add a new secondary IP range to the existing subnet
2. Create a new Cloud NAT with its own static IP, targeting only that range
3. Modify the existing NAT to exclude the new range (switch from `ALL_IP_RANGES` to explicit `LIST_OF_SECONDARY_IP_RANGES`)
4. Create a node pool with `pod_range` pointing to the new range + taint
5. Configure workloads to tolerate the taint

**Key constraint:** Two Cloud NAT gateways on the same router cannot cover the same IP range. When carving out a dedicated range, you must explicitly enumerate all other ranges in the existing NAT.

## Quick Reference

```
Pod (10.0.1.5, private)
  --> Cloud NAT (rewrites src to 35.199.0.71, public)
    --> Internet (GitHub sees 35.199.0.71)
      <-- response to 35.199.0.71
    <-- Cloud NAT (translates back to 10.0.1.5)
  <-- Pod receives response
```

| Setting | Purpose |
|---|---|
| `min_ports_per_vm` | Guaranteed port reservation per VM |
| `max_ports_per_vm` | Burst cap (prevents one VM hogging an IP) |
| `tcp_established_idle_timeout` | How long ports stay reserved after close |
| Endpoint-Independent Mapping OFF | Port reuse across destinations (more efficient) |
| `nat/allocated_ports` | Monitor port distribution per VM |
| `OUT_OF_RESOURCES` | No ports available -- add IPs or raise limits |

**Dedicated NAT isolation flow:**
```
Same subnet, new secondary range
  --> New Cloud NAT (own static IP, targets new range only)
  --> Existing NAT updated (exclude new range, explicit list)
  --> New node pool (pod_range = new range, taint applied)
  --> Workloads with toleration land on new pool --> use dedicated egress IP
```

## Key Takeaways

- Cloud NAT is outbound-only and L3/L4 -- it cannot inspect or filter application-layer traffic.
- `OUT_OF_RESOURCES` is the most common Cloud NAT issue. Fix with more IPs, higher port limits, or lower idle timeouts.
- NAT IP distribution within a single rule is NOT even. Split into one IP per rule for predictable routing.
- Endpoint-Independent Mapping (disabled) allows port reuse across destinations, effectively exceeding the 64K limit per IP.
- Use `LIST_OF_SECONDARY_IP_RANGES` for per-node-pool egress control without needing separate subnets.
- Two Cloud NAT gateways on the same router must NOT overlap on IP ranges -- explicitly enumerate ranges when carving out dedicated NATs.
- Cloud NAT cannot see HTTP-level information (status codes, headers, URLs).
