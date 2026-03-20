---
title: "Summary: Container Networking Internals"
---

> **Full notes:** [[notes/Networking/container-networking-internals|Container Networking Internals -->]]

## Key Concepts

### Overview

Container networking on Linux is built on three kernel primitives: **network namespaces** (isolation), **veth pairs** (plumbing between namespaces), and **bridges** (switching within a namespace). Everything else -- Docker networking, K8s Services, kube-proxy, CNI plugins -- is layered on top using standard Linux networking (iptables, routing tables, ARP).

### Linux Network Namespaces

A network namespace gives a process its own isolated copy of the entire network stack: interfaces, IPs, routing table, iptables rules, port space, ARP table, `/proc/net`. A namespace is NOT a network/subnet -- one namespace can have interfaces on multiple subnets, and multiple namespaces can share the same subnet. Namespaces exist within a single kernel instance; they don't span machines.

The **root (host) namespace** contains the physical NIC, default internet route, and host iptables. Each container gets its own namespace. An interface can belong to **exactly one namespace** at a time -- this constraint is why veth pairs exist.

### The Pause Container (Kubernetes)

The **pause container** (`registry.k8s.io/pause:3.9`, ~700KB) creates and holds the Pod's network namespace via `unshare(CLONE_NEWNET)`. All other containers in the Pod join it (`--net=container:pause`). If pause dies, the namespace is destroyed and all containers lose networking. The kubelet restarts the entire Pod.

### veth Pairs

A veth pair is the **only** kernel construct that sends packets between namespaces. It consists of two virtual interfaces connected by an invisible kernel wire -- a packet in one end instantly appears at the other. One end lives in the container (`eth0`), the other in the host namespace (`vethXXXXXX`, plugged into the bridge). Created with `ip link add ... type veth peer name ...`, then one end is moved into the container's namespace.

### The docker0 Bridge

