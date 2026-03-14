---
title: "Container Networking Internals: Namespaces, veth Pairs, Bridges, kube-proxy, conntrack, and CNI"
---

## Overview

Container networking on Linux is built on three kernel primitives: **network namespaces** (isolation), **veth pairs** (plumbing between namespaces), and **bridges** (switching within a namespace). Everything else -- Docker networking, Kubernetes Services, kube-proxy, CNI plugins -- is layered on top of these primitives using standard Linux networking facilities (iptables, routing tables, ARP).

This note walks through container networking from first principles: how packets flow from a container process to the internet, how containers talk to each other, how Kubernetes Services translate virtual IPs to real Pod IPs, how conntrack accelerates return traffic, and how modern CNIs (Calico, Cilium, AWS VPC CNI) evolve beyond the bridge model.

For Docker bridge networking in the context of K8s proxies and DinD, see [[notes/Networking/docker-proxy-networking-in-k8s|Docker Proxy Networking in K8s]]. For SNAT/masquerade at the GKE node and Cloud NAT layer, see [[notes/Networking/gke-snat-ip-masquerade|GKE SNAT & IP Masquerading]]. For Istio's iptables-based traffic interception on top of this plumbing, see [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]].

---

## Linux Network Namespaces

A **network namespace** is a kernel construct that gives a process its own isolated copy of the entire network stack. Each namespace contains:

| Resource | Description |
|---|---|
| Network interfaces | Its own `eth0`, `lo`, etc. -- completely independent set |
| IP addresses | Each interface has its own IPs |
| Routing table | Its own `ip route` output |
| iptables/nftables rules | Its own firewall, NAT, mangle chains |
| Port space | Port 80 in namespace A is independent of port 80 in namespace B |
| ARP table | Its own neighbor cache |
| `/proc/net` | Each namespace sees only its own sockets, connections |

### Namespace vs Network (Subnet)

This is a common source of confusion. A namespace is **not** a network.

```
┌──────────────────────────────────────────────────────────────────┐
│  A network namespace is an isolation boundary within a single    │
│  OS kernel. It contains interfaces, routes, and firewall rules.  │
│                                                                  │
│  A network (subnet) is an IP address range (e.g., 10.0.1.0/24). │
│                                                                  │
│  One namespace can contain multiple interfaces on DIFFERENT       │
│  subnets. A router with three NICs on three subnets is still     │
│  in ONE namespace.                                               │
│                                                                  │
│  Multiple namespaces can have interfaces on the SAME subnet      │
│  (e.g., every Docker container gets 172.17.0.x, each in its     │
│  own namespace).                                                 │
│                                                                  │
│  Physical devices on different machines do NOT share namespaces.  │
│  Namespaces exist within a single Linux kernel instance.          │
└──────────────────────────────────────────────────────────────────┘
```

### The Root (Host) Namespace

When Linux boots, everything runs in the **root** (or **host**) network namespace. The physical NIC (`eth0`, `ens4`), the default route to the internet, and the host's iptables rules all live here. Every container gets its own namespace; the host retains the root namespace.

```
┌─ Host (Root Namespace) ──────────────────────────────────────┐
│                                                               │
│  eth0 (physical NIC)     10.128.0.5                          │
│  docker0 (bridge)        172.17.0.1                          │
│  veth1234                (connected to Container A's eth0)    │
│  veth5678                (connected to Container B's eth0)    │
│                                                               │
│  Routing table:                                               │
│    default via 10.128.0.1 dev eth0                           │
│    172.17.0.0/16 dev docker0                                 │
│                                                               │
│  iptables: NAT, FORWARD, masquerade rules                    │
│                                                               │
├─ Container A Namespace ──────┐ ┌─ Container B Namespace ─────┤
│  eth0  172.17.0.2            │ │  eth0  172.17.0.3           │
│  lo    127.0.0.1             │ │  lo    127.0.0.1            │
│                              │ │                              │
│  Route:                      │ │  Route:                      │
│    default via 172.17.0.1    │ │    default via 172.17.0.1    │
│                              │ │                              │
│  Own iptables (empty)        │ │  Own iptables (empty)        │
│  Own port space              │ │  Own port space              │
└──────────────────────────────┘ └──────────────────────────────┘
```

### Working with Namespaces

```bash
# Create a namespace
ip netns add my_ns

# List namespaces
ip netns list

# Run a command inside a namespace
ip netns exec my_ns ip addr show

# Show interfaces in the current namespace
ip link show

# Docker containers use namespaces but don't register them with `ip netns`.
# To inspect a container's namespace:
PID=$(docker inspect -f '{{.State.Pid}}' <container_id>)
nsenter -t $PID -n ip addr show
```

### The Kernel Rule: One Interface, One Namespace

A network interface can belong to **exactly one namespace** at a time. You cannot share `eth0` across two namespaces. You can move an interface between namespaces (`ip link set dev eth0 netns my_ns`), but the moment it enters the new namespace, it disappears from the old one.

This constraint is why veth pairs exist -- you need a dedicated mechanism to bridge the gap between namespaces.

### The Pause Container (Kubernetes)

In Kubernetes, each Pod gets its own network namespace. But who creates and holds this namespace? The **pause container** (`registry.k8s.io/pause:3.9`). It is a tiny process (~700KB image) whose only job is to call `pause()` (literally, a system call that sleeps forever). It:

1. Is the first container started in a Pod
2. Creates the network namespace (via `unshare(CLONE_NEWNET)`)
3. Holds the namespace alive as long as it runs
4. All other containers in the Pod join this namespace (`--net=container:pause`)

If the pause container dies, the namespace is destroyed, and all containers in the Pod lose networking. The kubelet restarts the entire Pod in this case.

```
┌─ Pod ────────────────────────────────────────────────┐
│                                                       │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐            │
│  │  pause   │  │  app     │  │  sidecar │            │
│  │ (creates │  │ (joins   │  │ (joins   │            │
│  │  netns)  │  │  netns)  │  │  netns)  │            │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
│       │              │              │                  │
│       └──────────────┴──────────────┘                  │
│              Shared network namespace                  │
│              eth0: 10.48.1.5                           │
│              All containers share IP, ports, lo        │
└───────────────────────────────────────────────────────┘
```

---

## veth Pairs

A **veth (virtual Ethernet) pair** is the only kernel construct that allows a packet to cross from one network namespace to another. It is a pair of two virtual network interfaces connected by an invisible "wire" inside the kernel. A packet written to one end instantaneously appears at the other end.

### Why veth Pairs Exist

The one-interface-one-namespace rule means you cannot plug a single interface into two namespaces. The kernel provides no other mechanism to send packets between namespaces. A veth pair solves this: one end lives in the container namespace, the other end lives in the host (root) namespace. They form a tunnel through the namespace boundary.

### How They Work

```
┌─ Container Namespace ─────┐          ┌─ Host (Root) Namespace ────┐
│                            │          │                             │
│  eth0 (172.17.0.2)        │          │  vethXXXXXX                 │
│    │                       │          │    │                        │
│    │   ┌───────────────────┼──────────┼────┘                        │
│    │   │ veth pair (kernel │internal  │                             │
│    │   │ "wire" -- packet  │pipe)     │  docker0 (bridge)           │
│    └───┘ in one end        │          │    │                        │
│          appears at other  │          │    │                        │
│                            │          │  eth0 (physical NIC)        │
└────────────────────────────┘          └─────────────────────────────┘
```

### Creation Flow

```bash
# 1. Create the pair (both ends start in the root namespace)
ip link add veth_host type veth peer name veth_container

# 2. Move one end into the container's namespace
ip link set veth_container netns <container_pid>

# 3. Rename the container end to "eth0" (convention)
ip netns exec <ns> ip link set veth_container name eth0

# 4. Assign an IP inside the container namespace
ip netns exec <ns> ip addr add 172.17.0.2/16 dev eth0

# 5. Bring both ends up
ip link set veth_host up
ip netns exec <ns> ip link set eth0 up

# 6. Set default route inside the container
ip netns exec <ns> ip route add default via 172.17.0.1
```

### Naming Conventions

| End | Name | Location |
|---|---|---|
| Container side | `eth0` | Inside the container's namespace |
| Host side | `vethXXXXXX` (random suffix, e.g., `veth7a3b9c1`) | In the root namespace, attached to the bridge |

The host-side name is auto-generated. You can find which veth belongs to which container:

```bash
# Inside the container
cat /sys/class/net/eth0/iflink
# Returns an interface index, e.g., 42

# On the host
ip link show | grep "^42:"
# Shows veth7a3b9c1@if41 -- this is the host end
```

---

## The docker0 Bridge

### Why a Bridge Is Needed

After creating a veth pair, you have two interfaces in the host namespace: the veth endpoint and the physical NIC. But these are **two disconnected cables dangling in the same room**. Traffic arriving on `vethXXXXXX` has nowhere to go -- the host kernel does not automatically forward it to `eth0` or to other veth endpoints.

You need something to connect them. There are two options:

1. **A bridge** -- acts as a virtual L2 switch, connecting multiple interfaces
2. **Routing rules** -- point-to-point routes between individual interfaces

Docker chose option 1: the `docker0` bridge.

### What docker0 Does

The `docker0` bridge serves two roles:

```
┌─────────────────────────────────────────────────────────────────┐
│                        docker0 bridge                            │
│                   (172.17.0.1/16 -- gateway)                     │
│                                                                  │
│   ROLE 1: L2 Switch (container-to-container)                     │
│   ─────────────────────────────────────────                      │
│   Containers on the same bridge can reach each other via         │
│   MAC addresses. docker0 learns MACs and forwards frames         │
│   between veth endpoints -- just like a physical switch.         │
│                                                                  │
│   ROLE 2: L3 Gateway (container-to-outside)                      │
│   ─────────────────────────────────────────                      │
│   docker0 has IP 172.17.0.1 -- the default gateway for all      │
│   containers. Traffic to non-local destinations goes through     │
│   this IP into the host's routing stack, then out to the         │
│   internet via NAT/masquerade.                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Bridge Topology

```
                      ┌──────────────────────────────────────┐
                      │        Host (Root Namespace)          │
                      │                                       │
                      │   eth0 ──── 10.128.0.5 (physical)    │
                      │     │                                 │
                      │     │  (IP forwarding + masquerade)   │
                      │     │                                 │
                      │   docker0 ── 172.17.0.1/16 (bridge)  │
                      │   ┌──┼──────────┼──────────┼──┐      │
                      │   │  │          │          │  │      │
                      │   │ veth1     veth2     veth3 │      │
                      │   └──┼──────────┼──────────┼──┘      │
                      │      │          │          │          │
                      └──────┼──────────┼──────────┼──────────┘
                             │          │          │
                    ┌────────┘    ┌─────┘    ┌─────┘
                    │             │           │
              ┌─────┴─────┐ ┌────┴─────┐ ┌───┴──────┐
              │ Container A│ │Container B│ │Container C│
              │ eth0       │ │ eth0      │ │ eth0      │
              │ 172.17.0.2 │ │ 172.17.0.3│ │ 172.17.0.4│
              └────────────┘ └───────────┘ └───────────┘
