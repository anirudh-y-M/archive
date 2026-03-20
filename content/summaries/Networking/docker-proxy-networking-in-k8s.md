---
title: "Summary: Docker Proxy Networking in Kubernetes"
---

> **Full notes:** [[notes/Networking/docker-proxy-networking-in-k8s|Docker Proxy Networking in K8s -->]]

## Key Concepts

### Docker Network Isolation from the Host

Docker containers do NOT inherit the host's `HTTP_PROXY`/`HTTPS_PROXY` environment variables or CA certificates. Containers have their own isolated network stack via the bridge network (separate network namespace). To route container traffic through a proxy, you must explicitly pass proxy env vars at runtime (`docker run -e`) or build time (`docker build --build-arg`), and install the proxy's CA certificate inside the container for TLS interception.

On Linux, `host.docker.internal` may not work -- use `--network host` or the host's actual IP instead.

### The Docker Bridge Gateway

Every container on Docker's default bridge gets an IP (e.g., `172.17.0.2`) and a default route pointing to `172.17.0.1`. This gateway is the `docker0` virtual bridge interface on the host -- the "front door" from the container's perspective. **All traffic leaving a container goes through this gateway**, regardless of destination (internet, ClusterIP, internal service). The host decides what to do: internet-bound traffic gets masqueraded (SNAT), ClusterIP-bound traffic hits kube-proxy iptables rules. The gateway is an implicit routing hop, not something you configure.

### Three-Layer Proxy Configuration in K8s (GH Actions + DinD)

When running GitHub Actions with DinD in Kubernetes alongside a mitmproxy pod, there are three distinct network layers, each needing independent proxy and CA cert configuration:

```
mitmproxy pod (:8080)     runner pod
                            |-- Layer 1: runner process
                            |-- Layer 2: DinD daemon (sidecar)
                            |    \-- Layer 3: inner containers (bridge)
```

**Layer 1 (Runner process):** Standard K8s pod-to-pod communication. Uses K8s service DNS name (`mitmproxy-svc.namespace.svc.cluster.local:8080`). Proxy configured via pod spec `env` vars. CA cert mounted as volume + `update-ca-certificates`.

**Layer 2 (DinD daemon):** Shares the pod's network namespace (sidecar), so K8s service DNS works. Proxy configured via `/etc/docker/daemon.json` under `proxies.http-proxy` / `proxies.https-proxy`. Controls traffic from the daemon itself (e.g., `docker pull`). CA cert mounted into daemon config.

**Layer 3 (Inner containers -- the tricky one):** Containers spawned by `docker run`/`docker build` inside DinD use Docker's bridge network -- a separate namespace. They **cannot** resolve K8s DNS names but **can** reach ClusterIPs via the bridge gateway. Must use ClusterIP (`kubectl get svc -o jsonpath='{.spec.clusterIP}'`) instead of service DNS name. Traffic path: inner container --> bridge gateway (172.17.0.1) --> pod network namespace --> kube-proxy iptables --> mitmproxy pod.

### Why ClusterIP Instead of DNS Name

Inner containers can resolve public FQDNs (`google.com`) because Docker's DNS resolver forwards unknown queries upstream to CoreDNS, which resolves via the internet. But K8s internal names like `mitmproxy-svc.namespace.svc.cluster.local` fail because Docker's bridge DNS resolver does **not** inherit the K8s search domains from the pod's `/etc/resolv.conf`. Without search domains, short names can't be expanded. Using ClusterIP bypasses DNS entirely -- an IP is absolute and needs no resolution.

Alternative: `docker run --dns=$K8S_DNS_IP` to force inner containers to use K8s DNS directly, but this is more brittle.

### CA Certificate at Every Layer

Every layer performing TLS interception must trust the mitmproxy CA independently, because each layer has its own TLS trust store:

| Layer | How to trust the cert |
|---|---|
| Runner (Layer 1) | Mount as volume, run `update-ca-certificates` |
| DinD daemon (Layer 2) | Mount cert into daemon config |
| Inner `docker run` (Layer 3) | Mount cert + `update-ca-certificates` before app |
| Inner `docker build` (Layer 3) | `COPY` cert, trust before any network-calling `RUN` step |

For Go specifically, `git` commands invoked by Go's module system need their own proxy and CA config via `git config --global http.proxy` and `http.sslCAInfo`.

Missing the CA at any single layer causes `certificate signed by unknown authority` at that layer while others work fine -- a confusing "some requests work, some don't" symptom.

### `--privileged` and Routing

`--privileged` is required for DinD (nested namespaces, cgroups, mounts). It has **nothing to do** with IP forwarding or routing. Unprivileged containers can reach the internet and ClusterIPs just fine. The bridge gateway, IP forwarding, and NAT/masquerade iptables rules are set up by Docker as part of normal bridge networking for all containers.

## Quick Reference

```
K8s Cluster
  mitmproxy pod (:8080)         runner pod
  (mitmproxy-svc ClusterIP)       |
                                  |-- Layer 1: runner process
                                  |   proxy = svc DNS name, CA in /etc/ssl/certs
                                  |
                                  |-- Layer 2: DinD daemon (shared netns)
                                  |   proxy = svc DNS name in daemon.json
                                  |
                                  |-- Layer 3: inner containers (bridge network)
                                      proxy = ClusterIP (DNS won't work)
                                      CA must be COPY'd/mounted independently
```

| Layer | Network | K8s DNS? | Proxy Config Method |
|---|---|---|---|
| Runner process | Pod network | Yes (CoreDNS) | `env` vars on pod spec |
| DinD daemon | Pod network (shared) | Yes (CoreDNS) | `daemon.json` |
| Inner `docker run` | Docker bridge (isolated) | Public only | `docker run -e` with ClusterIP |
| Inner `docker build` | Docker bridge (isolated) | Public only | `--build-arg` with ClusterIP |

**Traffic path for inner container reaching mitmproxy:**
```
Inner container (172.17.0.2)
  --> bridge gateway (172.17.0.1)
    --> pod network namespace
      --> kube-proxy iptables (ClusterIP match)
        --> mitmproxy pod
```

## Key Takeaways

- Docker containers never inherit host proxy settings -- you must explicitly pass them at every layer.
- The bridge gateway (`172.17.0.1`) is the implicit routing hop for all container egress. It's the host/pod's docker0 interface.
- Inner containers in DinD use Docker's bridge network, which cannot resolve K8s service names (no search domains). Use ClusterIP instead.
- Every layer performing TLS interception needs its own copy of the proxy CA certificate in its own trust store. Missing one causes partial failures.
- `--privileged` enables DinD (nested namespaces/cgroups) but has zero effect on networking or routing behavior.
- For `docker build`, the CA cert must be `COPY`'d and trusted before any network-calling `RUN` instruction (e.g., `go mod download`, `apt-get install`).
- Go's module system invokes `git`, which needs its own proxy and CA config separate from the system trust store.
