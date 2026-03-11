---
title: "Docker Proxy Networking in Kubernetes: mitmproxy, DinD & the Bridge Gateway"
---

## Docker Network Isolation from the Host

When you set up a proxy (like mitmproxy) on a host/VM/node and configure `HTTP_PROXY`/`HTTPS_PROXY` environment variables, Docker containers do **not** inherit that configuration. Containers have their own isolated network stack — the bridge network creates a separate network namespace.

To route container traffic through a proxy, you must explicitly configure each layer:

- Pass proxy env vars to the container at runtime.
- Install the proxy's CA certificate inside the container for TLS interception.

```bash
# docker run
docker run \
  -e HTTP_PROXY=http://host.docker.internal:8080 \
  -e HTTPS_PROXY=http://host.docker.internal:8080 \
  your-image

# docker build (build-time network calls: apt-get, go mod download, npm install)
docker build \
  --build-arg HTTP_PROXY=http://host.docker.internal:8080 \
  --build-arg HTTPS_PROXY=http://host.docker.internal:8080 \
  .
```

On Linux, `host.docker.internal` may not work. Use `--network host` to share the host's network namespace, or use the host's actual IP.

---

## The Docker Bridge Gateway

Every container on Docker's default bridge network gets an IP (e.g., `172.17.0.2`) and a default route pointing to `172.17.0.1`. This gateway IP belongs to the `docker0` virtual bridge interface on the host — it's the "front door" of the host from the container's perspective.

**All traffic leaving a container goes through this gateway** — whether the destination is the public internet, a K8s ClusterIP, or an internal service. The container doesn't know how to reach any of these directly; it sends every packet to `172.17.0.1`, and the host's network stack decides what to do:

- **Internet-bound traffic**: The host performs IP masquerade (SNAT), rewrites the source IP to the host's own IP, and sends it out the physical/virtual NIC.
- **ClusterIP-bound traffic** (in K8s): The host's iptables rules (managed by kube-proxy) catch the packet and redirect it to the actual target pod.

The gateway is an implementation detail — you don't configure anything to point at `172.17.0.1`. It's just the implicit routing hop that Docker's bridge network uses automatically.

---

## Three-Layer Proxy Configuration in K8s (GH Actions + DinD)

When running GitHub Actions with DinD in Kubernetes alongside a mitmproxy pod, there are three distinct network layers. Each needs its own proxy and CA cert configuration.

```
┌─ K8s Cluster ───────────────────────────────────────────┐
│                                                          │
│  ┌─ mitmproxy pod ─┐     ┌─ runner pod ───────────────┐ │
│  │  :8080           │     │                            │ │
│  │  mitmproxy-svc ◄─┼─────┤  Layer 1: runner process  │ │
│  └──────────────────┘     │                            │ │
│                           │  Layer 2: dind daemon      │ │
│                           │    └─ Layer 3: inner       │ │
│                           │       containers (bridge)  │ │
│                           └────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Layer 1 — Runner pod process

The runner and mitmproxy are both in the K8s cluster. They communicate via the K8s service name:

```yaml
env:
  - name: HTTP_PROXY
    value: "http://mitmproxy-svc.namespace.svc.cluster.local:8080"
  - name: HTTPS_PROXY
    value: "http://mitmproxy-svc.namespace.svc.cluster.local:8080"
```

Mount the mitmproxy CA cert as a volume and run `update-ca-certificates`. This layer is standard K8s service-to-service communication.

### Layer 2 — DinD daemon (sidecar)

The DinD sidecar shares the pod's network namespace, so it can also use the K8s service name. Configure via `/etc/docker/daemon.json`:

```json
{
  "proxies": {
    "http-proxy": "http://mitmproxy-svc.namespace.svc.cluster.local:8080",
    "https-proxy": "http://mitmproxy-svc.namespace.svc.cluster.local:8080"
  }
}
```

This controls traffic from the daemon itself (e.g., `docker pull`).

### Layer 3 — Inner containers (the tricky one)

Containers spawned by `docker run` or `docker build` inside DinD use Docker's **bridge network** — a separate network namespace. They cannot resolve K8s DNS names, but they **can** reach K8s ClusterIPs via the bridge gateway.

Use the ClusterIP instead of the service name:

```bash
PROXY_IP=$(kubectl get svc mitmproxy-svc -o jsonpath='{.spec.clusterIP}')

# docker run
docker run \
  -e HTTP_PROXY=http://${PROXY_IP}:8080 \
  -e HTTPS_PROXY=http://${PROXY_IP}:8080 \
  your-image

# docker build
docker build \
  --build-arg HTTP_PROXY=http://${PROXY_IP}:8080 \
  --build-arg HTTPS_PROXY=http://${PROXY_IP}:8080 \
  .