```

### IPAM (IP Address Management)

Docker assigns IPs from a default subnet:

| Setting | Default Value |
|---|---|
| Bridge subnet | `172.17.0.0/16` |
| Bridge gateway IP | `172.17.0.1` |
| First container IP | `172.17.0.2` |
| IPAM driver | Built-in (`local`) |

You can customize via `/etc/docker/daemon.json`:

```json
{
  "bip": "192.168.5.1/24",
  "fixed-cidr": "192.168.5.0/25"
}
```

### Bridge Commands

```bash
# Show bridge interfaces
brctl show docker0
# Or with ip:
ip link show type bridge
ip link show master docker0

# Show MAC address table (forwarding database)
brctl showmacs docker0
# Or:
bridge fdb show dev docker0
```

---

## Complete Packet Flow: Container to Internet

This is the full path a packet takes from an application inside a Docker container to a server on the internet.

### The Complete Path

```
┌─ Container Namespace ─────────────────────────────────────────────────┐
│                                                                        │
│  Application (curl google.com)                                         │
│       │                                                                │
│       │  Socket: connect() to 142.250.80.46:443                       │
│       │  Kernel allocates ephemeral source port (e.g., 44312)          │
│       ▼                                                                │
│  Container routing table:                                              │
│    "default via 172.17.0.1 dev eth0"                                  │
│       │                                                                │
│       │  Packet: src=172.17.0.2:44312  dst=142.250.80.46:443          │
│       ▼                                                                │
│  eth0 (172.17.0.2) ── this is the container end of the veth pair      │
│       │                                                                │
└───────┼────────────────────────────────────────────────────────────────┘
        │
        │  ===== veth pair tunnel (crosses namespace boundary) =====
        │
┌───────┼────────────────────────────────────────────────────────────────┐
│       ▼                                              Host Namespace    │
│  vethXXXXXX (host end of veth pair, plugged into docker0)             │
│       │                                                                │
│       ▼                                                                │
│  docker0 bridge (172.17.0.1)                                          │
│       │                                                                │
│       │  Bridge sees dst MAC is not any attached container             │
│       │  → forwards to bridge IP stack (L3 routing kicks in)          │
│       ▼                                                                │
│  Host routing table:                                                   │
│    "default via 10.128.0.1 dev eth0"                                  │
│       │                                                                │
│       ▼                                                                │
│  iptables POSTROUTING chain (nat table):                              │
│    -A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE        │
│       │                                                                │
│       │  MASQUERADE (SNAT): rewrites src IP                           │
│       │    BEFORE: src=172.17.0.2:44312  dst=142.250.80.46:443        │
│       │    AFTER:  src=10.128.0.5:55781  dst=142.250.80.46:443        │
│       │                                                                │
│       │  conntrack entry created:                                      │
│       │    172.17.0.2:44312 ↔ 10.128.0.5:55781 → 142.250.80.46:443  │
│       ▼                                                                │
│  eth0 (physical NIC, 10.128.0.5)                                      │
│       │                                                                │
└───────┼────────────────────────────────────────────────────────────────┘
        │
        ▼
   ┌─────────────────┐
   │  Physical network │ → Default gateway → Internet → google.com
   └─────────────────┘
```

### Return Path (Response)

```
Google (142.250.80.46) sends response:
  src=142.250.80.46:443  dst=10.128.0.5:55781

Host receives on eth0 →
  conntrack lookup: 10.128.0.5:55781 maps to 172.17.0.2:44312
  Un-SNAT: rewrite dst to 172.17.0.2:44312

Host routing:
  172.17.0.2 is on 172.17.0.0/16 → dev docker0

docker0 bridge:
  ARP lookup → 172.17.0.2 is on vethXXXXXX port
  Forward frame to vethXXXXXX

veth pair tunnel →
  Packet arrives at container's eth0

Container kernel:
  Delivers to socket bound to port 44312
  Application reads the HTTP response
```

### The iptables Masquerade Rule

Docker automatically inserts this rule when the daemon starts:

```bash
# View it
iptables -t nat -L POSTROUTING -n -v

# The rule:
-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE
```

This rule says: "For any packet coming from the Docker subnet (`172.17.0.0/16`) that is leaving via an interface that is NOT `docker0` (i.e., heading to the outside world), rewrite the source IP to the outgoing interface's IP." The `! -o docker0` exception ensures that container-to-container traffic on the same bridge is not masqueraded.

---

## Container-to-Container Communication

### Same Host, Same Bridge (L2 Switching)

When two containers on the same `docker0` bridge communicate, the traffic never leaves the bridge. It is pure L2 switching -- no routing, no NAT, no iptables.

```
Container A (172.17.0.2)                    Container B (172.17.0.3)
       │                                            ▲
       │  Packet: src=172.17.0.2 dst=172.17.0.3    │
       ▼                                            │
   eth0 (veth pair)                            eth0 (veth pair)
       │                                            ▲
       ▼                                            │
   veth1 ─── docker0 bridge (L2 switch) ─── veth2
              │
              │  1. ARP: "Who has 172.17.0.3?"
              │  2. docker0 floods ARP to all ports
              │  3. Container B responds with its MAC
              │  4. docker0 learns MAC→port mapping
              │  5. Subsequent frames forwarded directly
```

The flow:

1. Container A wants to send to `172.17.0.3`. Its routing table says `172.17.0.0/16 dev eth0` -- destination is on the local link.
2. Container A issues an ARP request: "Who has `172.17.0.3`?"
3. The ARP request travels through the veth pair to `docker0`.
4. `docker0` floods the ARP to all attached ports (standard L2 switch behavior).
5. Container B receives the ARP, responds with its MAC address.
6. Container A sends the IP packet in an Ethernet frame addressed to Container B's MAC.
7. `docker0` switches the frame to the correct port (veth2).
8. The packet arrives at Container B's `eth0` via the veth pair.

No IP routing is involved. No iptables rules are consulted (unless there are explicit FORWARD rules). The bridge is operating purely at Layer 2.

### Cross-Host Communication

Containers on different hosts cannot communicate via `docker0` alone. Each host has its own `docker0` with its own `172.17.0.0/16` subnet. A packet from `172.17.0.2` on Host A addressed to `172.17.0.2` on Host B would be ambiguous -- both hosts might have a container at that address.

This is the core problem that **CNI plugins** solve. Solutions include:

| Approach | How It Works |
|---|---|
| **Overlay networks** (Flannel VXLAN, Weave) | Encapsulate container packets inside UDP packets between hosts. The outer packet uses host IPs; the inner packet uses container IPs. |
| **BGP routing** (Calico) | Advertise container subnets via BGP so host routing tables know to forward `10.48.1.0/24` to Host B's IP. No encapsulation overhead. |
| **Cloud-native** (AWS VPC CNI) | Assign real VPC IPs to containers. The cloud network fabric routes them natively. |

---

## Why Not Skip the Bridge?

A common question: if each container has a veth pair ending in the host namespace, why not just add routing rules directly?

### The "Dangling Cable" Problem

Without a bridge, each `vethXXXXXX` in the host namespace is like a cable plugged into nothing. The host kernel has these interfaces but they are not connected to anything. Packets arriving on `vethXXXXXX` enter the host's IP stack, but:

1. **No gateway for containers**: The container's default route points to `172.17.0.1`. If nothing has that IP, packets from the container are simply dropped. The bridge provides that IP.

2. **No L2 path between containers**: Two veth endpoints in the same namespace cannot exchange L2 frames without either a bridge (to switch between them) or explicit routing rules (to route between them at L3).

3. **No ARP resolution**: Container A wanting to talk to Container B at `172.17.0.3` needs to ARP for it. Without a bridge connecting the veth endpoints, the ARP request goes nowhere.

### But Modern CNIs DO Skip the Bridge

The bridge model has overhead: ARP tables, MAC learning, broadcast domains. Modern CNIs like **Calico** bypass the bridge entirely using **point-to-point (PtP) routing**:

```
┌─ Calico PtP Model ──────────────────────────────────────────┐
│                                                               │
│  Host Namespace                                               │
│                                                               │
│  Routing table:                                               │
│    10.48.1.2 dev caliXXXX scope link    ◄── PtP route        │
│    10.48.1.3 dev caliYYYY scope link    ◄── PtP route        │
│                                                               │
│  caliXXXX ──────────── Container A (10.48.1.2)               │
│  caliYYYY ──────────── Container B (10.48.1.3)               │
│                                                               │
│  No bridge. No ARP between containers.                        │
│  Container-to-container goes: A → caliXXXX → host routing     │
│  → caliYYYY → B (pure L3 forwarding)                         │
│                                                               │
│  Container's default gateway: 169.254.1.1 (link-local)       │
│  Host has proxy_arp enabled on cali* interfaces               │
└───────────────────────────────────────────────────────────────┘
```

How Calico PtP works:

- Each container gets a `/32` address and a default route to `169.254.1.1` (a link-local address).
- The host enables `proxy_arp` on each `cali*` interface, so it answers ARP requests for `169.254.1.1` with its own MAC.
- The host has explicit routes: `10.48.1.2 dev caliXXXX` -- telling the kernel that this specific IP is reachable via this specific veth.
- Container-to-container traffic is routed at L3 through the host's routing table. No bridge, no ARP flooding, no MAC learning.
- For cross-host traffic, Calico uses BGP to distribute routes between nodes.

---

## Alternative Network Modes

### Macvlan

Macvlan gives a container its own MAC address on the physical network. The container appears as a separate device to the physical switch.

```
Physical Network (Switch / Router)
    │           │           │
    │           │           │
  Host NIC    mac0        mac1
  (parent)  (Container A) (Container B)
             192.168.1.50  192.168.1.51
