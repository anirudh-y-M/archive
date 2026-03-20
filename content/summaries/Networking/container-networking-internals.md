---
title: "Summary: Container Networking Internals"
---

> **Full notes:** [[notes/Networking/container-networking-internals|Container Networking Internals -->]]

## Key Concepts

- **Network namespaces**: Each container gets its own isolated network stack (interfaces, IPs, routes, iptables, port space). One interface belongs to exactly one namespace at a time.

- **veth pairs**: The only kernel mechanism to send packets between namespaces. A pair of virtual interfaces connected by an invisible wire -- packet in one end appears at the other. One end in the container (`eth0`), other end in the host (`vethXXXXXX`).

- **docker0 bridge**: Acts as both an L2 switch (container-to-container MAC forwarding) and an L3 gateway (`172.17.0.1` -- default route for all containers). Without it, veth endpoints in the host namespace are "dangling cables."

- **Pause container**: In K8s, creates and holds the Pod's network namespace. All other containers in the Pod join it. If pause dies, the namespace is destroyed.

- **kube-proxy**: A control-plane agent (NOT in the data path). Watches Services/EndpointSlices and writes iptables DNAT rules. Packets are processed by the kernel, not by kube-proxy.

- **conntrack**: After the first packet of a connection is DNAT'd, the kernel records the translation. Subsequent packets for that connection skip the iptables rule walk entirely.

## Quick Reference

```
Container eth0 (172.17.0.2)
    | veth pair
vethXXXX (host namespace)
    |
docker0 bridge (172.17.0.1) -- L2 switch + L3 gateway
    |
Host iptables: MASQUERADE src 172.17.0.0/16
    |
eth0 (physical NIC, 10.128.0.5) --> Internet
```

**kube-proxy DNAT chain:**
```
PREROUTING --> KUBE-SERVICES
  match 10.96.45.12:80 --> KUBE-SVC-XXXX
    p=0.333 --> DNAT to Pod A
    p=0.500 --> DNAT to Pod B
    remainder --> DNAT to Pod C
```

| Mode | Data Structure | Lookup | Use When |
|---|---|---|---|
| iptables | Linear chain | O(n) | < 1000 Services |
| IPVS | Hash table | O(1) | > 1000 Services |

**Cross-host solutions**: Overlay (Flannel VXLAN), BGP routing (Calico), Cloud-native (AWS VPC CNI).

## Key Takeaways

- Everything is built on three Linux primitives: network namespaces, veth pairs, and bridges.
- kube-proxy is NOT a proxy -- it writes iptables rules and sleeps. The kernel does all packet forwarding.
- conntrack makes subsequent packets in a connection fast by skipping the iptables rule walk.
- Modern CNIs (Calico) skip the bridge entirely using point-to-point L3 routing with proxy_arp.
- The pause container is the lifecycle anchor for a Pod's network namespace.
