---
title: HTTP vs HTTPS Forward Proxy — Complete Q&A Guide
---

# 1️⃣ What is a Forward Proxy?

A **forward proxy** sits between a client and the internet.

```
Client → Proxy → Internet Server
```

* The client **knows** about the proxy.
* The client explicitly sends requests to it.
* The proxy forwards them to the destination server.

---

# 2️⃣ What is the difference between an HTTP proxy and an HTTPS proxy?

The difference is **how the client connects to the proxy**, not what the proxy can access.

| Type        | Client → Proxy Connection | Encryption      |
| ----------- | ------------------------- | --------------- |
| HTTP Proxy  | Plain HTTP                | ❌ No encryption |
| HTTPS Proxy | TLS (HTTPS)               | ✅ Encrypted     |

Both can handle:

* HTTP websites
* HTTPS websites
* Other TCP protocols (via CONNECT)

---

# 3️⃣ Can both HTTP and HTTPS proxies handle HTTP and HTTPS requests?

Yes.

| Proxy Type  | HTTP Website | HTTPS Website       |
| ----------- | ------------ | ------------------- |
| HTTP Proxy  | ✅ Yes        | ✅ Yes (via CONNECT) |
| HTTPS Proxy | ✅ Yes        | ✅ Yes (via CONNECT) |

The difference is only whether **client → proxy** is encrypted.

---

# 4️⃣ How does a proxy handle HTTP websites?

### Normal HTTP forwarding:

```
Client → Proxy → Server
```

Client sends:

```
GET http://example.com/page HTTP/1.1
Host: example.com
```

Proxy:

* Parses HTTP request
* Can modify headers
* Can cache
* Can log
* Can block
* Sends a new HTTP request to server

Proxy is **protocol-aware**.

---

# 5️⃣ How does a proxy handle HTTPS websites?

Using the `CONNECT` method.

Client sends:

```
CONNECT example.com:443 HTTP/1.1
Host: example.com
```

Proxy responds:

```
HTTP/1.1 200 Connection Established
```

After this:

```
Client ⇄ Proxy ⇄ Server
```

Proxy:

* Opens TCP connection to server
* Forwards raw bytes
* Does NOT parse HTTP
* Does NOT decrypt TLS

This is called **tunneling**.

---

# 6️⃣ What is tunneling?

Tunneling means:

* Proxy forwards raw TCP bytes
* Proxy does NOT understand the protocol inside
* Proxy does NOT terminate the inner protocol
* Proxy acts as a blind relay

After CONNECT:

```
Client ==encrypted bytes==> Proxy ==same bytes==> Server
```

The proxy:

```
recv(bytes)
send(bytes)
```

No parsing. No inspection.

---

# 7️⃣ Is data encrypted twice with HTTPS proxy + HTTPS server?

Yes — on the wire, but in layers.

Structure:

```
encrypt_for_proxy(
    encrypt_for_server(
        HTTP data
    )
)
```

### Layer 1:

TLS between client and proxy

### Layer 2:

TLS between client and server

So on the wire:

```
[TLS to Proxy
    [TLS to Server
        HTTP
    ]
]
```

---

# 8️⃣ Does the proxy decrypt both layers?

No.

At proxy:

* Proxy decrypts only **client ↔ proxy TLS**
* What remains is encrypted **client ↔ server TLS**
* Proxy cannot read inner HTTPS content

---

# 9️⃣ Is client-proxy encryption only during setup?

No.

Only the handshake is one-time.

Encryption remains active for the entire connection.

| Event                      | One-time | Continuous |
| -------------------------- | -------- | ---------- |
| TLS handshake              | ✅        | ❌          |
| CONNECT setup              | ✅        | ❌          |
| Client ↔ Proxy encryption  | ❌        | ✅          |
| Client ↔ Server encryption | ❌        | ✅          |

---

# 🔟 Why is it called tunneling and not forwarding?

### Normal forwarding:

Proxy understands HTTP and recreates requests.

### Tunneling:

Proxy:

* Does not understand payload
* Does not terminate protocol
* Just relays bytes

That’s why it’s called a **TCP tunnel**.

Analogy:

* Outer envelope = TLS to proxy
* Inner locked safe = TLS to server
* Proxy opens envelope, forwards safe unopened

---

# 1️⃣1️⃣ What is HTTPS MITM proxy?

Different from normal proxy.

```
Client ==TLS==> Proxy ==TLS==> Server
```

But:

* Proxy presents fake certificate
* Client trusts proxy CA
* Proxy decrypts and re-encrypts traffic
* Proxy sees everything

This is **not tunneling**.
This is **TLS termination + re-origination**.

Used in:

* Corporate firewalls
* Antivirus
* Content inspection

---

# 1️⃣2️⃣ Can CONNECT be used when proxy → server is plain HTTP?

Yes.

CONNECT just means:

> “Open a TCP connection to host:port and relay bytes.”

It does not require TLS.

Example:

```
Client ==CONNECT==> Proxy ==TCP==> Server:80
```

Client can then send:

* HTTP
* SSH
* Anything TCP

---

# 1️⃣3️⃣ Is using CONNECT for HTTP websites beneficial?

Usually no.

### Normal HTTP proxy:

* Can cache
* Can optimize
* Can log
* Can rewrite
* Can reuse connections

### CONNECT for HTTP:

* Proxy loses visibility
* No caching
* No optimization
* Just becomes TCP relay

So browsers do:

* HTTP → normal proxying
* HTTPS → CONNECT

---

# 1️⃣4️⃣ When is CONNECT to HTTP useful?

### 1. To bypass broken middleboxes

If network:

* Injects ads
* Modifies headers
* Blocks URLs

CONNECT hides traffic from local inspection.

---

### 2. To tunnel non-HTTP protocols

Examples:

* SSH over HTTP proxy
* Git over TCP
* Database connections
* Custom protocols

This is the real power of CONNECT.

---

### 3. With HTTPS proxy (protect first hop)

```
Client ==TLS==> Proxy ==TCP==> Server:80
```

* Protects traffic on Wi-Fi / ISP
* But traffic is still unencrypted on internet

---

# 1️⃣5️⃣ What does the proxy actually see in HTTPS tunneling?

Proxy sees:

* Destination host:port
* Timing
* Traffic size
* TLS handshake metadata (SNI)

Proxy does NOT see:

* HTTP method
* Headers
* URL path
* Body
* Cookies

Unless MITM is used.

---

# 1️⃣6️⃣ Is this similar to VPN?

Yes.

HTTPS proxy + HTTPS site behaves like:

* Outer TLS = VPN tunnel
* Inner TLS = HTTPS

Both active simultaneously.

---

# 1️⃣7️⃣ Performance impact of double TLS?

* Slight extra CPU
* Negligible in modern systems
* TLS 1.3 optimized
* Long-lived connections reduce handshake cost

Common in:

* Zero trust networks
* Enterprise gateways
* Cloud egress proxies

---

# 1️⃣8️⃣ Final Summary

### HTTP Proxy

* Client → Proxy not encrypted
* Parses HTTP
* Uses CONNECT for HTTPS
* Can cache/modify HTTP

### HTTPS Proxy

* Client → Proxy encrypted
* More secure on hostile networks
* Still uses CONNECT for HTTPS sites

### CONNECT

* Creates raw TCP tunnel
* Proxy forwards opaque bytes
* Used for HTTPS and any TCP protocol

### Tunneling

* Proxy is blind relay
* Does not terminate inner protocol
* Just forwards bytes

### MITM Proxy

* Terminates TLS
* Decrypts traffic
* Re-encrypts to server
* Full visibility

---

# 🔥 One Ultimate Mental Model

```
Normal HTTP proxy → Smart HTTP middleman
CONNECT tunnel → Blind TCP pipe
MITM proxy → Fake TLS endpoint
HTTPS proxy → Encrypted pipe to the proxy
```

---

## See also

- [[notes/Networking/proxies-and-tls-termination|Proxies & TLS Termination]] — forward vs reverse proxy, L3/L4/L7 layers, Envoy, mitmproxy, Athens Go proxy
- [[notes/Networking/tls-1.3-handshake|TLS 1.3 Handshake]] — wire-level TLS 1.3 handshake, certificate chain of trust, ECDHE key exchange