```

- Containers get real IPs from the physical network's DHCP or static pool.
- No bridge, no NAT, no masquerade.
- Direct L2 connectivity to the physical network.
- Limitation: host-to-container communication is blocked (the kernel does not hairpin between a macvlan child and its parent interface). A workaround is to create a macvlan on the host too.

### `--network host`

```bash
docker run --network host nginx
```

The container shares the host's network namespace entirely. There is no isolation: the container sees the host's `eth0`, uses the host's IP, and binds to the host's port space.

- **Port conflicts**: If the host has nginx on port 80 and you start a container that also binds port 80, the container gets `EADDRINUSE`. There is no separate port space.
- **Performance**: Zero overhead -- no veth pair, no bridge, no NAT. Useful for network-intensive workloads.
- **Security**: The container can sniff all host traffic, modify iptables, bind to any port.

### Kubernetes `hostNetwork: true`

Same concept in K8s. The Pod uses the node's network namespace. The Pod's IP is the node's IP. Port conflicts are real. Used for components like kube-proxy, CNI agents, and ingress controllers that need direct access to node networking.

---

## kube-proxy and DNAT

### The Problem

Kubernetes Services have a virtual IP (ClusterIP, e.g., `10.96.0.10`) that does not correspond to any real network interface. No device has this IP. Yet, when a Pod sends a packet to `10.96.0.10:80`, it reaches one of the Service's backend Pods. How?

### kube-proxy's Role

**kube-proxy** runs on every node and watches the Kubernetes API for Service and EndpointSlice objects. When it sees a Service, it programs the node's iptables (or IPVS) rules to intercept packets destined for the Service's ClusterIP and rewrite the destination to a real Pod IP. This is **DNAT (Destination NAT)**.

```
┌─ What kube-proxy does ──────────────────────────────────────────┐
│                                                                  │
│  Watches API server:                                             │
│    Service "my-svc" → ClusterIP 10.96.45.12, port 80           │
│    EndpointSlice → Pod IPs: 10.48.1.5, 10.48.2.8, 10.48.3.11  │
│                                                                  │
│  Writes iptables rules on the NODE (root namespace):            │
│    "If dst=10.96.45.12:80, DNAT to one of the Pod IPs"         │
│                                                                  │
│  kube-proxy does NOT proxy traffic itself.                       │
│  It is a control-plane agent that programs the kernel.           │
│  Actual packet forwarding is done by the kernel.                 │
└──────────────────────────────────────────────────────────────────┘
```

### iptables DNAT Chains

kube-proxy creates a chain hierarchy in the `nat` table:

```
iptables -t nat chains:

PREROUTING → KUBE-SERVICES
                │
                ├─ match dst=10.96.45.12/32 dport=80 → KUBE-SVC-XXXX
                │       │
                │       ├─ statistic probability 0.333 → KUBE-SEP-AAA
                │       │       └─ DNAT to 10.48.1.5:8080
                │       │
                │       ├─ statistic probability 0.500 → KUBE-SEP-BBB
                │       │       └─ DNAT to 10.48.2.8:8080
                │       │
                │       └─ (remainder) → KUBE-SEP-CCC
                │               └─ DNAT to 10.48.3.11:8080
                │
                ├─ match dst=10.96.0.10/32 dport=53 → KUBE-SVC-DNS
                │       └─ ...
                ...

OUTPUT → KUBE-SERVICES  (for locally generated traffic, same chain)
```

Key details:

- **KUBE-SERVICES**: Matches on each Service's ClusterIP + port. Jumps to the per-Service chain.
- **KUBE-SVC-XXXX**: Per-Service chain. Uses `iptables --probability` for random load balancing across endpoints.
- **KUBE-SEP-XXX**: Per-endpoint (Service Endpoint) chain. Contains the actual `-j DNAT --to-destination <pod_ip>:<pod_port>` rule.
- The probabilities are calculated so each endpoint has equal weight: for 3 endpoints, the first rule matches with p=0.333, the second with p=0.500 of remaining (= 0.333 total), and the third gets the rest (= 0.334 total).

### DNAT in Action

```
Pod A (10.48.1.2) sends packet to Service (10.96.45.12:80):

  Original packet:  src=10.48.1.2:39421  dst=10.96.45.12:80

  Packet exits Pod A's namespace via veth pair → arrives in host namespace

  PREROUTING chain (for external traffic) or OUTPUT chain (for local traffic):
    → KUBE-SERVICES
      → matches 10.96.45.12:80
        → KUBE-SVC-XXXX
          → random selection: KUBE-SEP-BBB
            → DNAT: rewrite dst to 10.48.2.8:8080

  After DNAT:  src=10.48.1.2:39421  dst=10.48.2.8:8080

  Host routing: 10.48.2.8 is on this node (or reachable via CNI)
  Forward packet to the target Pod
```

> **Note:** These iptables rules are "real" iptables rules in the node's root namespace. There is nothing "virtual" about them. They are written to the kernel's netfilter tables using the same `iptables` binary you would use manually. kube-proxy merely automates their creation and maintenance.

### iptables vs IPVS Mode

kube-proxy supports two backends:

| Aspect | iptables mode | IPVS mode |
|---|---|---|
| Data structure | Linear chain of rules | Hash table |
| Lookup complexity | O(n) per Service endpoint | O(1) |
| Performance at scale | Degrades with thousands of Services | Constant |
| Load balancing | Random (probability-based) | Round-robin, least-conn, weighted, etc. |
| When to use | Small-to-medium clusters | Large clusters (>1000 Services) |

In IPVS mode, kube-proxy programs the kernel's IPVS (IP Virtual Server) subsystem instead of iptables NAT chains. IPVS is purpose-built for load balancing and uses hash tables, making lookups O(1) regardless of the number of Services.

```bash
# Check which mode kube-proxy is using
kubectl get configmap kube-proxy -n kube-system -o yaml | grep mode

# View IPVS rules
ipvsadm -Ln
```

---

## conntrack (Connection Tracking)

### The Fast Path

Only the **first packet** of a TCP connection (the SYN) goes through the full iptables NAT chain traversal. The kernel's conntrack (connection tracking) module records the NAT translation in a table. All subsequent packets of the same connection (SYN-ACK, ACK, data, FIN) use conntrack for fast-path rewriting, bypassing the iptables rule walk entirely.

```
┌─ First Packet (SYN) ───────────────────────────────────────────┐
│                                                                  │
│  Packet arrives → PREROUTING → KUBE-SERVICES → KUBE-SVC-XXX    │
│  → KUBE-SEP-YYY → DNAT to 10.48.2.8:8080                       │
│                                                                  │
│  conntrack table entry created:                                  │
│    NEW  tcp  src=10.48.1.2:39421 dst=10.96.45.12:80            │
│              → rewrite dst to 10.48.2.8:8080                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌─ Subsequent Packets (data, ACK, etc.) ─────────────────────────┐
│                                                                  │
│  Packet arrives → conntrack lookup → ESTABLISHED entry found    │
│  → apply same DNAT (dst → 10.48.2.8:8080)                      │
│  → skip iptables NAT chains entirely                            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌─ Return Traffic ───────────────────────────────────────────────┐
│                                                                  │
│  Response from 10.48.2.8:8080 → 10.48.1.2:39421               │
│  conntrack: this is the reply direction of a known connection   │
│  → un-DNAT: rewrite src from 10.48.2.8:8080 to 10.96.45.12:80 │
│                                                                  │
│  Pod A sees response from 10.96.45.12:80 — as expected.         │
│  Pod A never knew the real backend was 10.48.2.8.               │
└──────────────────────────────────────────────────────────────────┘
```

### conntrack Table

```bash
# View conntrack entries
conntrack -L

# Example entry:
tcp  6 117 TIME_WAIT src=10.48.1.2 dst=10.96.45.12 sport=39421 dport=80
                     src=10.48.2.8 dst=10.48.1.2 sport=8080 dport=39421
# ^^^^ original direction ^^^^   ^^^^ reply direction ^^^^

# Count entries
conntrack -C

# Max table size
cat /proc/sys/net/netfilter/nf_conntrack_max
# Default: 131072 (128K) on most systems
```

### conntrack Table Exhaustion

In large Kubernetes clusters with high connection rates, the conntrack table can fill up. When full, **new connections are silently dropped**. This is a notorious failure mode:

- Symptoms: intermittent connection timeouts, packets dropped with no error from the application's perspective
- Diagnosis: `dmesg | grep conntrack` shows `nf_conntrack: table full, dropping packet`
- Fix: increase `nf_conntrack_max` via sysctl

```bash
# Check current usage vs max
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# Increase (must do on each node)
sysctl -w net.netfilter.nf_conntrack_max=524288
```

### conntrack Race Condition (UDP/DNAT)

A well-known bug: with UDP and DNAT (e.g., DNS via kube-proxy), two threads sending DNS queries simultaneously can cause a conntrack insertion race. Both packets get DNAT'd to the same backend, the kernel tries to create two conntrack entries with the same tuple, one fails, and the packet is dropped. This is why K8s DNS resolution sometimes experiences 5-second delays (the client retries after its default timeout).

Mitigations:
- Use `single-request-reopen` or `single-request` in `/etc/resolv.conf` (serializes A and AAAA queries)
- Use NodeLocal DNSCache (runs a DNS cache on each node, reducing queries to CoreDNS)
- Switch to Cilium/eBPF which does not use conntrack for DNS

---

## EndpointSlices

### The Problem with Legacy Endpoints

In Kubernetes before v1.21, every Service had a single `Endpoints` object containing all backend Pod IPs. For a Service with 5000 Pods, this was one massive object. Any time a single Pod was added or removed, the entire object was rewritten and pushed to every node's kube-proxy.

```
┌─ Legacy Endpoints (one object per Service) ─────────────────┐
│                                                               │
│  Service: my-svc                                              │
│  Endpoints:                                                   │
│    - 10.48.1.5:8080                                          │
│    - 10.48.1.6:8080                                          │
│    - 10.48.2.8:8080                                          │
│    ... (5000 entries)                                         │
│    - 10.48.99.15:8080                                        │
│                                                               │
│  Single Pod dies → ENTIRE object rewritten → pushed to       │
│  EVERY node → kube-proxy recalculates ALL iptables rules     │
│                                                               │
│  At scale: massive API server load, kube-proxy churn,         │
│  etcd write amplification                                    │
└───────────────────────────────────────────────────────────────┘
```

### How EndpointSlices Fix It

EndpointSlices shard the endpoint list into chunks of **100 endpoints** each (configurable). When a Pod changes, only the affected slice is updated.

```
┌─ EndpointSlices (sharded) ──────────────────────────────────┐
│                                                               │
│  Service: my-svc (5000 Pods)                                 │
│                                                               │
│  EndpointSlice my-svc-abc:  [Pod 1-100]                     │
│  EndpointSlice my-svc-def:  [Pod 101-200]                   │
│  EndpointSlice my-svc-ghi:  [Pod 201-300]                   │
│  ...                                                          │
│  EndpointSlice my-svc-xyz:  [Pod 4901-5000]                 │
│                                                               │
│  Single Pod dies → only ONE slice updated → only nodes       │
│  watching that slice get notified → minimal churn             │
│                                                               │
│  Each slice also carries topology metadata:                   │
│    - node name                                                │
│    - zone                                                     │
│    - ready/serving/terminating conditions                     │
│                                                               │
│  This enables zone-aware routing (prefer endpoints in the    │
│  same availability zone to reduce cross-zone traffic costs)   │
└───────────────────────────────────────────────────────────────┘
```

Key improvements:
- **Efficient partial updates**: Only the 100-endpoint slice containing the changed Pod is rewritten
- **Reduced API server load**: Watch events are scoped to individual slices
- **Topology metadata**: Each endpoint carries node/zone information, enabling topology-aware routing
- **Dual-stack support**: EndpointSlices natively support IPv4 and IPv6 (legacy Endpoints did not)

---

## DNAT vs Forward Proxy vs Reverse Proxy vs HTTPS CONNECT

These four mechanisms all redirect or relay traffic, but they operate at different layers and with fundamentally different architectures.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DNAT (L3/L4)                                 │
│                                                                      │
│  Client ══════════════════════════════════════════> Backend          │
│          ↑                                                           │
│          One TCP connection. Kernel rewrites dst IP in packet        │
│          headers. Client and backend are unaware.                    │
│          Transparent. Kernel-space. No content inspection.           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    Forward Proxy (L7)                                 │
│                                                                      │
│  Client ──── TCP 1 ────> Proxy ──── TCP 2 ────> Server              │
│                            │                                         │
│          Two separate TCP connections. Client explicitly sends       │
│          request to proxy (configured via HTTP_PROXY). Proxy         │
│          reads HTTP, makes new connection to server. Content-aware.  │
│          User-space process. Can cache, filter, authenticate.        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    Reverse Proxy (L7)                                 │
│                                                                      │
│  Client ──── TCP 1 ────> Proxy ──── TCP 2 ────> Backend             │
│                            │                                         │
│          Two TCP connections. Client thinks proxy IS the server.     │
│          Proxy terminates TLS, reads HTTP, re-initiates request     │
│          to backend. Can do SSL offloading, path-based routing,     │
│          caching, compression, header manipulation.                  │
│          Client is unaware of backends.                              │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                 HTTPS CONNECT Tunnel (L7→L4)                         │
│                                                                      │
│  Client ─── HTTP CONNECT ──> Proxy ─── TCP ──> Server               │
│                                 │                                    │
│          Starts as L7: client sends "CONNECT server:443 HTTP/1.1"   │
│          Proxy opens TCP to server, responds "200 OK"               │
│          Then becomes L4: proxy blindly shovels bytes between        │
│          client and server sockets. No content inspection.           │
│          Client does TLS directly with server through the tunnel.    │
│          Explicit client participation (client knows about proxy).   │
└─────────────────────────────────────────────────────────────────────┘
```