```

The traffic path: inner container → bridge gateway (`172.17.0.1`) → pod's network namespace → kube-proxy iptables → mitmproxy pod.

This works because `172.17.0.1` is the pod (from the container's perspective), and the pod's network namespace has kube-proxy rules that know how to route ClusterIP traffic. It's the exact same mechanism that allows the container to reach `google.com` — the bridge gateway forwards everything.

---

## Why ClusterIP Instead of DNS Name

Containers can resolve `google.com` because Docker's internal DNS resolver forwards unknown queries to the upstream DNS configured on the host (the pod), which uses CoreDNS, which resolves it via the internet. The full chain works for public FQDNs.

But K8s internal names like `mitmproxy-svc.namespace.svc.cluster.local` fail because Docker's bridge DNS resolver does not inherit the K8s **search domains** from the pod's `/etc/resolv.conf`. Without the search domain `namespace.svc.cluster.local`, the inner container can't turn `mitmproxy-svc` into a fully qualified name that CoreDNS can resolve.

Using the ClusterIP bypasses DNS entirely — an IP is absolute and doesn't need resolution.

If you must use DNS names inside the inner container, force it to use the K8s DNS server:

```bash
K8S_DNS_IP=$(kubectl get svc -n kube-system kube-dns -o jsonpath='{.spec.clusterIP}')
docker run --dns=$K8S_DNS_IP -e HTTP_PROXY=http://mitmproxy-svc:8080 ...
```

This is more brittle than using the ClusterIP directly — it adds a failure point.

---

## CA Certificate at Every Layer

Every layer performing TLS interception must trust the mitmproxy CA, or connections fail with certificate errors:

| Layer | How to trust the cert |
| --- | --- |
| Runner (Layer 1) | Mount as volume, run `update-ca-certificates` |
| DinD daemon (Layer 2) | Mount same cert into daemon config |
| Inner containers — `docker run` (Layer 3) | Mount cert + run `update-ca-certificates` before app starts |
| Inner containers — `docker build` (Layer 3) | `COPY` cert into image and trust it before any network-calling `RUN` step |

For `docker build`:

```dockerfile
ARG PROXY_CA_CERT
COPY $PROXY_CA_CERT /usr/local/share/ca-certificates/mitmproxy.crt
RUN update-ca-certificates
# Subsequent RUN steps (go mod download, apt-get, npm install) now trust the proxy
```

For Go specifically, `git` commands invoked by Go's module system need their own proxy and CA config:

```bash
git config --global http.proxy http://${PROXY_IP}:8080
git config --global http.sslCAInfo /path/to/mitmproxy-ca-cert.pem
```

---

## `--privileged` and Routing

DinD requires `--privileged` to create nested namespaces, manage cgroups, and mount filesystems. It has **nothing to do** with IP forwarding or routing.

Regular unprivileged containers can reach the public internet and ClusterIPs just fine. The bridge gateway (`172.17.0.1`) and IP forwarding are set up by Docker as part of normal bridge networking, along with NAT/masquerade iptables rules. The routing path is identical for privileged and unprivileged containers.

---

## Summary

| Layer | Network | DNS works? | Proxy auto-inherited? | Config method |
| --- | --- | --- | --- | --- |
| Runner process | Pod network | Yes (CoreDNS) | No | `env` vars on pod spec |
| DinD daemon | Pod network (shared) | Yes (CoreDNS) | No | `daemon.json` |
| Inner `docker run` | Docker bridge (isolated) | Public only | No | `docker run -e` with ClusterIP |
| Inner `docker build` | Docker bridge (isolated) | Public only | No | `--build-arg` with ClusterIP |

---

## See also

- [[notes/Networking/gke-snat-ip-masquerade|GKE SNAT & IP Masquerading]]
- [[notes/Networking/proxies-and-tls-termination|Proxies & TLS Termination]]
- [[notes/K8s/daemonset-pod-race-conditions|DaemonSet Pod Race Conditions]]
- [[notes/Networking/http_vs_https_proxy|HTTP vs HTTPS Forward Proxy]]
- [Docker Network Overview](https://docs.docker.com/engine/network/)

---

## Interview Prep

### Q: You set `HTTP_PROXY` on a VM and start mitmproxy. A Docker container on that VM makes a `curl` to `google.com`. Does the request go through mitmproxy? Why or why not?

**A:** No. Docker containers have their own isolated network stack via Linux network namespaces. The container has its own `eth0` interface on Docker's bridge network (`172.17.0.0/16`), its own routing table, and its own environment variables. The host's `HTTP_PROXY` environment variable is not inherited — environment variables are per-process, and Docker doesn't propagate the host's env into the container by default.

To route the container's traffic through mitmproxy, you need two things: (1) Pass `-e HTTP_PROXY=http://host.docker.internal:8080` (or the host's IP) when running the container. (2) Install mitmproxy's CA certificate inside the container and add it to the trust store, otherwise TLS handshakes fail because the container sees mitmproxy's self-signed cert instead of the real server cert.

The same applies to `docker build` — build-time network calls (`RUN apt-get install`, `RUN go mod download`) need `--build-arg HTTP_PROXY=...`, and the CA cert must be `COPY`'d and trusted before any network-calling `RUN` instruction.

