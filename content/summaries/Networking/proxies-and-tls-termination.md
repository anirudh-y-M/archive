---
title: "Summary: Proxies & TLS Termination"
---

> **Full notes:** [[notes/Networking/proxies-and-tls-termination|Proxies & TLS Termination -->]]

## Key Concepts

**Forward Proxy** -- Sits in front of clients. Client knows about it and sends traffic through it (e.g., `HTTPS_PROXY`). Used for controlling outbound access, caching, observability.

**Reverse Proxy** -- Sits in front of servers. Client doesn't know it exists. Used for load balancing, SSL offloading, routing. Examples: nginx, Envoy in front of backends.

**Network Layers** -- L3 (IP addresses, Cloud NAT), L4 (TCP/UDP ports, firewalls), L7 (HTTP, full request visibility). Higher layer = more the proxy can see and do.

**TLS Termination** -- The proxy decrypts the encrypted tunnel, reads plaintext HTTP, then opens a new encrypted connection to the real server. Requires injecting the proxy's CA certificate into the client's trust store. The proxy sees everything: URLs, headers, tokens, bodies.

**CONNECT Tunnel Mode** -- Proxy relays TCP bytes without decrypting. Sees only the destination hostname (SNI) and connection success/failure. No CA cert injection needed. Less visibility but simpler.

**Envoy** -- High-performance C++ L7 proxy. Config: Listeners, Routes, Clusters, Filters. Production-grade but verbose YAML config.

**mitmproxy** -- Python-based HTTPS inspection proxy. Easy setup, Python scripting for addons, built-in web UI. Lower throughput, good for debugging.

**Athens Proxy** -- Go module caching proxy. Reduces direct GitHub requests for `go mod download`. Only helps if workflows set `GOPROXY`.

## Quick Reference

```
Without TLS termination:    Client ---- encrypted ---- Server
                                  (proxy sees SNI only)

With TLS termination:       Client -- tunnel 1 -- Proxy -- tunnel 2 -- Server
                                  (proxy sees plaintext HTTP)
```

| Proxy     | Language | TLS Termination | Best For              |
|-----------|----------|------------------|-----------------------|
| Envoy     | C++      | Yes              | Production, high load |
| mitmproxy | Python   | Yes              | Debugging, scripting  |
| Athens    | Go       | N/A (app-level)  | Go module caching     |

**Two certs in TLS termination:**
1. **CA cert (root)** -- installed on clients once, stays the same
2. **Leaf cert** -- generated per destination on the fly, signed by CA cert

## Key Takeaways

- TLS termination gives full HTTP visibility (status codes, headers, bodies) but the proxy sees all secrets in memory -- acceptable for debugging, risky for production.
- Without TLS termination (CONNECT/tunnel mode), you only get hostname + connection-level success/failure -- much simpler, no CA injection.
- Forward proxy = client-aware (outbound control); reverse proxy = server-side (load balancing, SSL offload).
- For CI debugging, mitmproxy is the fastest path to visibility. For long-term production, Envoy is more appropriate.