### Comparison Table

| Aspect | DNAT | Forward Proxy | Reverse Proxy | HTTPS CONNECT |
|---|---|---|---|---|
| **OSI Layer** | L3/L4 | L7 | L7 | L7 handshake, then L4 tunnel |
| **Connections** | 1 (rewritten) | 2 (client→proxy, proxy→server) | 2 (client→proxy, proxy→backend) | 2 TCP sockets, blind relay after handshake |
| **Client awareness** | Transparent (client unaware) | Explicit (client configured) | Transparent (client thinks proxy is server) | Explicit (client sends CONNECT) |
| **Content inspection** | None (blind packet rewriting) | Full (reads HTTP) | Full (terminates TLS, reads HTTP) | None after tunnel established |
| **Where it runs** | Kernel (netfilter/iptables) | User-space process | User-space process | User-space process |
| **TLS termination** | No | Optional (MITM) | Yes (by design) | No (client does TLS end-to-end) |
| **Use case** | kube-proxy Services, port forwarding | Corporate proxy, caching | Nginx/Envoy in front of backends | HTTPS through HTTP proxy |
| **Load balancing** | Limited (random, round-robin) | Possible | Rich (weighted, least-conn, etc.) | Not applicable |

---

## DNS in Kubernetes (CoreDNS)

### How Pods Discover Service IPs

When a Pod wants to connect to `my-svc`, it needs the ClusterIP. Kubernetes configures every Pod's `/etc/resolv.conf` to use CoreDNS:

```bash
# Inside a Pod:
cat /etc/resolv.conf

nameserver 10.96.0.10        # CoreDNS ClusterIP
search default.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

### DNS Query Flow

The DNS query itself travels through the exact same veth/bridge plumbing as any other packet:

```
Pod (10.48.1.2) needs to resolve "my-svc"

1. Application calls getaddrinfo("my-svc")
2. glibc/musl reads /etc/resolv.conf → nameserver 10.96.0.10
3. Sends UDP packet: src=10.48.1.2:54321 dst=10.96.0.10:53
   Query: my-svc.default.svc.cluster.local (A record)
   (ndots:5 means "my-svc" has 0 dots < 5, so search domains are tried first)

4. Packet exits via veth pair → host namespace
5. iptables DNAT: 10.96.0.10:53 → CoreDNS Pod IP (e.g., 10.48.0.3:53)
   (kube-proxy rules for the kube-dns Service)
6. Packet routed to CoreDNS Pod

7. CoreDNS looks up Service in its cache (watches K8s API)
   → "my-svc" in namespace "default" → ClusterIP 10.96.45.12

8. Response: my-svc.default.svc.cluster.local → 10.96.45.12
9. Response travels back via conntrack (un-DNAT)
10. Pod receives DNS response, connects to 10.96.45.12

Note: The DNS query to CoreDNS goes through the SAME network
path (veth → bridge/route → iptables DNAT → Pod) as regular
traffic. DNS is not a special path — it's just another Service.
```

### Search Domains and ndots

The `ndots:5` option means: if the queried name has fewer than 5 dots, try appending each search domain before querying the bare name. For `my-svc` (0 dots):

```
1. my-svc.default.svc.cluster.local  → found! (returns ClusterIP)
   (stops here)

For "my-svc.other-ns" (1 dot, still < 5):
1. my-svc.other-ns.default.svc.cluster.local  → NXDOMAIN
2. my-svc.other-ns.svc.cluster.local          → found!

For "google.com" (1 dot, still < 5):
1. google.com.default.svc.cluster.local  → NXDOMAIN
2. google.com.svc.cluster.local          → NXDOMAIN
3. google.com.cluster.local              → NXDOMAIN
4. google.com                            → found! (resolved via upstream)

This means every external DNS query generates 4 failed queries first!
This is a known performance issue. Mitigations:
  - Use FQDNs with trailing dot: "google.com." (bypasses search domains)
  - Lower ndots to 2 in Pod spec (dnsConfig.options)
  - Use NodeLocal DNSCache to cache responses locally
```

---

## Cloud Provider CNI Differences

The evolution of container networking follows a clear trajectory: from bridges to point-to-point routing to eBPF.

### The Evolution

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Generation 1: Bridge + Overlay                                      │
│  (Docker default, Flannel VXLAN)                                     │
│    - docker0/cni0 bridge per node                                    │
│    - Overlay encapsulation for cross-node                            │
│    - Double NAT (container → node → internet)                        │
│    - Highest overhead                                                │
│                                                                      │
│  Generation 2: PtP Routing + BGP                                     │
│  (Calico, kube-router)                                               │
│    - No bridge, direct veth-to-host routes                           │
│    - BGP distributes routes between nodes                            │
│    - No encapsulation overhead (or optional VXLAN/IPIP fallback)     │
│    - Still uses iptables for Services                                │
│                                                                      │
│  Generation 3: Cloud-Native CNI                                      │
│  (AWS VPC CNI, Azure CNI)                                            │
│    - Containers get real VPC/VNet IPs                                │
│    - Cloud network fabric routes natively                            │
│    - No overlay, no bridge, no NAT for pod-to-pod                   │
│    - Still uses iptables/IPVS for Services                          │
│                                                                      │
│  Generation 4: eBPF                                                  │
│  (Cilium, GKE Dataplane V2)                                         │
│    - eBPF programs attached to network interfaces                    │
│    - Replaces iptables, kube-proxy, and conntrack entirely           │
│    - O(1) Service lookup via eBPF hash maps                         │
│    - Kernel-space, but programmable                                  │
│    - Observability built in (Hubble)                                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### AWS VPC CNI

- Each node gets multiple **Elastic Network Interfaces (ENIs)**, each with multiple secondary private IPs.
- Each Pod is assigned a real VPC IP from the ENI's secondary IPs.
- The VPC routing fabric delivers packets directly -- no overlay, no encapsulation.
- Limitation: the number of Pods per node is bounded by the instance type's ENI and IP limits (e.g., `m5.large` = 3 ENIs x 10 IPs = 29 Pod IPs max, minus one per ENI for the primary IP).

### Azure CNI

- Similar to AWS: Pods get IPs from the VNet subnet.
- Azure pre-allocates IPs from the subnet to each node.
- Limitation: large clusters can exhaust subnet IP space quickly. Azure CNI Overlay mode addresses this by using overlay networking for Pod IPs.

### GKE Dataplane V2 / Cilium

- GKE's default dataplane since 2023.
- Uses **Cilium** with **eBPF** programs attached to `tc` (traffic control) hooks on each interface.
- eBPF programs handle Service DNAT, network policy enforcement, and load balancing entirely in kernel-space.
- **Bypasses iptables entirely** -- no kube-proxy, no iptables NAT chains, no conntrack for Service traffic.
- eBPF maps (hash tables) store Service→Endpoint mappings for O(1) lookups.
- Comes with **Hubble** for network observability (flow logs, service maps, DNS visibility).

```
┌─ GKE Dataplane V2 / Cilium eBPF ─────────────────────────────┐
│                                                                │
│  Packet arrives at Pod's veth:                                 │
│    │                                                           │
│    ▼                                                           │
│  eBPF program (tc ingress hook):                               │
│    1. Look up dst IP in eBPF map                               │
│    2. If it's a Service VIP → select backend (hash-based)      │
│    3. Rewrite dst IP/port directly in the packet               │
│    4. Forward to correct interface                              │
│                                                                │
│  No iptables traversal. No conntrack entry for the DNAT.       │
│  No kube-proxy. All in kernel-space, O(1).                     │
│                                                                │
│  For network policies:                                          │
│    eBPF program checks policy maps → allow/deny at line rate   │
└────────────────────────────────────────────────────────────────┘
```

---

## Network Interface vs Network Namespace: A Clarification

A final important distinction that trips people up:

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                    │
│  INTERFACE =/= NAMESPACE                                           │
│                                                                    │
│  A network interface (NIC) is a point of attachment to a network.  │
│  A namespace is an isolation boundary for the network stack.       │
│                                                                    │
│  Example: A Linux router with 3 NICs:                              │
│    - eth0: 10.0.1.1/24  (subnet A)                                │
│    - eth1: 10.0.2.1/24  (subnet B)                                │
│    - eth2: 192.168.0.1/24 (subnet C)                              │
│                                                                    │
│  This router has 3 interfaces, 3 subnets, but ONE namespace.      │
│  All three interfaces share the same routing table, the same       │
│  iptables rules, the same port space.                              │
│                                                                    │
│  Contrast with containers:                                         │
│    - Container A: eth0 in namespace_A (172.17.0.2)                │
│    - Container B: eth0 in namespace_B (172.17.0.3)                │
│                                                                    │
│  Same subnet (172.17.0.0/16), different namespaces.               │
│  Each has its own routing table, iptables, port space.             │
│                                                                    │
│  Key: namespaces are per-kernel. Two containers on different       │
│  machines are in different kernels — they don't "share" a          │
│  namespace across the network. Namespace isolation is local.       │
└───────────────────────────────────────────────────────────────────┘
```

