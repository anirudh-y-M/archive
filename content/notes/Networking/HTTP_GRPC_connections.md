---
title: "HTTP Connection Behavior, Multiplexing, and gRPC Scaling in Go"
---

# Problem

When working with networked services in Go (e.g., making HTTP requests), many developers assume that creating an `http.Client` immediately opens a TCP connection and that each `client.Do(req)` always opens a new connection. They also often misunderstand how HTTP/2 and gRPC scale under load.

This misunderstanding can lead to inefficient networking behavior, unnecessary connections, high CPU/TLS handshake costs, and poor scaling.

The goal here is to explain **how Go’s HTTP client actually manages connections**, how **HTTP/2 multiplexing works**, how that differs from HTTP/1.1, and why **gRPC scales better** — with clear examples and deep reasoning.

---

## ## Definitions

Before we dive deeper, here are key concepts:

- **TCP Connection:** A connection established between client and server over TCP, usually with a three-way handshake and (for HTTPS) a TLS handshake.
- **HTTP/1.1:** A version of HTTP where each connection typically handles only one request/response at a time.
- **HTTP/2:** A binary, frame-based HTTP version that supports multiple requests/responses concurrently on a single TCP connection via multiplexing.
- **Multiplexing:** Sending multiple independent streams (requests/responses) within the same TCP connection simultaneously.
- **gRPC:** A high-performance RPC framework built on HTTP/2 and Protocol Buffers (binary serialization) that encourages connection reuse and streaming.

---

## ## Go’s HTTP Client Does *Not* Open a TCP Connection on Creation

### `http.Client` vs `http.Transport`

In Go:

```go
client := &http.Client{}
```

👉 This **does not open a TCP connection** yet.
The `http.Client` is just a struct with config.

Connections are actually managed by:

```go
client.Transport
```

which defaults to `http.DefaultTransport`.

The Transport controls the connection pool, DNS resolution, TCP handshakes, and reuse.

**Summary:**

- Creating a client does *not* open a connection.
- A connection is opened only when you make your first request.

---

## ## TCP Handshakes Only Happen When a Request Is Made

When you do:

```go
resp, err := client.Get("https://example.com")
```

Go:

1. Resolves DNS
2. Opens a TCP connection (three-way handshake)
3. Performs TLS handshake (HTTPS)
4. Sends the HTTP request

Only now does the TCP connection get established.

---

## ## HTTP/1.1 Behavior

### No Multiplexing

HTTP/1.1 supports:

- Keep-Alive: reusing a connection for multiple sequential requests
- But **only one in-flight request per connection**

Example (sequential):

```text
Client → Request1 → Response1 → next request...
```

This leads to **Head-of-Line Blocking**:

> If Request1 takes long, subsequent requests must wait.

---

### Multiple Connections for Concurrency

When you do:

```go
for i := 0; i < 100; i++ {
    go client.Do(req)
}
```

Go may open:

- Many TCP connections,
- Almost one per goroutine, because HTTP/1.1 cannot handle multiple concurrent requests on a single connection.

`http.Transport` has adjustable limits:

```go
transport := &http.Transport{
    MaxIdleConns:        100,
    MaxIdleConnsPerHost: 100,
    MaxConnsPerHost:     0, // 0 means unlimited
}
```

If `MaxConnsPerHost` is low, extra requests wait.

**Summary:**

- HTTP/1.1 needs multiple TCP connections to do concurrent requests.
- Each connection has handshake cost and resource overhead.

---

## ## HTTP/2 Multiplexing Explained

### What is Multiplexing?

Instead of:

```text
Client sends request → waits → receives response → next request
```

HTTP/2 breaks requests/responses into **small frames** and tags them with **stream IDs**.

Frames are interleaved:

```
| Stream1 Frame | Stream2 Frame | Stream3 Frame | … |
```

This means:

- Multiple requests/responses go through the same connection at the same time.
- No waiting for previous responses.
- One TCP/TLS handshake for many parallel streams.

