---
title: "GKE SNAT & IP Masquerading: ip-masq-agent, iptables, and Cloud NAT"
---

## SNAT (Source Network Address Translation)

SNAT replaces the **source IP** of a packet as it passes through a router or firewall. When a device with a private IP (e.g., `192.168.1.5`) sends a request to the internet, the router swaps the source address with its own public IP. The router keeps a translation table so return traffic gets routed back to the correct internal device.

```
Pod (10.48.1.5) → Node iptables (SNAT to 10.128.0.5) → Cloud NAT (SNAT to 35.199.0.71) → Internet
```

Why SNAT exists:

- **IP conservation**: Hundreds of devices share a single public IP.
- **Security**: Internal IPs are hidden from external servers.
- **Cloud routing**: Private-only instances can reach the internet without being directly exposed.

### SNAT vs DNAT

| | SNAT (Source NAT) | DNAT (Destination NAT) |
| --- | --- | --- |
| What changes | Source (originating) IP | Destination (target) IP |
| Typical use | Internal devices reaching the internet | External users reaching an internal server |
| Example | General web browsing | Port forwarding, hosting a web server |

When people say "NAT" in casual conversation, they almost always mean SNAT.

---

## IP Masquerading in GKE

IP masquerading is a form of SNAT where the source IP of a packet from a **Pod** is replaced with the **Node's** IP. By default, when a Pod sends traffic to the internet, the destination only sees the Node's IP, not the Pod IP.

This happens because:

- External networks don't know how to route traffic back to private Pod IPs.
- Many firewalls only allow traffic from known VM/Node IP ranges.

### Default masquerading behavior

| Destination | Default behavior | Source IP seen by destination |
| --- | --- | --- |
| Another Pod in the cluster | No masquerade | Pod IP |
| Internal VPC resource (RFC 1918) | No masquerade | Pod IP |
| Public internet | **Masquerade** | Node IP (or Cloud NAT IP) |

The defaults make sense: intra-cluster and VPC-internal traffic preserves Pod IPs for observability and network policy enforcement, while internet-bound traffic gets masqueraded because external routers can't route private Pod CIDRs.

---

## The ip-masq-agent

The ip-masq-agent is a **DaemonSet** running in `kube-system` on every GKE node. It reads a ConfigMap and writes iptables rules that control which destinations are exempt from masquerading.

### How it works (chain of command)

```
ConfigMap (your rules)
    ↓  watched by
ip-masq-agent (DaemonSet pod)
    ↓  writes to
iptables IP-MASQ chain (Linux kernel)
    ↓  applied to
every outbound packet from Pods on that node
```

The ConfigMap is the request. The iptables rules are the reality. If the reality doesn't match your request, the agent is failing to sync.

### The ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ip-masq-agent
  namespace: kube-system
data:
  config: |
    nonMasqueradeCIDRs:
      - 10.0.0.0/8
      - 172.16.0.0/12
      - 192.168.0.0/16
    resyncInterval: 60s
```

`nonMasqueradeCIDRs` — destinations where the Pod IP is **preserved** (no masquerade). Traffic to any destination not listed here gets masqueraded to the Node IP.

Common formatting mistakes that silently break the agent:

- Missing `config: |` — the entire configuration must be a single string under the `config` key.
- Wrong namespace — must be `kube-system`.
- Wrong name — must be `ip-masq-agent`.
- Invalid CIDR notation (e.g., `10.50.0.300/24`).
- YAML indentation errors.

---

## Checking if Masquerading is Happening

### Check if the agent is running

```bash
kubectl get pods -n kube-system -l k8s-app=ip-masq-agent
```

### Inspect the ConfigMap

```bash
kubectl describe configmap ip-masq-agent -n kube-system
```

### Check iptables on the node

SSH into a node and inspect the IP-MASQ chain:

```bash
gcloud compute ssh [NODE_NAME] --zone=[ZONE]
sudo iptables -t nat -L IP-MASQ -n -v
```

A correctly configured output looks like:

```
Chain IP-MASQ (2 references)
target     prot opt source               destination
RETURN     all  --  anywhere             10.0.0.0/8          ← Pod IP preserved
RETURN     all  --  anywhere             172.16.0.0/12       ← Pod IP preserved
RETURN     all  --  anywhere             169.254.0.0/16      ← Link-local preserved
MASQUERADE all  --  anywhere             anywhere            ← Catch-all: masquerade everything else
```

- **RETURN** = "Do NOT masquerade this packet. Keep the original Pod IP."
- **MASQUERADE** = "Change the source IP to the Node's IP." This must always be the **last** rule in the chain.

If you only see the `MASQUERADE` catch-all rule and no `RETURN` rules, your ConfigMap isn't being applied — 100% of outbound traffic is being SNATed to the Node IP. Check the agent logs:

```bash
AGENT_POD=$(kubectl get pods -n kube-system -l k8s-app=ip-masq-agent -o jsonpath='{.items[0].metadata.name}')
kubectl logs $AGENT_POD -n kube-system
```

### Live test from a Pod

Test what the destination actually sees:

```bash
# Internet traffic — should show Node/Cloud NAT public IP
kubectl run -it --rm --restart=Never debug-pod --image=curlimages/curl -- curl ifconfig.me

