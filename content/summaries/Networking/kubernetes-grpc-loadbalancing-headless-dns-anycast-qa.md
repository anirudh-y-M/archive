---
title: "Summary: Kubernetes gRPC Load Balancing, Headless Services, DNS, and Anycast"
---

> **Full notes:** [[notes/Networking/kubernetes-grpc-loadbalancing-headless-dns-anycast-qa|Kubernetes + gRPC Load Balancing, Headless Services, DNS Records, and Anycast -->]]

## Key Concepts

### Headless Services

A headless Service is created with `clusterIP: None`. Kubernetes does not allocate a VIP or provide built-in Service-level load balancing. Instead, the Service DNS name resolves to **multiple A/AAAA records** (one per ready pod IP), unlike a normal Service which resolves to a single ClusterIP. This enables client-side load balancing and direct pod addressing.

When paired with StatefulSets, headless Services provide stable per-pod DNS names like `pod-0.my-headless.ns.svc.cluster.local`, critical for clustered systems (databases, Kafka, Elasticsearch) where members must discover specific peers. Use a normal ClusterIP Service when you just need a stable VIP with built-in L4 load balancing.

### gRPC + K8s Service Load Balancing Problem

Kubernetes Service LB operates at TCP connection creation time (L4). Once a connection maps to a backend pod, it stays sticky for that connection's lifetime. gRPC uses HTTP/2 with long-lived connections and multiplexes many RPCs over a small number of channels. Result: thousands of RPCs can all route to one pod because they share one long-lived connection, causing hotspotting while other pods sit idle.

### Client-Side Load Balancing with Headless Service

The solution is making gRPC aware of multiple backends. Use a headless Service so DNS returns all pod IPs, then configure gRPC with the `dns:///` scheme and `round_robin` policy. gRPC opens sub-connections to each resolved backend and distributes RPCs across them.

```go
grpc.Dial(
  "dns:///my-headless.default.svc.cluster.local:50051",
  grpc.WithDefaultServiceConfig(`{"loadBalancingConfig":[{"round_robin":{}}]}`),
)
```

Limitations: streaming RPCs still stick to the chosen sub-connection for the stream's duration. DNS refresh and caching behavior affects how quickly clients learn about pod changes.

### Vanilla gRPC Without Headless Service

**Option A -- Connection Sharding:** Open N separate gRPC connections to the same Service VIP. Each connection is a separate TCP flow, so kube-proxy may distribute them across different backends. Not guaranteed, but often improves balance. Implements `grpc.ClientConnInterface` with atomic round-robin across a pool of connections. Still connection-level balancing, not endpoint-aware.

**Option B -- Custom Resolver:** Implement a gRPC name resolver that watches Kubernetes EndpointSlices and feeds pod IPs directly into gRPC's resolver pipeline (e.g., `sercand/kuberesolver`). This gives true endpoint-aware client-side LB without headless Services or Envoy. Requires K8s API access and RBAC.

With a normal Service, DNS resolves to one VIP, so `round_robin` has nothing to balance across.

### The dns:/// URI Scheme

`dns:///my-headless.default.svc.cluster.local:50051` is a gRPC target URI -- `dns` tells gRPC to use its DNS resolver, `///` means no authority. The key: headless DNS returns multiple pod IPs, and `dns:///` makes gRPC consume them as a backend set. Without the explicit `dns:///` scheme, Go's standard resolver may pick one address and stick to it. The headless Service has no VIP but still has a DNS name.

### kube-proxy Sync and Service Routing

kube-proxy runs on every node as a DaemonSet, watches Services and EndpointSlices via the API server, and programs local dataplane rules (iptables, nftables, or IPVS mode) with a periodic sync period for cleanup. Every node learns the `Service VIP:port -> {endpoint PodIP:port list}` mapping.

**Which node handles the VIP?** For Pod-to-ClusterIP, the client's own node applies the rules (the packet enters the host network stack there). For external traffic (NodePort/LoadBalancer), the node that received the external packet handles it.

**Endpoint selection:** In iptables/nftables mode, selection is effectively random per connection using `-m statistic --mode random --probability`. In IPVS mode, a scheduling algorithm (round-robin, least-connections, etc.) is used. Selection is always per TCP connection, not per RPC -- this is why gRPC appears imbalanced.

**After endpoint selection:** kube-proxy rewrites the destination from Service VIP:port to PodIP:port (DNAT). CNI networking then routes the packet to the destination node.

```
Pod -> client node (VIP DNAT via iptables/nftables/IPVS) -> CNI routing -> dest node -> dest Pod
```

### DNS Record Types: A, AAAA, CNAME

**A record** maps a hostname to an IPv4 address. **AAAA record** maps to IPv6. A hostname can have multiple A/AAAA records for distribution and redundancy. **CNAME** makes one name an alias of another name (not an IP); requires an additional lookup to resolve the alias to A/AAAA records. A hostname that is a CNAME should not have other record types at the same name.

### Anycast vs Multi-A Records

Anycast is a **network routing technique**, not a DNS record type. The same IP address is advertised from multiple physical locations via BGP, and the network routes clients to the nearest location. With multi-A records, DNS returns different IPs and the client picks one. Anycast returns one IP served from many places. Anycast is used for global edge services (DNS resolvers, CDNs, DDoS absorption). DNS multi-IP depends on caching, TTLs, and resolver selection behavior.

## Quick Reference

```
Normal Service DNS:   my-svc.ns.svc.cluster.local -> 10.96.0.1 (single VIP)
Headless Service DNS: my-headless.ns.svc.cluster.local -> 10.2.0.11, 10.2.0.12, ...
```

| Approach | Needs Headless? | Needs K8s API? | Per-RPC LB? |
|---|---|---|---|
| Normal Service (default) | No | No | No (per-conn) |
| Headless + round_robin | Yes | No | Yes |
| Connection sharding | No | No | No (improved) |
| Custom resolver | No | Yes | Yes |
| Service mesh (Envoy) | No | No | Yes |

| kube-proxy Mode | Selection Method | Notes |
|---|---|---|
| iptables | Random (statistic module) | Common, per-connection |
| nftables | Random | Modern replacement |
| IPVS | Scheduler (RR, least-conn) | Legacy in newer K8s |

| DNS Type | Maps | Example |
|---|---|---|
| A | name -> IPv4 | `api.example.com -> 203.0.113.10` |
| AAAA | name -> IPv6 | `api.example.com -> 2001:db8::10` |
| CNAME | name -> name | `www.example.com -> web.example.net` |
| Anycast | N/A (BGP routing) | Same IP from many PoPs |

## Key Takeaways

- gRPC's long-lived HTTP/2 connections defeat K8s L4 load balancing -- you must use client-side LB or a service mesh for per-RPC distribution.
- Headless Service + `dns:///` + `round_robin` is the simplest production-grade solution.
- Connection sharding (N connections to VIP) is a decent workaround when headless isn't available, but it's still connection-level, not endpoint-aware.
- A custom K8s resolver (watching EndpointSlices) gives true endpoint-aware LB without headless, at the cost of requiring K8s API access.
- kube-proxy programs rules on every node; the client's own node handles VIP translation. Endpoint selection is per-connection.
- Anycast is BGP routing (one IP, many locations), not a DNS mechanism. Don't confuse it with multiple A records.
- Streaming RPCs still stick to one sub-connection for the stream's duration regardless of LB policy.
- Without the explicit `dns:///` scheme, gRPC may not engage its resolver/LB pipeline and stick to one address.
