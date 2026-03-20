---
title: "Summary: Docker Proxy Networking in Kubernetes"
---

> **Full notes:** [[notes/Networking/docker-proxy-networking-in-k8s|Docker Proxy Networking in K8s -->]]

## Key Concepts

- **Docker network isolation**: Containers do NOT inherit the host's `HTTP_PROXY` env vars or CA certificates. Each container has its own network namespace via the bridge network.

- **Bridge gateway (`172.17.0.1`)**: Every container's default route. All traffic leaves via this gateway -- the host decides whether to masquerade it to the internet or route it to a ClusterIP via kube-proxy iptables.

- **Three-layer proxy problem**: When running GitHub Actions + DinD in K8s with mitmproxy, there are three separate network layers that each need independent proxy + CA cert configuration:
  - Layer 1 (runner process): Uses K8s service DNS name
  - Layer 2 (DinD daemon): Uses K8s service DNS name (shared pod network)
  - Layer 3 (inner containers): Must use ClusterIP (bridge network cannot resolve K8s DNS)

- **Why ClusterIP, not DNS**: Inner containers can resolve public FQDNs but NOT K8s internal names because Docker's bridge DNS resolver does not inherit K8s search domains from the pod's `/etc/resolv.conf`.

## Quick Reference

```
K8s Cluster
  mitmproxy pod (:8080)    runner pod
                             |-- Layer 1: runner process (K8s DNS works)
                             |-- Layer 2: DinD daemon (K8s DNS works, shared netns)
                             |-- Layer 3: inner containers (bridge network, ClusterIP only)
```

| Layer | Network | K8s DNS? | Proxy Config |
|---|---|---|---|
| Runner process | Pod network | Yes | `env` vars on pod spec |
| DinD daemon | Pod network (shared) | Yes | `daemon.json` |
| Inner `docker run` | Docker bridge | No | `-e` with ClusterIP |
| Inner `docker build` | Docker bridge | No | `--build-arg` with ClusterIP |

**CA cert must be trusted at every layer independently** -- each layer has its own TLS trust store.

## Key Takeaways

- Docker containers never inherit host proxy settings -- you must explicitly pass them at each layer.
- Inner containers in DinD use Docker's bridge network, which cannot resolve K8s service names. Use ClusterIP instead.
- Every layer performing TLS interception needs its own copy of the proxy CA certificate trusted in its own store.
- `--privileged` is required for DinD (nested namespaces/cgroups) but has nothing to do with networking or routing.
- The bridge gateway (`172.17.0.1`) is the implicit routing hop that makes all container egress work.