### Q: Walk through the full network path of an HTTP request from a container inside DinD (running in a K8s pod) to the internet.

**A:** There are three network boundary crossings:

**1. Container to bridge gateway:** The inner container has an IP like `172.17.0.2` on Docker's bridge network. Its routing table has a default route pointing to `172.17.0.1` — the `docker0` bridge interface. The packet (source: `172.17.0.2`, dest: `140.82.113.3`) leaves the container's network namespace and arrives at the bridge interface.

**2. Bridge gateway to pod network:** The `docker0` bridge interface belongs to the DinD sidecar, which shares the pod's network namespace. The pod's network stack receives the packet. Docker's iptables rules perform SNAT (masquerade) — rewriting the source from `172.17.0.2` to the pod's IP (e.g., `10.48.1.5`). The packet is now in the pod's network namespace with source `10.48.1.5`.

**3. Pod to the internet:** From here it follows the standard GKE path. If ip-masq-agent is enabled, the node's iptables rewrite the source from `10.48.1.5` (pod IP, secondary range) to `10.128.0.5` (node IP, primary range). The packet reaches Cloud NAT at the VPC edge, which rewrites the source to a public IP (e.g., `35.199.0.71`). The packet hits the internet.

Return traffic reverses all three translations: Cloud NAT → node iptables → Docker bridge iptables → inner container. Each layer uses its conntrack table to map return packets to the correct original source.

### Q: Why can a container inside DinD resolve `google.com` but not `mitmproxy-svc.namespace.svc.cluster.local`?

**A:** Both queries go through Docker's internal DNS resolver, which forwards unknown queries upstream. The difference is in how the upstream DNS server handles them.

`google.com` is a fully qualified domain name (FQDN). Docker's DNS resolver forwards it to the upstream DNS configured on the host (the pod). The pod's `/etc/resolv.conf` points to CoreDNS (`10.96.0.10`), which resolves `google.com` via recursive DNS on the internet. Works fine.

`mitmproxy-svc` is a short name. In a normal K8s pod, `/etc/resolv.conf` has `search namespace.svc.cluster.local svc.cluster.local cluster.local` — these search domains let CoreDNS expand `mitmproxy-svc` into `mitmproxy-svc.namespace.svc.cluster.local`. But Docker's bridge DNS resolver does **not** inherit the K8s search domains from the pod's `/etc/resolv.conf`. The inner container's `/etc/resolv.conf` has Docker's own defaults. When it queries `mitmproxy-svc`, the upstream DNS gets an unqualified name without the right search suffix — CoreDNS can't resolve it, or worse, the query never reaches CoreDNS at all.

The fix is either to use the ClusterIP directly (bypasses DNS entirely) or to force the inner container to use K8s DNS: `docker run --dns=10.96.0.10 ...`. The ClusterIP approach is more reliable because it removes DNS as a failure point.

### Q: In the three-layer proxy setup (runner + DinD + inner containers), why does each layer need the mitmproxy CA certificate independently?

**A:** Because TLS is end-to-end by design. Each layer establishes its own TLS connection, and each connection goes through the MITM proxy independently.

When mitmproxy intercepts an HTTPS connection, it presents a **fake certificate** for the target domain (e.g., `github.com`), signed by its own CA. The client only accepts this if it trusts that CA. Each "client" in this stack is a different process with its own trust store:

- **Layer 1 (runner)**: The runner process (Go, Python, curl) checks `/etc/ssl/certs/` or the language-specific trust store. If the mitmproxy CA isn't there, TLS fails.
- **Layer 2 (DinD daemon)**: `dockerd` makes its own TLS connections when pulling images (`docker pull`). It has its own trust store configuration.
- **Layer 3 (inner containers)**: Each container is a fresh filesystem. Even if the host has the CA trusted, the container's `/etc/ssl/certs/` is populated from the container image, which doesn't have the mitmproxy CA. You must `COPY` it in and run `update-ca-certificates`.

Missing the CA at any single layer causes that layer's HTTPS connections to fail with `certificate signed by unknown authority`, while the other layers work fine. This makes it look like "some requests work and some don't" — a confusing symptom if you don't realize each layer is independent.

### Q: Does `--privileged` on a Docker container enable IP forwarding and allow it to reach external IPs?

**A:** No. `--privileged` gives the container full access to the host's devices, allows it to create nested namespaces, manage cgroups, and mount filesystems. It's required for DinD to run a Docker daemon inside a container.

IP forwarding and external routing work identically for privileged and unprivileged containers. Docker sets up the bridge network, NAT/masquerade iptables rules, and IP forwarding as part of its normal networking setup when creating any container. An unprivileged `docker run alpine ping google.com` works fine — the packet goes through `172.17.0.1`, gets masqueraded to the host's IP, and reaches the internet. `--privileged` doesn't change any of this routing behavior.