**The magic:** It supports **multiplexed streams** within one TCP connection.

---

## ## Key Difference: With vs Without Multiplexing

### Without Multiplexing (HTTP/1.1)

```
TCP Connection
--------------------------
| Req1→Res1 | Req2→Res2 |
--------------------------
```

Requests are **sequential** on a connection.

### With Multiplexing (HTTP/2)

```
Single TCP Connection
----------------------------------------
| Req1 | Req2 | Req3 | Res2 | Res1 | … |
----------------------------------------
```

All streams are processed without waiting.

---

## ## TCP Head-of-Line Blocking Revisited

HTTP/2 removes blocking *at the HTTP level*, but:

- If a **TCP packet is lost**, TCP delays delivery of later packets.
- This is still network-level blocking, but not protocol (application) blocking.

This is why HTTP/3 (QUIC) was designed later:

👉 It runs over UDP and removes this constraint.

---

## ## How Go Uses HTTP/2

Go’s default `http.Client`:

- Will use HTTP/2 automatically if the server supports it
- Uses one TCP connection per host
- Supports many concurrent streams

Example:

```go
for i := 0; i < 1000; i++ {
    go client.Do(req)
}
```

If the server supports HTTP/2:

- Go will likely use **one TCP connection**
- Many Go routines send requests as many **streams**
- Only one handshake cost

If a server caps concurrent streams, extra streams wait but reuse the connection.

---

## ## Why gRPC Scales Better

gRPC builds on HTTP/2 and adds several advantages:

### 1. **Persistent Connections**

- gRPC keeps a long-lived channel open.
- Hundreds/thousands of RPCs reuse one connection.

### 2. **Binary Protocol (Protobuf)**

- Smaller messages than JSON,
- Faster to serialize/deserialize,
- Less bandwidth, less CPU.

### 3. **Built-in Streaming**

gRPC supports:

- Unary calls
- Server streaming
- Client streaming
- Bidirectional streaming

This avoids repeated polling and connection churn.

### 4. **Flow Control & Backpressure**

HTTP/2 has per-stream flow control:

- Prevents flooding
- Efficient resource usage

Compared to REST over HTTP/1.1, this is much more scalable.

### 5. **Lower Resource Overhead**

gRPC avoids:

- Multiple TCP/TLS handshakes
- Many ephemeral ports
- Many OS file descriptors

---

## ## Detailed Advantages Summary


| Aspect            | HTTP/1.1 + REST      | HTTP/2 (Go)            | gRPC                    |
| ----------------- | -------------------- | ---------------------- | ----------------------- |
| Handshake Cost    | Many                 | Few                    | Very few                |
| Concurrency       | Multiple connections | Multiplexed streams    | Multiplexed & streaming |
| Protocol Overhead | High (text/JSON)     | Lower (binary framing) | Very low (Protobuf)     |
| Flow Control      | None at app level    | Yes                    | Yes                     |
| Streaming         | No                   | Yes                    | Yes, built-in           |


---

## ## Best Practice in Go

### Always reuse the same client:

```go
var client = &http.Client{}
```

Don’t do this:

```go
for i := 0; i < 100; i++ {
    client := &http.Client{}  // BAD
}
```

### If using HTTP/1.1 and high concurrency

Limit connection count:

```go
transport := &http.Transport{
    MaxConnsPerHost: 100,
}
```

### If using gRPC

Use one gRPC channel and make RPC calls through it.

---

## ## Final Takeaways

✔ `http.Client` creation alone does not open TCP connections
✔ HTTP/1.1: needs multiple connections for concurrency
✔ HTTP/2: supports multiplexing — concurrent streams on one connection
✔ Go automatically uses HTTP/2 if supported by server
✔ gRPC scales best because of HTTP/2 + binary frames + streaming support

---

If you’d like, I can turn this into a **cheatsheet**, a **template** you can copy into your own notes, or **example code** demonstrating connection reuse tuning in real Go projects.