Without a bridge, veth endpoints in the host namespace are "dangling cables" with nowhere to go. `docker0` serves two roles: **(1) L2 switch** for container-to-container traffic (MAC learning, frame forwarding between veth ports) and **(2) L3 gateway** (`172.17.0.1`) for container-to-outside traffic (default route for all containers, packets enter host's IP routing stack). Docker assigns IPs from `172.17.0.0/16` by default.

### Complete Packet Flow: Container to Internet

Container app creates packet (src=172.17.0.2) --> container routing table sends to gateway 172.17.0.1 via eth0 --> veth pair tunnel crosses namespace boundary --> arrives at docker0 bridge --> bridge forwards to host IP stack (L3 routing) --> iptables POSTROUTING MASQUERADE rewrites src to host IP (10.128.0.5) --> conntrack records mapping --> physical NIC sends to internet. Return: conntrack un-SNATs, host routes to docker0, bridge switches to correct veth, packet arrives at container.

The masquerade rule: `-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE` -- only fires when traffic leaves via a non-docker0 interface (heading to outside world).

### Container-to-Container Communication (Same Host)

Pure L2 switching on docker0. Container A ARPs for Container B, docker0 floods/learns MACs, subsequent frames are switched directly between veth ports. No IP routing, no iptables, no NAT. Source IP preserved end-to-end.

**Cross-host**: Each host has its own `docker0` with overlapping `172.17.0.0/16` -- addresses are ambiguous. CNI plugins solve this via overlay networks (Flannel VXLAN), BGP routing (Calico), or cloud-native IPs (AWS VPC CNI).

### Why Not Skip the Bridge? (Modern CNIs DO)

Without a bridge, containers have no gateway IP, no L2 path between veth endpoints, and no ARP resolution. Modern CNIs like **Calico** bypass the bridge using **point-to-point (PtP) routing**: each container gets a `/32` address, the host has explicit routes (`10.48.1.2 dev caliXXXX scope link`), and `proxy_arp` on each interface answers ARP for the link-local gateway (`169.254.1.1`). Container-to-container traffic is routed at L3 through the host -- no bridge, no ARP flooding, no MAC learning.

### Alternative Network Modes

**Macvlan**: Container gets its own MAC address on the physical network, appearing as a separate device. Real IPs from physical DHCP/static pool. No bridge, no NAT. Limitation: host-to-container communication blocked (no hairpin between macvlan child and parent).

**`--network host`**: Container shares the host's network namespace entirely. Zero overhead (no veth, no bridge, no NAT) but zero isolation. Port conflicts are real. In K8s: `hostNetwork: true`, used for kube-proxy, CNI agents, ingress controllers.

### kube-proxy and DNAT

kube-proxy watches the K8s API for Service/EndpointSlice objects and writes **iptables DNAT rules** on each node. It is a control-plane agent, NOT in the data path -- it writes rules and sleeps. The chain hierarchy: `PREROUTING/OUTPUT` --> `KUBE-SERVICES` (matches ClusterIP:port) --> `KUBE-SVC-XXXX` (probability-based load balancing) --> `KUBE-SEP-YYY` (actual DNAT to Pod IP). Probabilities are calculated for equal weight (3 endpoints: 0.333, 0.500, remainder).

**iptables vs IPVS**: iptables uses linear chain traversal (O(n) per Service), degrades with thousands of Services. IPVS uses hash tables (O(1) lookups), supports richer LB algorithms (round-robin, least-conn, weighted).

### End-to-End: Pod-to-Service Packet Lifecycle

**Setup phase (once):** K8s creates Service/EndpointSlices --> kube-proxy watches --> writes iptables rules --> sleeps. **Request phase (every packet):** Pod DNS lookup (CoreDNS returns ClusterIP) --> Pod sends to ClusterIP --> exits via veth --> host netfilter matches iptables DNAT rules --> randomly selects backend Pod --> rewrites dst IP --> conntrack records mapping (subsequent packets skip iptables) --> standard routing delivers to real Pod (same node via veth, different node via physical NIC + CNI).

### conntrack (Connection Tracking)

Only the **first packet** (SYN) traverses the full iptables NAT chain. Conntrack records the translation in a hash table. All subsequent packets use the conntrack fast path, skipping iptables entirely. Return traffic is un-DNAT'd so the sender sees responses from the expected Service IP.

**Table exhaustion**: Default max ~128K entries. When full, new connections are silently dropped. Diagnose: `dmesg | grep conntrack` shows "table full." Fix: increase `nf_conntrack_max`.

**UDP/DNAT race condition**: Two simultaneous DNS queries can cause a conntrack insertion race -- both get DNAT'd, kernel tries to create two entries with the same tuple, one fails, packet dropped. Causes 5-second DNS delays. Fix: `single-request-reopen` in resolv.conf, NodeLocal DNSCache, or Cilium/eBPF.

### EndpointSlices

Legacy Endpoints: one massive object per Service with ALL Pod IPs. Any change rewrites the entire object and pushes to every node. EndpointSlices shard into chunks of ~100 endpoints. Only the affected slice is updated on Pod changes. Also carry topology metadata (node, zone, ready/serving/terminating) for zone-aware routing.

### DNAT vs Forward Proxy vs Reverse Proxy vs HTTPS CONNECT

```
DNAT (L3/L4):         1 TCP conn, kernel rewrites dst IP, transparent, no content inspection
Forward Proxy (L7):   2 TCP conns, client explicitly configured, can cache/filter/authenticate
Reverse Proxy (L7):   2 TCP conns, client thinks proxy IS server, terminates TLS, path-based routing
HTTPS CONNECT (L7->L4): L7 handshake then blind L4 tunnel, client does TLS end-to-end through tunnel
```

### DNS in Kubernetes (CoreDNS)

Every Pod's `/etc/resolv.conf` points to CoreDNS (`10.96.0.10`). DNS queries travel the same veth/iptables/DNAT path as regular traffic. `ndots:5` means names with <5 dots try search domains first, causing 4 failed queries for external names like `google.com`. Mitigations: trailing-dot FQDNs, lower ndots, NodeLocal DNSCache.

### Cloud Provider CNI Evolution

**Gen 1 (Bridge + Overlay):** docker0/cni0 bridge, VXLAN encapsulation for cross-node, double NAT. Highest overhead.
**Gen 2 (PtP + BGP):** Calico -- no bridge, direct veth-to-host routes, BGP for cross-node. Still uses iptables for Services.
**Gen 3 (Cloud-Native):** AWS VPC CNI / Azure CNI -- Pods get real VPC/VNet IPs, cloud fabric routes natively. No overlay, no bridge.
**Gen 4 (eBPF):** Cilium / GKE Dataplane V2 -- eBPF programs replace iptables, kube-proxy, and conntrack entirely. O(1) Service lookups via eBPF hash maps. Observability via Hubble.

### eth0 Inside a Container

Container's `eth0` has its own private IP, does NOT share the host's IP, and is blind to the host's existence. Its routing table dictates all traffic: `default via 172.17.0.1 dev eth0`. eth0 does NOT do NAT -- SNAT happens at the host level in iptables, right before packets leave the physical NIC. The container is completely unaware its source IP gets rewritten.

### Gateway vs veth Explanations -- Same Thing

"Send to gateway 172.17.0.1" (routing view) and "packet goes through veth to docker0" (plumbing view) describe the same flow at different abstraction levels. `172.17.0.1` IS the `docker0` bridge interface. The container ARPs for the gateway, docker0 answers with its MAC, all traffic physically arrives at docker0 through the veth tunnel.

### When SNAT Happens and When It Doesn't

| Scenario | NAT? | Why |
|---|---|---|
| Container --> Container (same host) | No | Pure L2 switching on docker0 |
| Container --> Host | No | Host manages the container subnet |
| Container --> Internet | SNAT | Private IPs not routable on internet |

### Kubernetes Pod Networking Model

K8s mandates every Pod can reach every other Pod with its real IP, **without NAT**, across the entire cluster. Same-node: local bridge/PtP route. Cross-node: CNI handles (Flannel VXLAN encapsulation or Calico BGP routing) while preserving source IP. Internet-bound: SNAT at node level (ip-masq-agent controls which CIDRs are exempt).

### The Role of CNI

CNI is invoked **twice** per Pod: `ADD` at startup (creates veth, assigns IP, plugs into bridge or sets PtP route, programs cross-node routing) and `DEL` at teardown. After `ADD`, the CNI binary exits. The Linux kernel handles all runtime packet forwarding. CNI is the plumber; the kernel is the water system.

### Point-to-Point (PtP) Routing

Calico's PtP model: no bridge, each veth has a `/32` host route, `proxy_arp` answers ARP for link-local gateway. Benefits: no ARP flooding, no MAC learning, no broadcast storms, better security (no shared L2 domain). Trade-off: one route entry per Pod (500 Pods = 500 routes), CNI daemon must keep routes perfectly synchronized with Pod lifecycle. Cross-node: BGP advertises routes.

## Quick Reference

```
Container eth0 (172.17.0.2)
    | veth pair (kernel tunnel)
vethXXXX (host namespace)
    |
docker0 bridge (172.17.0.1) -- L2 switch + L3 gateway
    |
Host iptables: MASQUERADE -s 172.17.0.0/16 ! -o docker0
    |
eth0 (physical NIC, 10.128.0.5) --> Internet
```

**kube-proxy DNAT chain:**
```
PREROUTING --> KUBE-SERVICES
  match 10.96.45.12:80 --> KUBE-SVC-XXXX
    p=0.333 --> DNAT to Pod A (10.48.1.5:8080)
    p=0.500 --> DNAT to Pod B (10.48.2.8:8080)
    remainder --> DNAT to Pod C (10.48.3.11:8080)
  conntrack records mapping (subsequent packets skip iptables)
```

| Mode | Data Structure | Lookup | Use When |
|---|---|---|---|
| iptables | Linear chain | O(n) | < 1000 Services |
| IPVS | Hash table | O(1) | > 1000 Services |
| eBPF (Cilium) | Hash map | O(1) | Modern default (GKE Dataplane V2) |

**CNI evolution:** Bridge+Overlay --> PtP+BGP --> Cloud-Native IPs --> eBPF

## Key Takeaways

- Everything is built on three Linux primitives: network namespaces, veth pairs, and bridges (or PtP routes).
- kube-proxy is NOT a proxy -- it writes iptables rules and sleeps. The kernel does all packet forwarding.
- conntrack makes subsequent packets fast by skipping iptables, but table exhaustion causes silent connection drops.
- The pause container creates and holds the Pod's network namespace. If it dies, all containers in the Pod lose networking.
- Container eth0 is blind to the host -- it only knows its IP and gateway. NAT happens at the host iptables level, not in the container.
- "Gateway 172.17.0.1" and "docker0 bridge" are the same device, described at different abstraction levels.
- SNAT only happens for internet-bound traffic. Container-to-container and container-to-host traffic preserves original IPs.
- Modern CNIs (Calico PtP, Cilium eBPF) bypass bridges and iptables for better performance, security, and scalability.
- K8s mandates Pod-to-Pod communication with real IPs, without NAT, even across nodes.
- DNS queries go through the same veth/iptables/DNAT path as regular traffic. `ndots:5` causes extra queries for external names.
- EndpointSlices replaced legacy Endpoints to reduce API server load and enable topology-aware routing.