---

## eth0 Inside a Container -- IP Assignment and Routing

The `eth0` interface inside a container has its **own private IP** (e.g., `172.17.0.2`). It does NOT share the host's IP. It does NOT know about the host. From the container's perspective, `eth0` is its only connection to the outside world, and the routing table dictates where traffic goes.

### Container's Routing Table

```bash
# Inside the container:
$ ip route
default via 172.17.0.1 dev eth0
172.17.0.0/16 dev eth0 scope link
```

The default route says: "for any destination not on `172.17.0.0/16`, send the packet to gateway `172.17.0.1` via `eth0`." The container's kernel obeys this blindly -- it has no knowledge of veth pairs, bridges, or host routing tables.

### eth0 Is Blind to the Host

The container's `eth0` is one end of a veth pair. It has no awareness that the other end is plugged into a bridge in the host namespace. As far as the container kernel is concerned, `eth0` is a regular Ethernet interface. The veth pair acts as an **invisible kernel tunnel**: any packet shoved into the container's `eth0` automatically pops out at the host-side `vethXXXXXX`. This is not a configurable behavior -- it is the fundamental property of veth pairs.

```
┌─ Container Namespace ──────────────────────────────────┐
│                                                          │
│  eth0 (172.17.0.2)                                      │
│    │                                                     │
│    │  "I only know my IP (172.17.0.2) and my gateway     │
│    │   (172.17.0.1). I don't know about any host,        │
│    │   bridge, physical NIC, or NAT. I'm blind."         │
│    │                                                     │
│    │  Routing table:                                     │
│    │    0.0.0.0/0 via 172.17.0.1 dev eth0               │
│    │                                                     │
│    ▼                                                     │
│  ┌──── veth pair ─────────────── NAMESPACE BOUNDARY ──── │
│  │  (invisible kernel tunnel)                            │
└──┼───────────────────────────────────────────────────────┘
   │
   ▼
┌──┼───────────────────────────────────────────────────────┐
│  │                                  Host Namespace        │
│  vethXXXXXX ──── docker0 (172.17.0.1) ──── eth0 (host)  │
│                                                           │
│  "I see everything: the container's packet, the bridge,   │
│   the physical NIC, the iptables rules, the NAT."         │
└───────────────────────────────────────────────────────────┘
```

### eth0 Does NOT Do NAT

A common misconception is that the container's `eth0` somehow translates addresses. It does not. The container's `eth0` simply transmits packets with its own private source IP (`172.17.0.2`). NAT (specifically SNAT/masquerade) happens at the **host level**, in the host's iptables `nat` table, right before the packet leaves the physical NIC. The container is completely unaware that its source IP gets rewritten.

---

## Reconciling the "Gateway" vs "veth" Explanations

When learning container networking, you will encounter two seemingly different explanations of how traffic leaves a container:

1. **"The container sends to its gateway `172.17.0.1`"** -- routing table perspective
2. **"The packet goes through the veth pair to docker0"** -- physical plumbing perspective

Both are correct simultaneously. They describe the same packet flow at different layers of abstraction.

### The Key Insight

`172.17.0.1` **IS** the `docker0` bridge interface. The gateway IP in the container's routing table is literally the IP address assigned to `docker0` in the host namespace. When the container "sends to the gateway," the packet physically travels through the veth tunnel to arrive at `docker0`, which owns that IP.

### Combined Diagram: Both Layers Mapped Together

```
┌─────────────────────────────────────────────────────────────────────────┐
│  LOGICAL VIEW (IP Layer)           PHYSICAL VIEW (Plumbing Layer)       │
│  ─────────────────────────         ──────────────────────────────       │
│                                                                          │
│  Container 172.17.0.2              Container namespace                   │
│       │                                 │                                │
│       │ "send to gateway               eth0 (container end of veth)     │
│       │  172.17.0.1"                    │                                │
│       │                                 │ ← veth kernel tunnel           │
│       ▼                                 ▼                                │
│  Gateway 172.17.0.1         ====  docker0 bridge (has IP 172.17.0.1)    │
│       │                                 │                                │
│       │ "route to internet             Host routing table consulted      │
│       │  via default gw"                │                                │
│       ▼                                 ▼                                │
│  Host default gateway         iptables POSTROUTING (SNAT here)          │
│       │                                 │                                │
│       ▼                                 ▼                                │
│  Internet                     Physical NIC (eth0/ens4)                   │
│                                         │                                │
│                                         ▼                                │
│                                    Physical network                      │
│                                                                          │
│  MAPPING: The "gateway 172.17.0.1" in the logical view IS the docker0   │
│  bridge in the physical view. They are the same device.                  │
└─────────────────────────────────────────────────────────────────────────┘
```

The container kernel resolves the gateway via ARP. It sends an ARP request for `172.17.0.1`. This ARP travels through the veth pair to `docker0`. Since `docker0` owns that IP, the bridge itself answers the ARP with its MAC address. The container then addresses all outbound Ethernet frames to that MAC, which means all traffic physically arrives at `docker0`.

---

## When SNAT Happens and When It Doesn't

Not all container traffic gets NAT'd. The rule is simple: **SNAT only happens when traffic needs to leave the physical machine for a network that cannot route private container IPs.** There are three distinct scenarios.

### Scenario 1: Container-to-Container (Same Host) -- No NAT

```
Container A (172.17.0.2)              Container B (172.17.0.3)
       │                                       ▲
       │  src=172.17.0.2 dst=172.17.0.3       │
       ▼                                       │
   eth0 (veth)                             eth0 (veth)
       │                                       ▲
       ▼                                       │
   veth1 ────── docker0 (L2 switch) ────── veth2
                     │
                     │  docker0 sees dst MAC belongs to veth2
                     │  Switches frame directly. Pure L2.
                     │
                     │  NO routing. NO iptables. NO NAT.
                     │  Source IP stays 172.17.0.2 end-to-end.
```

`docker0` acts as a **dumb L2 switch** here. It learns MAC-to-port mappings and forwards the Ethernet frame to the correct veth port. The packet never enters the host's IP routing stack, never hits iptables, and the source IP is never rewritten.

### Scenario 2: Container-to-Host -- No NAT

```
Container A (172.17.0.2)              Host process (listening on 172.17.0.1:8080)
       │                                       ▲
       │  src=172.17.0.2 dst=172.17.0.1       │
       ▼                                       │
   eth0 (veth) ──── docker0 bridge ────────────┘
                        │
                        │  docker0 has IP 172.17.0.1
                        │  Packet is destined for docker0 itself
                        │  Host kernel delivers to local socket
                        │
                        │  NO NAT needed. The host manages the
                        │  172.17.0.0/16 subnet and knows exactly
                        │  what 172.17.0.2 is. It processes the
                        │  request directly and responds.
```

The host is the "all-seeing parent" -- it manages the entire `172.17.0.0/16` subnet via docker0. It can reach all container IPs natively. No address translation is needed.

### Scenario 3: Container-to-Internet -- SNAT Happens HERE

```
Container A (172.17.0.2)                        Internet (google.com)
       │                                                ▲
       │  src=172.17.0.2 dst=142.250.80.46             │
       ▼                                                │
   eth0 → veth → docker0 → host routing                │
                               │                        │
                               ▼                        │
                    iptables POSTROUTING:                │
                    MASQUERADE rule fires                │
                               │                        │
                    src rewritten:                       │
                      172.17.0.2 → 10.128.0.5          │
                               │                        │
                               ▼                        │
                    Physical NIC (10.128.0.5) ──────────┘
                               │
                    src=10.128.0.5 dst=142.250.80.46
                    (internet can route this)
```

SNAT happens at the **last moment** before the packet leaves the physical NIC. The host's iptables `nat` table has the masquerade rule:

```
-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE
```

This rule matches only when the outgoing interface is NOT `docker0` (i.e., traffic is heading out to the physical network). Private IPs like `172.17.0.x` are not routable on the internet -- routers along the path would drop them. SNAT rewrites the source to the host's real IP so the internet can route the response back.

### Summary Table

| Scenario | Source IP at destination | NAT? | Why |
|---|---|---|---|
| Container → Container (same host) | `172.17.0.2` (original) | No | Pure L2 switching on docker0. Both parties are on the same subnet. |
| Container → Host | `172.17.0.2` (original) | No | Host manages the container subnet. It knows how to reach container IPs. |
| Container → Internet | `10.128.0.5` (host IP) | SNAT | Internet cannot route private IPs. Host masquerades the source. |

> **Key insight:** `docker0` does NOT do SNAT. It is just a switch. SNAT is done by the host's iptables, only when traffic needs to leave the machine. The isolation is one-way: the container cannot see the host, but the host knows everything about its containers.

---

## Kubernetes Pod Networking -- The Same Model, Elevated to a Law

Docker's container networking is a convention. Kubernetes turns it into a **strict requirement**: the [Kubernetes Network Model](https://kubernetes.io/docs/concepts/cluster-administration/networking/) mandates that **every Pod must be able to communicate with every other Pod using its real IP address, without NAT**. This applies across nodes, across zones, across the entire cluster.

The three traffic flows parallel Docker's model, but with the cross-node requirement adding complexity.

### Flow 1: Pod-to-Pod Same Node -- No NAT

Identical to Docker's container-to-container flow. The CNI plugin creates a bridge (`cni0` or `cbr0`) or uses PtP routes, and traffic is switched/routed locally.

