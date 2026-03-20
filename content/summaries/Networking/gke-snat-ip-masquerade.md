---
title: "Summary: GKE SNAT & IP Masquerading"
---

> **Full notes:** [[notes/Networking/gke-snat-ip-masquerade|GKE SNAT & IP Masquerading -->]]

## Key Concepts

### SNAT (Source Network Address Translation)

SNAT replaces the **source IP** of outbound packets as they pass through a router. Devices with private IPs can reach the internet by having the router swap their source address with its public IP. A conntrack translation table maps return traffic back. SNAT is for outbound traffic (internal --> external); DNAT rewrites destination IP for inbound traffic (external --> internal). When people say "NAT" casually, they almost always mean SNAT.

### IP Masquerading in GKE

IP masquerading is SNAT where a Pod's source IP is replaced with the Node's IP. External networks can't route back to private Pod IPs, and many firewalls only allow traffic from known Node IP ranges. Default behavior: intra-cluster and VPC-internal traffic (RFC 1918) preserves Pod IPs for observability and network policy; internet-bound traffic gets masqueraded to Node IP.

| Destination | Default Behavior | Source IP Seen |
|---|---|---|
| Another Pod (cluster) | No masquerade | Pod IP |
| VPC internal (RFC 1918) | No masquerade | Pod IP |
| Public internet | **Masquerade** | Node IP (or Cloud NAT IP) |

### The ip-masq-agent

A **DaemonSet** in `kube-system` on every GKE node. It reads a ConfigMap and writes iptables rules to the `IP-MASQ` chain. The ConfigMap is the "request" (intent); the iptables rules are the "reality." If they don't match, the agent is failing to sync.

**Chain of command:** ConfigMap --> ip-masq-agent (watches) --> iptables IP-MASQ chain (writes) --> every outbound packet (applies).

The ConfigMap's `nonMasqueradeCIDRs` lists destinations where Pod IP is **preserved** (no masquerade). Traffic to any unlisted destination gets masqueraded to Node IP. Common formatting mistakes that silently break the agent: missing `config: |`, wrong namespace (must be `kube-system`), wrong name (must be `ip-masq-agent`), invalid CIDR notation, YAML indentation errors.

### Checking if Masquerading is Happening

**Agent running?** `kubectl get pods -n kube-system -l k8s-app=ip-masq-agent`

**ConfigMap correct?** `kubectl describe configmap ip-masq-agent -n kube-system`

**iptables on the node:** SSH in and run `sudo iptables -t nat -L IP-MASQ -n -v`. Correct output shows `RETURN` rules for internal CIDRs (Pod IP preserved) followed by a `MASQUERADE` catch-all as the last rule. If you see only the `MASQUERADE` catch-all with no `RETURN` rules, 100% of traffic is being SNATed -- the ConfigMap isn't being applied.

**Live test:** `kubectl run --rm -it debug -- curl ifconfig.me` (should show Cloud NAT public IP for internet traffic). For VPC-internal: curl another VM and check its logs for Pod IP vs Node IP.

**conntrack:** `sudo conntrack -L -p tcp --orig-src [POD_IP]` shows active translation mappings.

### The Double SNAT Problem

In GKE with Cloud NAT, there are **two translation layers**:

```
Pod IP (10.48.x.x, secondary range)
  --[ip-masq-agent/iptables]--> Node IP (10.128.x.x, primary range)
    --[Cloud NAT]--> Public IP (34.x.x.x, static)
```

This directly affects how you configure Cloud NAT's `source_subnetwork_ip_ranges_to_nat`.

### Cloud NAT: Which Ranges to NAT

**If ip-masq-agent is enabled (default):** The agent rewrites Pod IPs to Node IPs before packets reach Cloud NAT. Cloud NAT only sees primary range IPs. But use `ALL_IP_RANGES` anyway -- if the agent crashes or gets misconfigured, pods send with secondary range IPs, and "primary only" config would silently drop those packets.

