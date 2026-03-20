---
title: "Summary: HTTP vs HTTPS Forward Proxy"
---

> **Full notes:** [[notes/Networking/http_vs_https_proxy|HTTP vs HTTPS Forward Proxy -->]]

## Key Concepts

- **Forward proxy**: Sits between client and internet. Client explicitly sends requests through it.

- **HTTP vs HTTPS proxy**: The difference is whether the **client-to-proxy** connection is encrypted, NOT what sites the proxy can access. Both can handle HTTP and HTTPS destinations.

- **CONNECT method**: Client asks proxy to open a raw TCP tunnel to a destination. Proxy becomes a blind byte relay. Used for HTTPS sites (TLS passes through untouched) and any TCP protocol (SSH, database, etc.).

- **Tunneling**: After CONNECT, the proxy forwards opaque bytes without inspecting, decrypting, or modifying them.

- **Double TLS**: With HTTPS proxy + HTTPS site, there are two TLS layers -- outer (client-to-proxy) and inner (client-to-server). Proxy decrypts only the outer layer.

- **MITM proxy**: Terminates TLS, presents a fake cert (trusted by client), decrypts and re-encrypts traffic. Full visibility. Used in corporate firewalls, antivirus.

## Quick Reference

```
Mental Model:
  HTTP proxy      --> Smart HTTP middleman (parses, caches, modifies)
  CONNECT tunnel  --> Blind TCP pipe (raw byte relay)
  HTTPS proxy     --> Encrypted pipe to the proxy
  MITM proxy      --> Fake TLS endpoint (sees everything)
```

| Proxy Type | Client-Proxy | Can See Content? | HTTPS Sites |
|------------|-------------|-----------------|-------------|
| HTTP proxy | Plaintext | HTTP: yes, HTTPS: no | Via CONNECT tunnel |
| HTTPS proxy | TLS encrypted | HTTP: yes, HTTPS: no | Via CONNECT tunnel |
| MITM proxy | TLS (fake cert) | Everything | Terminates + re-encrypts |

**What proxy sees during HTTPS tunneling:** destination host:port, timing, traffic size, TLS SNI. Does NOT see: HTTP method, headers, URL path, body, cookies.

## Key Takeaways

- Both HTTP and HTTPS proxies handle both HTTP and HTTPS sites -- the difference is only client-to-proxy encryption.
- CONNECT creates a raw TCP tunnel; the proxy cannot inspect the encrypted content passing through.
- Browsers automatically use normal proxying for HTTP sites and CONNECT for HTTPS sites.
- Double TLS (HTTPS proxy + HTTPS site) has negligible performance impact on modern systems.
- MITM proxies require the client to trust the proxy's CA certificate -- this is a completely different architecture from normal tunneling.