```
Pod A (10.244.1.2)                     Pod B (10.244.1.3)
       │                                       ▲
       │  src=10.244.1.2 dst=10.244.1.3       │
       ▼                                       │
   eth0 (veth)                             eth0 (veth)
       │                                       ▲
       ▼                                       │
   vethA ─── cni0 bridge (or PtP route) ── vethB
                    │
                    │  Same as Docker.
                    │  No NAT. Source IP preserved.
```

### Flow 2: Pod-to-Pod Different Node -- No NAT (CNI Handles Cross-Node Routing)

This is where the CNI plugin earns its keep. The Pod's original source IP MUST be preserved across nodes -- no SNAT. Different CNIs achieve this differently:

```
┌─ Node 1 ───────────────────────────┐    ┌─ Node 2 ───────────────────────────┐
│                                      │    │                                      │
│  Pod A (10.244.1.2)                 │    │  Pod B (10.244.2.5)                 │
│       │                              │    │       ▲                              │
│       │  src=10.244.1.2              │    │       │  src=10.244.1.2             │
│       │  dst=10.244.2.5             │    │       │  dst=10.244.2.5             │
│       ▼                              │    │       │                              │
│   eth0 → veth → host routing        │    │   host routing → veth → eth0       │
│       │                              │    │       ▲                              │
│       ▼                              │    │       │                              │
│   ┌───────────────────────────┐     │    │   ┌───────────────────────────┐     │
│   │ CNI cross-node transport  │     │    │   │ CNI cross-node transport  │     │
│   │                           │     │    │   │                           │     │
│   │ Flannel: VXLAN tunnel     │─────┼────┼──>│ Flannel: VXLAN decap     │     │
│   │   outer: Node1→Node2     │     │    │   │   inner: original IPs     │     │
│   │   inner: Pod A→Pod B     │     │    │   │                           │     │
│   │                           │     │    │   │                           │     │
│   │ Calico: BGP route         │─────┼────┼──>│ Calico: BGP route         │     │
│   │   Node2 knows 10.244.1.0 │     │    │   │   Node1 knows 10.244.2.0 │     │
│   │   is reachable via Node1  │     │    │   │   is reachable via Node2  │     │
│   └───────────────────────────┘     │    │   └───────────────────────────┘     │
│       │                              │    │       ▲                              │
│       ▼                              │    │       │                              │
│   Physical NIC (192.168.1.10)       │    │   Physical NIC (192.168.1.11)       │
│                                      │    │                                      │
└──────────────────────────────────────┘    └──────────────────────────────────────┘
                    │                                       ▲
                    └───── Physical Network (L2/L3) ────────┘

Source IP 10.244.1.2 is preserved end-to-end. NO NAT.
```

**Flannel (VXLAN)**: Encapsulates the original packet inside a VXLAN/UDP packet. The outer header uses node IPs (`192.168.1.10` → `192.168.1.11`). The inner header preserves Pod IPs (`10.244.1.2` → `10.244.2.5`). The receiving node decapsulates and delivers the inner packet.

**Calico (BGP)**: Uses BGP to advertise Pod subnets across nodes. Node 2's routing table has: `10.244.1.0/24 via 192.168.1.10`. Packets are forwarded natively at L3 -- no encapsulation. The physical network routes based on these advertised routes.

### Flow 3: Pod-to-Internet -- SNAT at the Node

Same as Docker. When a Pod sends traffic to the public internet, the node's iptables masquerade rule rewrites the source IP from the Pod IP to the node's IP.

```
Pod A (10.244.1.2) → veth → host routing → iptables MASQUERADE
       │
       │  src rewritten: 10.244.1.2 → 192.168.1.10 (node IP)
       ▼
Physical NIC → Internet

Only happens for traffic leaving the cluster.
Pod-to-Pod traffic (even cross-node) is NEVER NAT'd.
```

The Kubernetes `ip-masq-agent` (or equivalent CNI configuration) controls exactly which destination CIDRs are considered "external" and should trigger masquerade. Typically, the Pod CIDR and Service CIDR are excluded from masquerade (traffic to these ranges keeps the original Pod source IP), while everything else gets SNAT'd.

---

## The Role of CNI -- The Master Electrician

The **CNI (Container Network Interface)** is a specification and a set of plugins. A CNI plugin is NOT a router, NOT a switch, NOT a wire. It is the **software that BUILDS the networking infrastructure** when a Pod starts, and tears it down when the Pod dies. Once the wiring is in place, the CNI goes dormant -- the Linux kernel handles all actual packet forwarding at runtime.

### What the CNI Does at Pod Startup vs Runtime

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     CNI PLUGIN ACTIONS (Pod Startup)                      │
│                     ────────────────────────────────                      │
│                                                                          │
│  kubelet calls CNI binary:  /opt/cni/bin/<plugin> ADD                   │
│                                                                          │
│  1. CREATE veth pair                                                     │
│     └─ ip link add veth_host type veth peer name eth0                   │
│                                                                          │
│  2. MOVE one end into Pod's network namespace                            │
│     └─ ip link set eth0 netns <pod_pid>                                 │
│                                                                          │
│  3. ASSIGN Pod IP (IPAM)                                                 │
│     └─ ip addr add 10.244.1.2/24 dev eth0 (inside Pod ns)              │
│     └─ IP allocated from node's Pod CIDR range                          │
│                                                                          │
│  4. PLUG veth into bridge OR set up PtP route                            │
│     └─ Bridge mode: ip link set veth_host master cni0                   │
│     └─ PtP mode:    ip route add 10.244.1.2 dev cali1234 scope link    │
│                                                                          │
│  5. SET default route inside Pod namespace                               │
│     └─ ip route add default via 10.244.1.1 dev eth0                    │
│                                                                          │
│  6. PROGRAM cross-node routing (if needed)                               │
│     └─ Flannel: ensure VXLAN tunnel interface (flannel.1) exists         │
│     └─ Calico:  advertise new Pod route via BGP daemon                  │
│                                                                          │
│  7. WRITE iptables rules                                                 │
│     └─ SNAT/masquerade for internet-bound traffic                       │
│     └─ Network policy ACCEPT/DROP rules                                  │
│                                                                          │
│  8. RETURN Pod IP to kubelet (JSON on stdout)                            │
│     └─ {"cniVersion":"1.0.0","ips":[{"address":"10.244.1.2/24"}]}      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     RUNTIME (Linux Kernel Handles Everything)             │
│                     ────────────────────────────────────────              │
│                                                                          │
│  The CNI is dormant. The kernel does all the work:                       │
│                                                                          │
│  • veth pair:     kernel shuttles packets across namespace boundary      │
│  • Bridge/route:  kernel forwards packets per routing table              │
│  • iptables:      kernel's netfilter applies NAT/filter rules            │
│  • VXLAN:         kernel encap/decap via flannel.1 interface             │
│  • conntrack:     kernel tracks connections for stateful NAT             │
│                                                                          │
│  The CNI binary is NOT running. It was invoked once at Pod startup       │
│  and once at Pod teardown. Everything in between is the kernel.          │
│                                                                          │
│  Analogy: The CNI is the plumber who installs the pipes and faucets.     │
│  The Linux kernel is the water system that flows through them 24/7.      │
│  The plumber goes home after installation.                               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### CNI Specification

