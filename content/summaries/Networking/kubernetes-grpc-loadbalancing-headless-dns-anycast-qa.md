---
title: "Summary: Kubernetes gRPC Load Balancing, Headless Services, DNS, and Anycast"
---

> **Full notes:** [[notes/Networking/kubernetes-grpc-loadbalancing-headless-dns-anycast-qa|Kubernetes + gRPC Load Balancing, Headless Services, DNS Records, and Anycast -->]]

## Key Concepts

**Headless Service** -- A Kubernetes Service with `clusterIP: None`. No VIP allocated. DNS returns multiple A/AAAA records (one per pod IP) instead of a single ClusterIP. Used for client-side load balancing, peer discovery (StatefulSets), and direct pod addressing.

**gRPC + K8s Service Problem** -- gRPC uses long-lived HTTP/2 connections. K8s Service LB is per-connection (L4), not per-RPC. Result: all RPCs on one channel go to one pod, causing hotspotting.

**Client-Side LB Solution** -- Use a headless Service so DNS returns all pod IPs. Configure gRPC with `dns:///` scheme and `round_robin` policy. gRPC opens sub-connections to each resolved backend and distributes RPCs across them.

**Vanilla gRPC without Headless** -- Two options: (A) connection sharding (open N connections to the same VIP, hope K8s distributes them), or (B) custom resolver that watches K8s EndpointSlices and feeds pod IPs into gRPC's resolver.

**kube-proxy Internals** -- Runs on every node as a DaemonSet, watches Services + EndpointSlices, programs iptables/nftables/IPVS rules. VIP handling happens on the node where the packet first enters the host network stack. Endpoint selection is per-connection (random in iptables/nftables, scheduler-based in IPVS).

**DNS Record Types** -- A record = name -> IPv4; AAAA = name -> IPv6; CNAME = name -> name (alias). Anycast is a routing technique (same IP advertised from multiple locations via BGP), not a DNS record type.

## Quick Reference

```
Normal Service DNS:   my-svc.ns.svc.cluster.local -> 10.96.0.1 (single VIP)
Headless Service DNS: my-headless.ns.svc.cluster.local -> 10.2.0.11, 10.2.0.12, ...
```

**gRPC Go setup for client-side LB:**
```go
grpc.Dial(
  "dns:///my-headless.default.svc.cluster.local:50051",
  grpc.WithDefaultServiceConfig(`{"loadBalancingConfig":[{"round_robin":{}}]}`),
)
```

| Approach                | Needs Headless? | Needs K8s API? | Per-RPC LB? |
|-------------------------|-----------------|----------------|-------------|
| Normal Service (default)| No              | No             | No (per-conn)|
| Headless + round_robin  | Yes             | No             | Yes         |
| Connection sharding     | No              | No             | No (improved)|
| Custom resolver          | No              | Yes            | Yes         |
| Service mesh (Envoy)    | No              | No             | Yes         |

**kube-proxy packet flow:**
```
Pod -> client node (VIP DNAT) -> CNI routing -> dest node -> dest Pod
```

## Key Takeaways

- gRPC's long-lived HTTP/2 connections defeat K8s L4 load balancing -- you must use client-side LB or a service mesh for per-RPC distribution.
- Headless Service + `dns:///` + `round_robin` is the simplest production-grade solution.
- kube-proxy programs rules on *every* node; the client's own node handles VIP translation.
- Anycast is BGP routing (one IP, many locations), not a DNS mechanism. Don't confuse it with multiple A records.
- Streaming RPCs still stick to one sub-connection for the stream's duration regardless of LB policy.
