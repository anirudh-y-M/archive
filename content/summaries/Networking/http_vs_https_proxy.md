---
title: "Summary: HTTP vs HTTPS Forward Proxy"
---

> **Full notes:** [[notes/Networking/http_vs_https_proxy|HTTP vs HTTPS Forward Proxy -->]]

## Key Concepts

### What is a Forward Proxy

A forward proxy sits between a client and the internet (`Client -> Proxy -> Server`). The client knows about the proxy and explicitly sends requests to it. The proxy forwards them to the destination server.

### HTTP Proxy vs HTTPS Proxy

The difference is **how the client connects to the proxy**, not what the proxy can access. An HTTP proxy uses plaintext between client and proxy; an HTTPS proxy uses TLS for that hop. Both can handle HTTP websites, HTTPS websites, and other TCP protocols via CONNECT.

| Type | Client-Proxy | Can Handle HTTP? | Can Handle HTTPS? |
|------|-------------|-----------------|-------------------|
| HTTP Proxy | Plaintext | Yes (forward) | Yes (via CONNECT) |
| HTTPS Proxy | TLS | Yes (forward) | Yes (via CONNECT) |

### How Proxies Handle HTTP Traffic (Forwarding)

For HTTP websites, the proxy is **protocol-aware**. The client sends `GET http://example.com/page HTTP/1.1` directly to the proxy. The proxy parses the HTTP request, can modify headers, cache responses, log, block, and sends a new request to the server. The proxy fully understands the content and can optimize it.

### How Proxies Handle HTTPS Traffic (CONNECT Tunneling)

For HTTPS sites, the client sends `CONNECT example.com:443 HTTP/1.1`. The proxy responds `200 Connection Established`, opens a raw TCP connection to the server, and starts forwarding bytes blindly. After the CONNECT handshake, the proxy does not parse HTTP, does not decrypt TLS -- it just calls `recv(bytes)` and `send(bytes)`. The TLS handshake happens end-to-end between client and server through this tunnel.

### Tunneling vs Forwarding

Normal forwarding: proxy understands HTTP, recreates requests, can cache and modify. Tunneling: proxy does not understand the payload, does not terminate the inner protocol, just relays bytes as a blind TCP pipe. The analogy: outer envelope = TLS to proxy, inner locked safe = TLS to server, proxy opens the envelope and forwards the safe unopened.

### Double TLS with HTTPS Proxy + HTTPS Server

When using an HTTPS proxy to access an HTTPS site, data is encrypted in two layers: `[TLS to Proxy [TLS to Server [HTTP data]]]`. The proxy decrypts only the outer layer -- the inner TLS blob passes through untouched. Both encryption layers remain active for the entire connection lifetime, not just during setup. The TLS handshake is one-time, but encryption is continuous.

### What the Proxy Sees in HTTPS Tunneling

Proxy can see: destination host:port, timing, traffic size, TLS handshake metadata (SNI). Proxy cannot see: HTTP method, headers, URL path, body, cookies -- unless MITM is used.

### VPN Similarity

HTTPS proxy + HTTPS site behaves like a VPN: outer TLS = VPN tunnel, inner TLS = HTTPS. Both layers are active simultaneously.

### CONNECT for Non-HTTPS Use Cases

CONNECT means "open a TCP connection to host:port and relay bytes" -- it does not require TLS. It can tunnel SSH, Git, database connections, or any TCP protocol. However, using CONNECT for HTTP sites is usually counterproductive: the proxy loses visibility (no caching, no optimization, no logging, no connection reuse). Browsers automatically use normal proxying for HTTP and CONNECT for HTTPS.

CONNECT to HTTP can be useful to: bypass broken middleboxes that inject ads or modify headers, tunnel non-HTTP protocols (SSH, databases, custom protocols), or protect the first hop on hostile WiFi (HTTPS proxy + CONNECT to HTTP server -- traffic is encrypted to the proxy but plain on the internet).

### HTTPS MITM Proxy

Different from normal proxying. The proxy presents a **fake certificate** (client must trust the proxy's CA), decrypts traffic, inspects it fully, re-encrypts to the server. This is **TLS termination + re-origination**, not tunneling. The proxy sees everything: method, headers, URL, body, cookies. Used in corporate firewalls, antivirus, and content inspection.

### Performance of Double TLS

Slight extra CPU but negligible on modern systems. TLS 1.3 is optimized for speed, and long-lived connections amortize handshake cost. Common in zero-trust networks, enterprise gateways, and cloud egress proxies.

## Quick Reference

```
Mental Model:
  HTTP proxy      -->  Smart HTTP middleman (parses, caches, modifies)
  CONNECT tunnel  -->  Blind TCP pipe (recv bytes, send bytes)
  HTTPS proxy     -->  Encrypted pipe to the proxy itself
  MITM proxy      -->  Fake TLS endpoint (decrypts, inspects, re-encrypts)

Double TLS layers (HTTPS proxy + HTTPS site):
  [TLS to Proxy [TLS to Server [HTTP data]]]
  Proxy decrypts outer layer only, forwards inner TLS blob unchanged
```

| Proxy Type | Client-Proxy | HTTP Sites | HTTPS Sites | Sees Content? |
|------------|-------------|------------|-------------|---------------|
| HTTP Proxy | Plaintext | Forward (parse) | CONNECT (tunnel) | HTTP: yes, HTTPS: no |
| HTTPS Proxy | TLS | Forward (parse) | CONNECT (tunnel) | HTTP: yes, HTTPS: no |
| MITM Proxy | TLS (fake cert) | Forward | TLS terminate + re-originate | Yes (all) |

## Key Takeaways

- HTTP vs HTTPS proxy differs only in client-to-proxy encryption, not in what they can access. Both handle HTTP and HTTPS destinations.
- CONNECT creates a raw TCP tunnel -- the proxy becomes a blind byte relay, no HTTP parsing, no decryption of the inner TLS.
- With HTTPS proxy + HTTPS site, there are two TLS layers. The proxy only decrypts the outer one. Encryption is continuous, not just at setup.
- MITM proxies require the client to trust the proxy's CA. They terminate and re-originate TLS, gaining full visibility. This is a fundamentally different architecture from tunneling.
- CONNECT can tunnel any TCP protocol (SSH, databases, etc.), not just HTTPS. But for HTTP, normal forwarding is better because the proxy retains caching/logging.
- Browsers automatically use normal proxying for HTTP and CONNECT for HTTPS.
- Double TLS performance impact is negligible on modern hardware with TLS 1.3.