**If you configure "secondary only" -- it will fail:** The agent already rewrites to primary range before Cloud NAT sees the packet. Cloud NAT is told to only NAT secondary range -- it ignores the (now primary range) packet. The packet still has a private IP and gets dropped.

**If ip-masq-agent is disabled:** Pod IPs pass through unmodified. Must include secondary range in NAT config. But nodes still need primary range for OS updates/image pulls. So again: use `ALL_IP_RANGES`.

**Terraform config:**
```hcl
subnetwork {
  name                    = "your-gke-subnetwork"
  source_ip_ranges_to_nat = ["ALL_IP_RANGES"]  # safest choice
}
```

For granular control (specific secondary ranges only):
```hcl
source_ip_ranges_to_nat = ["PRIMARY_IP_RANGE", "LIST_OF_SECONDARY_IP_RANGES"]
secondary_ip_range_names = ["your-pod-range-name"]
```

### Verifying Cloud NAT Traffic

**Enable NAT logging** in Terraform: `log_config { enable = true; filter = "ALL" }`.

**Query logs:** `resource.type="nat_gateway"` in Cloud Logging. Key fields: `local_ip` (internal IP hitting NAT), `external_ip` (public IP assigned), `dest_ip` (where traffic goes).

**VPC Flow Logs:** Enable on the subnet to see traffic after it leaves the node but before Cloud NAT. Shows the source IP (Node IP if masqueraded) and destination.

## Quick Reference

```
Pod (10.48.1.5)  --[ip-masq-agent]--> Node (10.128.0.5) --[Cloud NAT]--> Public (35.199.0.71)
  secondary range                      primary range                      static IP
```

**iptables IP-MASQ chain (correct state):**
```
RETURN     all  --  anywhere  10.0.0.0/8       <-- Pod IP preserved (internal)
RETURN     all  --  anywhere  172.16.0.0/12    <-- Pod IP preserved (internal)
RETURN     all  --  anywhere  169.254.0.0/16   <-- Link-local preserved
MASQUERADE all  --  anywhere  anywhere          <-- catch-all (MUST be last rule)
```

**Only MASQUERADE rule visible = ConfigMap not applied. Check:**
1. Agent pods exist? (`kubectl get pods -n kube-system -l k8s-app=ip-masq-agent`)
2. ConfigMap correct? (name, namespace, `config: |` syntax, valid CIDRs)
3. Agent logs? (`kubectl logs <agent-pod> -n kube-system`)

| Cloud NAT Config | What Happens |
|---|---|
| `ALL_IP_RANGES` | NATs everything -- safest, handles agent failure |
| `PRIMARY_IP_RANGE` only | Works if agent is up; breaks if agent down |
| `LIST_OF_SECONDARY_IP_RANGES` only | Fails silently if agent is up (agent rewrites to primary before NAT sees it) |

## Key Takeaways

- The ip-masq-agent bridges your ConfigMap (intent) and iptables rules (reality). If they don't match, the agent failed to sync -- check ConfigMap syntax and agent logs.
- Always use `ALL_IP_RANGES` in Cloud NAT config as a safety net for agent failures.
- Configuring Cloud NAT for "secondary only" silently fails when ip-masq-agent is active, because the agent already rewrites Pod IPs to primary range IPs before packets reach Cloud NAT.
- Missing `RETURN` rules in the `IP-MASQ` chain means 100% of outbound traffic is masqueraded -- the ConfigMap isn't being applied.
- Common ConfigMap pitfalls: missing `config: |` prefix, wrong name/namespace, invalid CIDR notation, YAML indentation errors.
- The double SNAT flow (Pod IP --> Node IP --> Public IP) means Cloud NAT must handle the range it actually sees (primary, after agent rewrite), not the range you might expect (secondary, before rewrite).
- Use VPC Flow Logs and Cloud NAT logs together to verify which IP Cloud NAT is seeing and translating.
