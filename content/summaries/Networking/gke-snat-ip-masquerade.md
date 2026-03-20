---
title: "Summary: GKE SNAT & IP Masquerading"
---

> **Full notes:** [[notes/Networking/gke-snat-ip-masquerade|GKE SNAT & IP Masquerading -->]]

## Key Concepts

- **SNAT**: Rewrites the source IP of outbound packets. Allows private IPs to reach the internet by swapping the source to a public IP. A conntrack table maps return traffic back.

- **IP masquerading in GKE**: Pod IP (secondary range) is rewritten to Node IP (primary range) by iptables rules on the node. The ip-masq-agent DaemonSet manages these rules.

- **ip-masq-agent**: Reads a ConfigMap in `kube-system`, writes iptables rules to the `IP-MASQ` chain. `nonMasqueradeCIDRs` lists destinations where Pod IP is preserved. Everything else gets masqueraded to the Node IP.

- **Double SNAT**: Pod IP --> Node IP (ip-masq-agent, iptables) --> Public IP (Cloud NAT, VPC edge). Two separate translation layers.

- **Cloud NAT range config**: Always use `ALL_IP_RANGES`. If agent is working, Cloud NAT sees primary range IPs. If agent crashes, Cloud NAT sees secondary range IPs. Either way, packets get translated.

## Quick Reference

```
Pod (10.48.1.5)  --[ip-masq-agent]--> Node (10.128.0.5) --[Cloud NAT]--> Public (35.199.0.71)
  secondary range                       primary range                      static IP
```

**iptables IP-MASQ chain (correct state):**
```
RETURN     all  --  anywhere  10.0.0.0/8       <-- Pod IP preserved
RETURN     all  --  anywhere  172.16.0.0/12    <-- Pod IP preserved
MASQUERADE all  --  anywhere  anywhere          <-- catch-all (last rule)
```

| Destination | Masquerade? | Source IP seen |
|---|---|---|
| Another Pod (cluster) | No | Pod IP |
| VPC internal (RFC 1918) | No | Pod IP |
| Public internet | Yes | Node IP --> Cloud NAT IP |

**Debugging:**
- `kubectl get pods -n kube-system -l k8s-app=ip-masq-agent` -- agent running?
- `sudo iptables -t nat -L IP-MASQ -n -v` -- rules correct?
- Only MASQUERADE rule = ConfigMap not applied

## Key Takeaways

- The ip-masq-agent is the bridge between your ConfigMap (intent) and iptables (reality). If they don't match, the agent failed to sync.
- Always use `ALL_IP_RANGES` in Cloud NAT config as a safety net for agent failures.
- Configuring Cloud NAT for "secondary only" silently fails when ip-masq-agent is active, because the agent already rewrites to primary range IPs.
- Missing `RETURN` rules in `IP-MASQ` chain means 100% of traffic is being masqueraded -- check ConfigMap syntax and agent logs.
- Common ConfigMap pitfalls: missing `config: |`, wrong name/namespace, invalid CIDR, YAML indentation.