The CNI spec (maintained at [containernetworking/cni](https://github.com/containernetworking/cni)) defines a simple contract:

| Operation | When Called | What It Does |
|---|---|---|
| `ADD` | Pod starts | Create all networking for the Pod. Return the assigned IP. |
| `DEL` | Pod stops | Tear down all networking for the Pod. Clean up routes, iptables, veth. |
| `CHECK` | Periodic | Verify networking is still healthy. Optional. |
| `VERSION` | Any time | Report supported CNI spec versions. |

The kubelet calls the CNI binary as an exec (not a long-running daemon). The binary reads a JSON config from stdin, performs its work, and writes a JSON result to stdout. This simplicity is by design -- it makes CNI plugins easy to write and swap.

---

## Point-to-Point (PtP) Routing -- Bypassing the Bridge

The bridge model (used by Docker and Flannel) works but has overhead. In **PtP (Point-to-Point) routing**, used by CNIs like Calico, the host-side end of the veth pair is NOT plugged into any bridge. Instead, the CNI writes a direct route in the host's routing table pointing to that specific veth interface.

### How PtP Works

```
┌─ Bridge Model (Docker/Flannel) ──────┐  ┌─ PtP Model (Calico) ─────────────┐
│                                        │  │                                    │
│  Host routing table:                   │  │  Host routing table:               │
│    10.244.1.0/24 dev cni0             │  │    10.244.1.2 dev cali1234         │
│                                        │  │    10.244.1.3 dev cali5678         │
│  cni0 bridge                           │  │    10.244.1.4 dev cali9abc         │
│   ├── veth1 ←→ Pod A (10.244.1.2)    │  │                                    │
│   ├── veth2 ←→ Pod B (10.244.1.3)    │  │  cali1234 ←→ Pod A (10.244.1.2)  │
│   └── veth3 ←→ Pod C (10.244.1.4)    │  │  cali5678 ←→ Pod B (10.244.1.3)  │
│                                        │  │  cali9abc ←→ Pod C (10.244.1.4)  │
│  Packets go:                           │  │                                    │
│    Pod A → veth1 → cni0 (L2 switch)  │  │  Packets go:                       │
│    → veth2 → Pod B                    │  │    Pod A → cali1234 → host L3      │
│                                        │  │    routing → cali5678 → Pod B      │
│  L2: ARP, MAC learning, broadcast     │  │                                    │
│                                        │  │  Pure L3: no ARP between Pods,     │
│                                        │  │  no MAC learning, no broadcast     │
└────────────────────────────────────────┘  └────────────────────────────────────┘
```

### Why No ARP Is Needed in PtP

In PtP mode, each veth has a `/32` route. The host knows: "For IP `10.244.1.2`, send down interface `cali1234`." There is exactly one possible destination at the end of that pipe. The host does not need to ARP for the next-hop because there is only one device on the link.

For the Pod side, the Pod's default route points to a link-local address (`169.254.1.1`). The host-side veth has `proxy_arp` enabled, so it answers ARP requests for `169.254.1.1` with its own MAC. The Pod sends all outbound frames to that MAC, and they arrive at the host for L3 routing.

### PtP vs Bridge: Trade-offs

| Aspect | Bridge Model | PtP Model (Calico) |
|---|---|---|
| **L2 overhead** | ARP tables, MAC learning, broadcast flooding | None. Pure L3 forwarding. |
| **CPU usage** | Higher (L2 switch simulation per packet) | Lower (direct route lookup) |
| **Broadcast storms** | Possible in large clusters (ARP for every Pod) | Zero ARP traffic between Pods |
| **Security** | MAC spoofing possible; shared L2 domain means Pods can sniff frames | No shared L2 domain. Each veth is isolated. No MAC spoofing. |
| **Routing table size** | One subnet route per node (e.g., `10.244.1.0/24 dev cni0`) | One `/32` route per Pod. 500 Pods = 500 route entries. |
| **Synchronization** | Minimal (bridge auto-learns MACs) | CNI must keep routing table perfectly synchronized with Pod lifecycle |
| **Cross-node routing** | Overlay (VXLAN) | BGP (routes shared across nodes) |

### The Trade-off: Routing Table Size

The PtP model's main cost is that the host routing table must have an entry for **every Pod on that node**. On a node with 500 Pods, that is 500 routing entries. The CNI daemon (e.g., Calico's Felix agent) must ensure these routes are perfectly synchronized with Pod lifecycle -- adding routes when Pods start and removing them when Pods die. A stale route for a dead Pod means traffic to that IP goes into a dead veth and is silently dropped.

For cross-node traffic, Calico uses **BGP** to advertise each node's Pod routes to other nodes. Each node's routing table also contains entries like `10.244.2.0/24 via 192.168.1.11` -- meaning "Pods in the `10.244.2.0/24` range are reachable via Node 2's IP." The Calico BGP daemon (BIRD) handles this advertisement automatically.

---

## See also

- [[notes/Networking/docker-proxy-networking-in-k8s|Docker Proxy Networking in K8s]]
- [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]]
- [[notes/Networking/gke-snat-ip-masquerade|GKE SNAT & IP Masquerading]]
- [[notes/Networking/proxies-and-tls-termination|Proxies & TLS Termination]]
- [[notes/Networking/http_vs_https_proxy|HTTP vs HTTPS Forward Proxy]]
- [Linux Network Namespaces (man 7 network_namespaces)](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)
- [veth - Virtual Ethernet Pair (man 4 veth)](https://man7.org/linux/man-pages/man4/veth.4.html)
- [Docker Networking Overview](https://docs.docker.com/engine/network/)
- [Kubernetes Networking Model](https://kubernetes.io/docs/concepts/cluster-administration/networking/)
- [Kubernetes Service (ClusterIP)](https://kubernetes.io/docs/concepts/services-networking/service/)
- [EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/)
- [kube-proxy modes](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [Calico Architecture](https://docs.tigera.io/calico/latest/reference/architecture/overview)
- [Cilium / eBPF Datapath](https://docs.cilium.io/en/stable/network/ebpf/)
- [AWS VPC CNI Plugin](https://github.com/aws/amazon-vpc-cni-k8s)
- [conntrack-tools](https://conntrack-tools.netfilter.org/)
- [nf_conntrack (kernel docs)](https://www.kernel.org/doc/html/latest/networking/nf_conntrack-sysctl.html)
- [CNI Specification](https://github.com/containernetworking/cni/blob/main/SPEC.md)
- [Flannel (VXLAN backend)](https://github.com/flannel-io/flannel)
- [Calico BGP Peering](https://docs.tigera.io/calico/latest/networking/configuring/bgp)

---

## Interview Prep

### Q: What is a Linux network namespace and how does it differ from a network/subnet?

**A:** A network namespace is a kernel-level isolation boundary that gives a process its own copy of the entire network stack: interfaces, IP addresses, routing table, iptables rules, port space, and ARP table. It exists within a single Linux kernel instance.

A network (subnet) is an IP address range like `10.0.1.0/24`. One namespace can contain multiple interfaces on different subnets (like a router with three NICs on three subnets -- still one namespace). Conversely, multiple namespaces can have interfaces on the same subnet (every Docker container gets a `172.17.0.x` address, each in its own namespace). The concepts are orthogonal: a namespace is about isolation of the network stack, a subnet is about IP address grouping.

Physical devices on different machines are in different kernels and therefore different namespaces. Namespaces do not span machines.

---

### Q: Walk through the complete packet path from a Docker container to the internet.

**A:** Starting from a `curl google.com` inside a container:

1. **Application → socket**: The app calls `connect()`. The kernel in the container's namespace allocates an ephemeral source port and creates a packet: `src=172.17.0.2:44312 dst=142.250.80.46:443`.

2. **Container routing**: The container's routing table has `default via 172.17.0.1 dev eth0`. The packet is sent out the container's `eth0`.

3. **veth pair tunnel**: `eth0` inside the container is one end of a veth pair. The packet instantly appears at the other end (`vethXXXXXX`) in the host's root namespace.

4. **docker0 bridge**: `vethXXXXXX` is attached to the `docker0` bridge. The bridge receives the frame. Since the destination (`142.250.80.46`) is not any local container, the bridge passes it up to the host's IP stack for L3 routing.

5. **Host routing**: The host's routing table has `default via 10.128.0.1 dev eth0`. The packet should go out the physical NIC.

6. **iptables POSTROUTING / masquerade**: Docker's rule `-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE` matches. The kernel rewrites the source IP from `172.17.0.2` to the host's IP (`10.128.0.5`) and records this mapping in the conntrack table.

7. **Physical NIC → internet**: The packet exits via the host's physical NIC, goes through the network gateway, and reaches Google.

8. **Return path**: The response arrives at the host's physical NIC. Conntrack looks up the mapping and un-SNATs the destination back to `172.17.0.2:44312`. The host routes it to `docker0`, which switches it to the correct veth port. The packet traverses the veth pair back into the container's namespace, where the kernel delivers it to the waiting socket.

---

### Q: Why can't you just connect docker0 directly to a container's namespace?

**A:** Because of the kernel rule that a network interface can belong to exactly one namespace at a time. `docker0` is in the host's root namespace. You cannot also put it in the container's namespace. If you moved it, it would disappear from the host, breaking all other containers.

The veth pair solves this: it creates two interfaces connected by an internal wire. One end (`eth0`) lives in the container's namespace, the other (`vethXXXXXX`) lives in the host namespace and is plugged into `docker0`. This is the only kernel construct that bridges the namespace boundary.

---

### Q: How does kube-proxy implement Kubernetes Services? What is DNAT?

**A:** kube-proxy watches the Kubernetes API for Service and EndpointSlice objects. For each Service, it writes iptables rules (or IPVS entries) in the node's root namespace.

DNAT (Destination NAT) rewrites the destination IP of a packet. When a Pod sends a packet to a Service ClusterIP (e.g., `10.96.45.12:80`), the packet hits iptables in the PREROUTING chain (for forwarded traffic) or OUTPUT chain (for locally generated traffic). kube-proxy's rules match on the ClusterIP and port, then jump to a chain that randomly selects one of the backend Pod IPs (using `--probability` for iptables, or IPVS's built-in algorithms). The selected backend's IP replaces the destination.

The chain hierarchy is: `KUBE-SERVICES` → `KUBE-SVC-XXXX` (per Service, load balances) → `KUBE-SEP-YYY` (per endpoint, applies DNAT). After DNAT, the packet has a real Pod IP as its destination and is routed normally.

kube-proxy itself does not forward any traffic. It is purely a control-plane agent that programs the kernel's packet processing rules.

---

### Q: Explain conntrack. Does every packet go through iptables NAT rules?

**A:** No. Only the first packet of a connection (the TCP SYN, or the first UDP datagram) traverses the full iptables NAT chain. When this packet is DNAT'd or SNAT'd, the kernel's conntrack module records the translation in a hash table entry: the original tuple, the reply tuple, and the NAT rewrite.

All subsequent packets of the same connection (SYN-ACK, ACK, data, FIN) are matched against the conntrack table. The kernel finds the existing entry, applies the same rewrite, and skips the iptables rule walk entirely. This is the "fast path."

Return traffic is also handled by conntrack: the kernel recognizes the reply direction and applies the reverse translation (un-DNAT or un-SNAT) so the original sender sees responses from the expected address.

A critical operational concern: the conntrack table has a fixed maximum size (default ~128K entries). Under high connection rates (many short-lived connections, microservices, DNS), the table can fill up. When full, new connections are silently dropped. Check with `dmesg | grep conntrack` for "table full" messages, and increase `net.netfilter.nf_conntrack_max` if needed.

---

### Q: What is the difference between DNAT, a forward proxy, a reverse proxy, and HTTPS CONNECT?

**A:**

**DNAT** operates at L3/L4 in kernel-space. It rewrites the destination IP in packet headers. There is one TCP connection between client and (rewritten) server. The client is unaware -- it's transparent. No content inspection. Used by kube-proxy for Service routing.

**Forward proxy** operates at L7 in user-space. The client explicitly configures `HTTP_PROXY` and sends requests to the proxy. The proxy opens a second TCP connection to the actual server. Two connections total. The proxy can inspect, cache, filter, and log HTTP content. Client must be configured to use it.

**Reverse proxy** also operates at L7 with two connections, but the client is unaware of the backends. The client thinks the proxy IS the server. The proxy terminates TLS, reads the HTTP request, and makes a new connection to a backend. Can do SSL offloading, path-based routing, caching, compression. Examples: Nginx, Envoy, HAProxy.

**HTTPS CONNECT** starts as L7 (the client sends `CONNECT server:443 HTTP/1.1` to the proxy), but after the proxy responds `200 Connection Established`, it becomes a blind L4 tunnel. The proxy creates two TCP sockets and shovels bytes between them without inspection. The client performs TLS directly with the server through the tunnel. The client explicitly participates (knows about the proxy), but the proxy cannot see the encrypted content.

---

### Q: How does a Pod discover the IP of another Service in Kubernetes?

**A:** Through DNS. Every Pod's `/etc/resolv.conf` is configured by the kubelet to point to CoreDNS (typically at ClusterIP `10.96.0.10`). When the app resolves `my-svc`, the resolver appends search domains: `my-svc.default.svc.cluster.local` (assuming the `default` namespace). This DNS query is a regular UDP packet that travels through the same veth/bridge plumbing -- it gets DNAT'd by kube-proxy's iptables rules to a CoreDNS Pod. CoreDNS watches the Kubernetes API and knows the mapping from Service names to ClusterIPs. It responds with the ClusterIP (e.g., `10.96.45.12`). The Pod then sends traffic to that ClusterIP, which gets DNAT'd to a real Pod IP by another set of kube-proxy iptables rules.

The `ndots:5` setting means any name with fewer than 5 dots gets search domains appended first, which causes extra DNS queries for external names like `google.com` (4 failed queries before the bare name is tried). Mitigation: use FQDNs with trailing dots, lower ndots, or use NodeLocal DNSCache.

---

### Q: Why do modern cloud CNIs (AWS VPC CNI, Cilium/eBPF) skip the bridge model?

**A:** The bridge model introduces overhead at multiple levels:

1. **L2 overhead**: ARP flooding, MAC learning, broadcast domain scaling issues
2. **Double NAT**: Container IP → node IP (masquerade) → external traffic
3. **iptables scaling**: Linear chain traversal is O(n) per Service, degrades with thousands of Services
4. **Overlay encapsulation**: Cross-node traffic in overlay networks adds 50+ bytes per packet (VXLAN header) and CPU cost for encap/decap

**AWS VPC CNI** avoids all of this by assigning real VPC IPs to Pods via ENI secondary IPs. The VPC routing fabric handles Pod-to-Pod traffic natively -- no bridge, no overlay, no NAT for east-west traffic.

**Cilium/eBPF** (used in GKE Dataplane V2) replaces iptables entirely with eBPF programs attached to network interfaces. Service DNAT is done via O(1) hash map lookups in eBPF. No conntrack for Service traffic (eBPF tracks state in its own maps). Network policies are enforced in-kernel at line rate. This eliminates kube-proxy and the entire iptables chain walk.

---

### Q: What is a veth pair and why is it the only way to connect namespaces?

**A:** A veth (virtual Ethernet) pair is a kernel construct consisting of two virtual network interfaces connected by an invisible internal wire. A packet written to one end instantly appears at the other end. They are created as a pair in the same namespace, then one end is moved to a different namespace.

It is the only way because of the kernel's rule that a network interface can belong to exactly one namespace. You cannot plug a single interface into two namespaces simultaneously. No other kernel construct (tap, tun, macvlan, bridge) crosses the namespace boundary. A veth pair is specifically designed for this: each end is a separate interface, each can live in a separate namespace, and they communicate through an internal kernel pipe.

---

### Q: Can a container in `--network host` mode have port conflicts? Why?

**A:** Yes. `--network host` means the container shares the host's network namespace entirely. There is no separate network namespace for the container. The container sees the host's interfaces, uses the host's IP address, and most critically, shares the host's port space. If the host (or another container in host mode) already has a process bound to port 80, and this container tries to bind port 80, it gets `EADDRINUSE`.

This is fundamentally different from normal bridge networking, where each container has its own namespace with its own port space -- multiple containers can all bind port 80 because each port 80 is in a different namespace.

---

### Q: What are EndpointSlices and why were they introduced?

**A:** EndpointSlices replaced the legacy Endpoints API for tracking the backend Pods of a Service. The legacy Endpoints object was a single resource containing ALL Pod IPs for a Service. For Services with thousands of Pods, this became a massive object. Any single Pod addition or removal triggered a full rewrite and push of the entire object to every node's kube-proxy, causing significant API server load and etcd write amplification.

EndpointSlices shard the endpoint list into chunks of ~100 endpoints each. When a Pod changes, only the affected slice is updated. This dramatically reduces the size of API server watch events and kube-proxy recalculation scope. EndpointSlices also carry topology metadata (node, zone, ready/serving/terminating state) that legacy Endpoints did not, enabling topology-aware routing where traffic prefers backends in the same availability zone.

---

### Q: If kube-proxy writes iptables rules on the node's OS, are these "real" or "virtual" iptables rules?

**A:** They are completely real. kube-proxy uses the standard `iptables` (or `nft`) binary to write rules into the Linux kernel's netfilter subsystem in the node's root network namespace. You can inspect them with `iptables -t nat -L -n` on any node. They use the same `PREROUTING`, `OUTPUT`, and `POSTROUTING` chains as any manually written firewall rule.

There is nothing "virtual" about them. The kernel's netfilter processes every packet through these chains. The only thing kube-proxy automates is the creation and deletion of rules -- reacting to Service and EndpointSlice changes from the Kubernetes API. If kube-proxy crashed and you manually wrote the same rules, the behavior would be identical.

---

### Q: Does the container's eth0 interface do NAT? Where does SNAT actually happen?

**A:** No. The container's `eth0` only knows its own private IP (e.g., `172.17.0.2`). It has no awareness of the host's IP, iptables rules, or NAT configuration. NAT happens at the **host level** -- specifically in the host's iptables `nat` table, in the `POSTROUTING` chain, right before the packet leaves the physical NIC.

The masquerade rule (`-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE`) only fires when traffic is leaving via an interface that is NOT `docker0` -- meaning it is heading to the external network. For container-to-container traffic (stays on the bridge) and container-to-host traffic (destination is the bridge IP), no NAT happens at all. SNAT only occurs when traffic needs to leave the machine for the public internet, because private IPs (`172.17.x.x`, `10.244.x.x`) are not routable on the internet.

---

### Q: The container sends to gateway 172.17.0.1, but traffic also goes through veth pairs and docker0. How do these two explanations fit together?

**A:** They are the same thing viewed from two different layers:

- **IP layer (logical view)**: The container's routing table says "send to gateway `172.17.0.1` via `eth0`." This is the routing decision.
- **Plumbing layer (physical view)**: The packet travels `eth0` → veth kernel tunnel → `docker0` bridge.

The key: `172.17.0.1` IS the IP address assigned to the `docker0` bridge interface. When the container sends to its gateway, it first ARPs for `172.17.0.1`. That ARP travels through the veth pair to `docker0`, which owns that IP and responds with its MAC. All subsequent traffic is addressed to docker0's MAC, so it physically arrives at docker0 through the veth tunnel.

```
Container routing table:           Physical path:
  "send to 172.17.0.1"     ===     eth0 → veth → docker0 (IS 172.17.0.1)
```

They are not two different paths -- they are two descriptions of the same path at different abstraction levels.

---

### Q: Walk through the three scenarios: container-to-container, container-to-host, container-to-internet. When does NAT happen in each?

**A:**

**Container-to-Container (same host)**: No NAT. The packet goes `Container A eth0 → veth → docker0 (L2 switch) → veth → Container B eth0`. The bridge acts as a dumb L2 switch, forwarding the Ethernet frame based on MAC addresses. The source IP (`172.17.0.2`) arrives unchanged at Container B. No routing, no iptables, no NAT -- pure Layer 2 switching.

**Container-to-Host**: No NAT. The container sends to `172.17.0.1` (or any host IP). The packet travels through the veth pair to docker0. Since the destination is docker0's own IP (or another host interface), the host kernel processes it locally. The host manages the `172.17.0.0/16` subnet and knows the container's IP natively. No address translation needed.

**Container-to-Internet**: SNAT happens. The packet travels `eth0 → veth → docker0 → host routing → iptables POSTROUTING`. The masquerade rule rewrites the source from `172.17.0.2` to the host's real IP (e.g., `10.128.0.5`). This happens at the last moment, right before the packet exits the physical NIC. The internet cannot route private IPs, so SNAT is mandatory. Conntrack records the mapping so return traffic can be un-SNAT'd back to `172.17.0.2`.

---

### Q: What does the CNI actually do vs what does the Linux kernel do?

**A:** The CNI plugin is invoked **twice** per Pod lifetime: once at startup (`ADD`) and once at teardown (`DEL`). During `ADD`, it builds all the networking infrastructure:

1. Creates the veth pair
2. Moves one end into the Pod's namespace
3. Assigns a Pod IP (IPAM -- IP Address Management)
4. Plugs the host-side veth into a bridge, or writes a PtP route in the host routing table
5. Sets the default route inside the Pod namespace
6. Programs cross-node routing (VXLAN tunnel for Flannel, BGP advertisement for Calico)
7. Writes iptables rules for SNAT/masquerade and network policy

After `ADD` completes, the CNI binary exits. It is not a long-running daemon (though many CNI implementations have a separate daemon for route synchronization, like Calico's Felix).

At **runtime**, the Linux kernel handles everything: the veth pair shuttles packets across namespace boundaries, the routing table directs forwarding, iptables/netfilter applies NAT and filtering, conntrack tracks connections, and VXLAN interfaces encapsulate/decapsulate if needed. The CNI built the plumbing; the kernel is the water flowing through it.

---

### Q: What is Point-to-Point routing and why do CNIs like Calico prefer it over bridges?

**A:** In PtP routing, the host-side end of the veth pair is NOT plugged into any bridge. Instead, the CNI writes a direct `/32` route in the host's routing table: `10.244.1.2 dev cali1234 scope link`. This tells the kernel: "To reach IP `10.244.1.2`, send the packet down interface `cali1234`." There is exactly one device at the other end of that veth, so no ARP is needed to find the destination.

Benefits over the bridge model:
- **Less CPU**: No L2 switch simulation. No MAC learning, no forwarding database lookups. Pure L3 route lookup.
- **No broadcast storms**: Zero ARP traffic between Pods. In a bridge model with 500 Pods, every new connection triggers ARP broadcasts to all 500 veth ports. In PtP mode, there are no broadcasts at all.
- **Better security**: No shared L2 domain means Pods cannot sniff each other's traffic or spoof MAC addresses.
- **Simpler model**: Operates purely at L3. No mixed L2/L3 semantics to debug.

The trade-off is that the host routing table must have one entry per Pod (not per subnet). A node with 500 Pods has 500 route entries. The CNI daemon must keep this table perfectly synchronized with Pod lifecycle. Calico's Felix agent handles this, and uses BGP (via BIRD) to advertise these routes to other nodes for cross-node Pod-to-Pod communication.

---

### Q: In Kubernetes, does Pod-to-Pod traffic across nodes go through NAT?

**A:** No. The Kubernetes Network Model (documented in the official [Cluster Networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/) docs) strictly requires that every Pod can communicate with every other Pod using its real IP address, **without NAT**. This is not a suggestion -- it is a hard requirement that every conformant CNI plugin must satisfy.

The CNI handles cross-node routing while preserving the original source IP:
- **Flannel (VXLAN)**: Encapsulates the entire Pod-to-Pod packet inside a VXLAN/UDP packet. The outer header uses node IPs for routing across the physical network; the inner header preserves the original Pod IPs untouched. The receiving node decapsulates and delivers the inner packet.
- **Calico (BGP)**: Advertises Pod subnet routes via BGP so that each node's routing table knows which node to forward to for each Pod CIDR. No encapsulation at all -- packets are routed natively at L3. The source IP is never rewritten.
- **AWS VPC CNI**: Assigns real VPC IPs to Pods, so the cloud routing fabric handles everything natively.

SNAT only happens for traffic leaving the cluster to the public internet (controlled by the `ip-masq-agent` or CNI configuration). Pod-to-Pod traffic, even across nodes and across availability zones, always preserves the original Pod IP.