# VPC-internal traffic — curl another VM and check its logs
# If logs show Pod IP → no masquerade (expected for internal)
# If logs show Node IP → masquerade is happening
```

### Watch live translations with conntrack

```bash
sudo conntrack -L -p tcp --orig-src [POD_IP]
```

Shows active translation mappings the node is maintaining.

---

## The Double SNAT Problem: ip-masq-agent and Cloud NAT

In GKE with Cloud NAT, there are **two** translation layers:

| Stage | Action | Source IP changes from | To |
| --- | --- | --- | --- |
| 1. Node level | IP masquerade (iptables) | Pod IP (e.g., `10.48.x.x` — secondary range) | Node IP (e.g., `10.128.x.x` — primary range) |
| 2. VPC edge | Cloud NAT | Node IP | Static public IP (e.g., `34.x.x.x`) |

This double translation directly affects how you configure Cloud NAT's `source_subnetwork_ip_ranges_to_nat`.

---

## Cloud NAT: Which Ranges to NAT

### If ip-masq-agent is enabled (default)

The agent rewrites Pod IPs → Node IPs before packets reach Cloud NAT. Cloud NAT only sees **primary range** IPs. Technically, configuring Cloud NAT with just the primary range would work.

But `ALL_IP_RANGES` is the correct choice:

```hcl
subnetwork {
  name                    = "your-gke-subnetwork-name"
  source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
}
```

**Why not "primary only"?** If the ip-masq-agent crashes, gets misconfigured, or someone deletes the ConfigMap, pods will start sending packets with their original secondary range IPs. Cloud NAT configured for "primary only" will **drop** those packets because it doesn't recognize the secondary range. Internet access breaks silently.

### If you configure "secondary only" — it will fail

If ip-masq-agent is enabled and Cloud NAT is configured to only NAT the secondary range:

1. Pod sends packet: source = `10.48.x.x` (secondary/pod range).
2. Node iptables (ip-masq-agent) rewrites source to `10.128.x.x` (primary/node range).
3. Packet arrives at Cloud NAT: source = `10.128.x.x`.
4. Cloud NAT checks config: "I'm told to only NAT secondary range `10.48.x.x`."
5. Cloud NAT ignores the packet. The packet still has a private IP and gets dropped at the next router.

The packet was "already wearing" the Node IP by the time Cloud NAT saw it. The secondary range configuration is useless because ip-masq-agent already removed the secondary IP.

### If ip-masq-agent is disabled

Without the agent, Pod IPs (`10.48.x.x`) pass through to Cloud NAT unmodified. You must include the secondary range in the NAT config. But the nodes themselves need primary range NAT for OS updates, image pulls, and Google API access. So again — use `ALL_IP_RANGES`.

### The Terraform configuration

```hcl
resource "google_compute_router_nat" "nat_gateway" {
  name   = "nat-gateway"
  router = google_compute_router.router.name
  region = google_compute_router.router.region

  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = google_compute_address.nat_ips.*.self_link
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  subnetwork {
    name                    = "your-gke-subnetwork"
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }
}
```

If you need granular control (e.g., only NAT specific secondary ranges):

```hcl
subnetwork {
  name                    = "your-gke-subnetwork"
  source_ip_ranges_to_nat = ["PRIMARY_IP_RANGE", "LIST_OF_SECONDARY_IP_RANGES"]
  secondary_ip_range_names = ["your-pod-range-name"]
}
```

---

## Verifying Cloud NAT Traffic

### Enable NAT logging

In Terraform:

```hcl
log_config {
  enable = true
  filter = "ALL"   # or "TRANSLATIONS_ONLY", "ERRORS_ONLY"
}
```

### Query logs in Cloud Logging

```
resource.type="nat_gateway"
jsonPayload.vpc_id="your-vpc-name"
```

Key fields in the logs:

- `jsonPayload.local_ip` — the internal IP hitting Cloud NAT (Node IP if masquerading, Pod IP if not).
- `jsonPayload.external_ip` — the public IP assigned by Cloud NAT.
- `jsonPayload.dest_ip` — where the traffic is going.

### VPC Flow Logs

Enable VPC Flow Logs on the subnet to see traffic **after** it leaves the node but **before** Cloud NAT. Shows the source IP (Node IP if masqueraded) and destination for every connection attempt.

---

## See also

- [[notes/Networking/cloud-nat-and-vpc-networking|Cloud NAT & VPC Networking]]
- [[notes/GCP/gke-subnet-ip-allocation|GKE Subnet & IP Allocation for Node Pools]]
- [[notes/K8s/kubernetes|Kubernetes Concepts]]
- [GKE IP Masquerade Agent](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/ip-masquerade-agent)
- [Configuring ip-masq-agent](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/ip-masquerade-agent)

---

## Interview Prep

### Q: What is SNAT and how does it differ from DNAT?

**A:** SNAT (Source NAT) rewrites the **source** IP of a packet as it passes through a router. It allows devices with private IPs to communicate with the internet by replacing their private source address with the router's public IP. The router maintains a translation table (conntrack) to map return traffic back to the correct internal device.

DNAT (Destination NAT) rewrites the **destination** IP — used when external traffic needs to reach an internal server (e.g., port forwarding). A public IP maps to a private server's IP, so inbound traffic is redirected to the internal host.

The key difference is directionality: SNAT handles **outbound** traffic (internal → external), DNAT handles **inbound** traffic (external → internal). In GKE, the ip-masq-agent performs SNAT at the node level (Pod IP → Node IP), and Cloud NAT performs SNAT at the VPC edge (Node IP → Public IP). DNAT is less common in GKE — it's more relevant for load balancers and ingress controllers.

### Q: Walk through what happens to a packet's source IP as it travels from a Pod to the internet in a GKE cluster with ip-masq-agent enabled and Cloud NAT configured.

**A:** The packet goes through two SNAT translations:

**Stage 1 — Inside the node (iptables/ip-masq-agent):** The Pod sends a packet with source IP `10.48.1.5` (from the subnet's secondary pod range) destined for `140.82.113.3` (GitHub). The packet hits the node's iptables `IP-MASQ` chain. The chain has `RETURN` rules for internal CIDRs (e.g., `10.0.0.0/8`, `172.16.0.0/12`). Since `140.82.113.3` is a public IP, it doesn't match any `RETURN` rule and falls through to the `MASQUERADE` target. The kernel rewrites the source IP from `10.48.1.5` to the node's primary IP `10.128.0.5` and records the mapping in the conntrack table.

**Stage 2 — At the VPC edge (Cloud NAT):** The packet leaves the node with source `10.128.0.5`. It reaches the Cloud NAT gateway attached to the VPC router. Cloud NAT checks its configuration: the subnet's primary range is included in `source_ip_ranges_to_nat`. Cloud NAT rewrites the source from `10.128.0.5` to a static public IP `35.199.0.71`, picks an available port, and records the mapping.

**The packet on the wire to GitHub:** source = `35.199.0.71:54321`, destination = `140.82.113.3:443`. GitHub sees only the Cloud NAT IP. When GitHub responds, the return path reverses: Cloud NAT translates `35.199.0.71` back to `10.128.0.5`, and the node's conntrack translates `10.128.0.5` back to `10.48.1.5` and delivers the packet to the Pod.

### Q: You SSH into a GKE node and run `sudo iptables -t nat -L IP-MASQ -n -v`. You see only the `MASQUERADE` catch-all rule and no `RETURN` rules. What does this mean and how do you fix it?

**A:** This means 100% of outbound Pod traffic on that node is being masqueraded — every packet gets its source IP rewritten to the Node IP, regardless of destination. Normally, you should see `RETURN` rules for internal CIDRs (like `10.0.0.0/8`, `172.16.0.0/12`, `169.254.0.0/16`) that preserve the Pod IP for intra-VPC traffic.

The missing `RETURN` rules mean the ip-masq-agent is either not running or failing to read the ConfigMap. Debugging steps:

1. Check if the agent pods exist: `kubectl get pods -n kube-system -l k8s-app=ip-masq-agent`. If no pods are found, the DaemonSet may have been deleted or the cluster doesn't have the agent enabled.
2. Check the ConfigMap: `kubectl describe configmap ip-masq-agent -n kube-system`. Verify it exists, is in the correct namespace, has the correct name (`ip-masq-agent`), and uses the `config: |` multiline string syntax with properly indented `nonMasqueradeCIDRs`.
3. Check agent logs: `kubectl logs <agent-pod> -n kube-system`. Look for YAML parsing errors, invalid CIDRs, or permission issues.

Common causes: missing `config: |` prefix in the ConfigMap data, wrong ConfigMap name/namespace, invalid CIDR notation, YAML indentation errors. The ConfigMap is the "request" — the iptables rules are the "reality." If they don't match, the agent failed to translate one into the other.

### Q: If ip-masq-agent is enabled, why can't you configure Cloud NAT to only NAT the secondary (pod) IP range?

**A:** Because the ip-masq-agent has already rewritten the source IP before the packet reaches Cloud NAT. By the time a Pod's packet arrives at the VPC edge, its source IP has been changed from the secondary range (e.g., `10.48.x.x`) to the primary range (e.g., `10.128.x.x`) by the node's iptables rules. Cloud NAT never sees a secondary range IP — it sees a primary range IP. If Cloud NAT is configured to only handle secondary ranges, it ignores the packet. The packet still carries a private IP and gets dropped at the next router because private IPs aren't routable on the public internet.

This is why the recommended configuration is `ALL_IP_RANGES`. It acts as a safety net: if ip-masq-agent is working, Cloud NAT sees primary range IPs and translates them. If the agent crashes or gets misconfigured, Cloud NAT sees secondary range IPs and still translates them. Either way, packets reach the internet. See [[notes/Networking/cloud-nat-and-vpc-networking|Cloud NAT & VPC Networking]] for full NAT gateway configuration details.

### Q: What is the difference between `ALL_IP_RANGES`, `PRIMARY_IP_RANGE`, and `LIST_OF_SECONDARY_IP_RANGES` in Cloud NAT's `source_ip_ranges_to_nat`?

**A:** These control which source IPs Cloud NAT will translate for a given subnet:

- `ALL_IP_RANGES` — NAT all traffic from this subnet: node IPs (primary), pod IPs (secondary pod range), and service IPs (secondary service range). The safest and most common choice for GKE.
- `PRIMARY_IP_RANGE` — Only NAT traffic with source IPs from the subnet's primary CIDR. Covers node VMs but not pods (unless ip-masq-agent already rewrote pod IPs to node IPs).
- `LIST_OF_SECONDARY_IP_RANGES` — Only NAT traffic from specific secondary ranges, specified by `secondary_ip_range_names`. Used when you need to NAT pod traffic but not node traffic, or when different secondary ranges need different NAT gateways.

You can combine `PRIMARY_IP_RANGE` and `LIST_OF_SECONDARY_IP_RANGES` to selectively include specific ranges. For GKE, `ALL_IP_RANGES` is almost always correct because it handles both the normal case (ip-masq-agent rewrites to primary) and the failure case (agent down, pods send with secondary IPs).

## See also

- [[notes/GCP/gke-subnet-ip-allocation|GKE Subnet & IP Allocation]] — primary vs secondary ranges, Alias IP mechanics
- [[notes/Networking/gke-vpc-subnet-scenarios|GKE VPC Subnet Scenarios]] — subnet design patterns (separate, shared, nested)
- [[notes/Networking/cloud-nat-and-vpc-networking|Cloud NAT & VPC Networking]] — NAT gateway config, port allocation, per-range control
- [[notes/Networking/shared_vpc_knowledge|Shared VPC Knowledge]] — host/service project attachment
