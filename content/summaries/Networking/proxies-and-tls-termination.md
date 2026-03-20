---
title: "Summary: Proxies & TLS Termination"
---

> **Full notes:** [[notes/Networking/proxies-and-tls-termination|Proxies & TLS Termination -->]]

## Key Concepts

### What is a Proxy

A proxy is a middleman between client and server. Instead of the client talking directly, it talks to the proxy, which forwards the request and relays the response.

### Forward Proxy vs Reverse Proxy

A **forward proxy** sits in front of clients. The client knows about it and sends traffic through it (e.g., via `HTTPS_PROXY`). Used for controlling outbound access, caching, and observability. A **reverse proxy** sits in front of servers. The client doesn't know the proxy exists -- it thinks it's talking to the real server. Used for load balancing, SSL offloading, and routing. Example: nginx or Envoy in front of a web app.

### Network Layers (L3, L4, L7)

**L3 (Network):** IP addresses. Cloud NAT operates here. **L4 (Transport):** TCP/UDP ports. Firewalls and basic load balancers operate here. **L7 (Application):** HTTP -- full request details (URLs, headers, status codes, bodies). Envoy, mitmproxy, and nginx operate here. The higher the layer, the more the proxy can see. Cloud NAT (L3/L4) can't tell you GitHub returned a 401; an L7 proxy can.

### TLS and HTTPS

TLS encrypts HTTP into HTTPS. Client and server do a TLS handshake, exchange keys, and all traffic is encrypted end-to-end. A proxy in the middle cannot see the content unless it "terminates" the TLS.

### TLS Termination

TLS termination is where the encrypted tunnel ends. With a proxy doing TLS termination, the client's encrypted tunnel ends at the proxy. The proxy decrypts the traffic, reads plain HTTP, then opens a new encrypted connection to the real server. This is also called MITM (man-in-the-middle).

```
Without: Client ──── encrypted tunnel ──── Server
With:    Client ── tunnel 1 ── Proxy ── tunnel 2 ── Server
                     (ends here)   (new tunnel starts)
```

### How the Client Trusts the Proxy

The proxy generates a fake certificate for each destination (e.g., "I'm github.com"), signed by the proxy's own CA. Two certs are involved: (1) **CA cert (root)** -- generated once, installed on clients, stays the same; (2) **Per-site leaf cert** -- generated on the fly for each destination, signed by the CA cert. The client trusts the CA, so it automatically trusts any leaf cert signed by it.

### Security Implications

With TLS termination, the proxy sees everything in plaintext: full URLs, authorization headers (tokens, passwords), request/response bodies. Secrets can be masked in logs, but the proxy process itself sees them in memory. Acceptable for short-term debugging; a risk surface for long-term production.

### Envoy

High-performance C++ L7 proxy (behind Istio and many service meshes). Four main config concepts: **Listener** (port Envoy listens on), **Route** (forwarding rules by destination), **Cluster** (upstream server group), **Filter** (processing steps like logging, header manipulation, Lua scripts). Deployed as a DaemonSet for CI observability. Production-grade, high throughput, but verbose YAML config.

### mitmproxy

Python-based interactive HTTPS proxy for traffic inspection. Easier setup than Envoy -- runs out of the box, auto-generates CA certs. Python scripting for addons (simpler than Lua). Built-in web UI (`mitmweb`). Lower throughput (single-threaded Python). K8s setup: deploy as DaemonSet, mount CA cert as Secret, inject into runner pods, set `HTTPS_PROXY`, write Python addons to mask authorization headers.

### Without TLS Termination (Tunnel/CONNECT Mode)

Both Envoy and mitmproxy can run as CONNECT proxies without terminating TLS. The proxy sees the destination hostname (from SNI) and connection-level success/failure, but NOT HTTP status codes, URLs, or headers. No CA cert injection needed. Simpler, but less visibility -- enough if you only need "which host is this runner connecting to."

### Athens Proxy (Go Modules)

Not a general HTTP proxy -- specifically for Go module downloads. Caches Go modules so `go mod download` doesn't hit GitHub every time. Configured via `GOPROXY`. When Go needs a module, it asks Athens first; if cached, it returns immediately without a GitHub request. Key gap: only helps if the workflow sets `GOPROXY`. Workflows that don't (like CodeQL's default) bypass Athens.

## Quick Reference

```
Without TLS termination:    Client ---- encrypted ---- Server
                                  (proxy sees SNI only)

With TLS termination:       Client -- tunnel 1 -- Proxy -- tunnel 2 -- Server
                                  (proxy sees plaintext HTTP)
```

| Proxy | Language | TLS Termination | Best For |
|---|---|---|---|
| Envoy | C++ | Yes | Production, high load |
| mitmproxy | Python | Yes | Debugging, scripting |
| Athens | Go | N/A (app-level) | Go module caching |

| Layer | Sees | Examples |
|---|---|---|
| L3 | IP addresses | Cloud NAT |
| L4 | TCP/UDP ports | Firewalls, basic LBs |
| L7 | Full HTTP (URLs, headers, bodies) | Envoy, mitmproxy, nginx |

**Two certs in TLS termination:**
1. **CA cert (root)** -- installed on clients once, stays the same
2. **Leaf cert** -- generated per destination on the fly, signed by CA cert

## Key Takeaways

- TLS termination gives full HTTP visibility (status codes, headers, bodies) but the proxy sees all secrets in memory -- acceptable for debugging, risky for production.
- Without TLS termination (CONNECT/tunnel mode), you only get hostname + connection-level success/failure -- much simpler, no CA injection needed.
- Forward proxy = client-aware (outbound control); reverse proxy = server-side (load balancing, SSL offload). Client knows about forward proxies; doesn't know about reverse proxies.
- For CI debugging, mitmproxy is the fastest path to visibility. For long-term production, Envoy is more appropriate.
- Athens caches Go modules to reduce GitHub requests, but only works if `GOPROXY` is set in the workflow.
- The higher the network layer a proxy operates at, the more it can see and do. L7 gives full HTTP request/response visibility.
