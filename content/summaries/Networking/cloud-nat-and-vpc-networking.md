---
title: "Summary: Cloud NAT & VPC Networking"
---

> **Full notes:** [[notes/Networking/cloud-nat-and-vpc-networking|Cloud NAT & VPC Networking -->]]

## Key Concepts

- **VPC**: Your private network in GCP. Divided into regional subnets. Shared VPC lets one host project own the network while service projects attach to it.

- **Cloud NAT**: Translates private IPs to public IPs for outbound-only traffic. Operates at L3/L4 -- cannot see HTTP headers or status codes. Each NAT IP supports ~64K concurrent connections (one port per connection).

- **Port allocation**: `min_ports_per_vm` (reserved upfront), `max_ports_per_vm` (burst cap), dynamic allocation scales between them. `OUT_OF_RESOURCES` means a VM maxed its port allocation.

- **NAT rules and IP distribution**: Traffic does NOT distribute evenly across IPs within a single rule. Fix: use one IP per rule to force deterministic routing.

- **Endpoint-Independent Mapping**: When disabled, the same port can be reused for different destinations (more efficient). When enabled, each port is exclusive regardless of destination.

- **GKE secondary ranges**: Pod IPs come from secondary ranges on the subnet. Cloud NAT can target specific secondary ranges, enabling per-node-pool egress control.

## Quick Reference

```
Pod (10.0.1.5) --> Cloud NAT (rewrites to 35.199.0.71) --> Internet
                                                        <-- return
            Cloud NAT (translates back to 10.0.1.5) <--
```

| Setting | Purpose |
|---|---|
| `min_ports_per_vm` | Guaranteed port reservation per VM |
| `max_ports_per_vm` | Burst cap to prevent one VM hogging an IP |
| `tcp_established_idle_timeout` | How long ports stay reserved after close |
| `nat/allocated_ports` | Monitoring: ports reserved per VM |
| `OUT_OF_RESOURCES` | Error: no ports available |

**Isolating traffic with dedicated NAT:**
1. Add new secondary IP range to subnet
2. Create new Cloud NAT with its own static IP targeting only that range
3. Update existing NAT to exclude the new range (switch to explicit list)
4. Create node pool with `pod_range` pointing to new range + taint
5. Two NATs on the same router cannot cover the same IP range

## Key Takeaways

- Cloud NAT is outbound-only and L3/L4 -- it cannot inspect or filter application traffic.
- `OUT_OF_RESOURCES` is the most common Cloud NAT issue; fix with more IPs, higher port limits, or lower idle timeouts.
- NAT IP distribution within a single rule is NOT even -- split into one IP per rule for predictability.
- Use `LIST_OF_SECONDARY_IP_RANGES` for per-pool egress control without needing separate subnets.
- Two Cloud NAT gateways on the same router must NOT overlap on IP ranges.
