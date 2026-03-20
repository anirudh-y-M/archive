---
title: "Summary: HTTP Connection Behavior, Multiplexing, and gRPC Scaling in Go"
---

> **Full notes:** [[notes/Networking/HTTP_GRPC_connections|HTTP Connection Behavior, Multiplexing, and gRPC Scaling -->]]

## Key Concepts

### Definitions

**TCP Connection** -- established via three-way handshake + TLS handshake (for HTTPS). **HTTP/1.1** -- text-based, one request/response per connection at a time. **HTTP/2** -- binary frame-based, supports multiplexed streams on a single connection. **gRPC** -- high-performance RPC built on HTTP/2 + Protobuf, encourages connection reuse and streaming.

### Go's HTTP Client Does Not Open a Connection on Creation

`http.Client{}` is just a config struct. The actual connection pool, DNS resolution, TCP handshakes, and reuse are managed by `http.Transport` (defaults to `http.DefaultTransport`). No TCP connection is opened until the first request is made via `client.Do(req)` or `client.Get()`.

### TCP Handshakes Only Happen on Request

When you call `client.Get("https://example.com")`, Go resolves DNS, opens a TCP connection (three-way handshake), performs TLS handshake, then sends the HTTP request. Connection establishment is lazy -- deferred until actually needed.

### HTTP/1.1 Behavior

HTTP/1.1 supports Keep-Alive (reuse a connection for sequential requests) but only allows **one in-flight request per connection**. This causes **Head-of-Line (HoL) blocking** -- if Request1 is slow, subsequent requests must wait. For concurrent goroutines (`go client.Do(req)` in a loop), Go opens nearly one TCP connection per goroutine because HTTP/1.1 cannot multiplex. `http.Transport` has tuning knobs: `MaxIdleConns`, `MaxIdleConnsPerHost`, `MaxConnsPerHost` (0 = unlimited). If `MaxConnsPerHost` is low, excess requests queue.

### HTTP/2 Multiplexing

HTTP/2 breaks requests and responses into **small frames** tagged with **stream IDs**, interleaving them on a single TCP connection. Multiple requests/responses travel concurrently without waiting. One TCP/TLS handshake serves many parallel streams. Go auto-negotiates HTTP/2 via TLS ALPN if the server supports it -- 1000 goroutines may share one connection. If the server caps concurrent streams (`SETTINGS_MAX_CONCURRENT_STREAMS`), excess streams wait but still reuse the same connection.

### TCP Head-of-Line Blocking Revisited

HTTP/2 removes HoL blocking at the HTTP layer, but TCP-level HoL blocking remains: if a TCP packet is lost, the kernel delays delivery of all subsequent packets in that connection until retransmission succeeds. This affects all streams on that connection. HTTP/3 (QUIC over UDP) eliminates this by giving each stream its own independent delivery channel.

### How Go Uses HTTP/2

Go's default `http.Client` uses HTTP/2 automatically if the server supports it. It uses one TCP connection per host and many concurrent streams. Only one handshake cost. If a server caps concurrent streams, extra streams wait but reuse the connection.

### Why gRPC Scales Better

gRPC builds on HTTP/2 and adds: **(1) Persistent connections** -- long-lived channels with hundreds/thousands of RPCs reusing one connection. **(2) Binary protocol (Protobuf)** -- smaller than JSON, faster to serialize/deserialize, less bandwidth and CPU. **(3) Built-in streaming** -- unary, server streaming, client streaming, bidirectional streaming, avoiding repeated polling and connection churn. **(4) Flow control & backpressure** -- HTTP/2 per-stream flow control prevents flooding. **(5) Lower resource overhead** -- avoids multiple TCP/TLS handshakes, many ephemeral ports, many OS file descriptors.

### Best Practices in Go

Always reuse a single `http.Client` (never create inside a loop -- each creates a separate transport pool). For HTTP/1.1 with high concurrency, tune `MaxConnsPerHost`. For gRPC, use one channel and make RPC calls through it.

## Quick Reference

```
HTTP/1.1:   [Req1 --> Res1] [Req2 --> Res2]   sequential per connection
HTTP/2:     [Req1 | Req2 | Req3 | Res2 | Res1 | ...]  interleaved frames, one connection
```

| Aspect | HTTP/1.1 + REST | HTTP/2 (Go) | gRPC |
|---|---|---|---|
| Handshake Cost | Many (1 per concurrent req) | Few (1 conn, many streams) | Very few (persistent channel) |
| Concurrency | Multiple connections | Multiplexed streams | Multiplexed + streaming |
| Protocol Overhead | High (text/JSON) | Lower (binary framing) | Very low (Protobuf) |
| Flow Control | None at app level | Yes (per-stream) | Yes (per-stream) |
| Streaming | No | Yes | Yes, built-in (4 patterns) |

**Go Transport tuning:**
```go
transport := &http.Transport{
    MaxIdleConns:        100,
    MaxIdleConnsPerHost: 100,
    MaxConnsPerHost:     0, // 0 = unlimited
}
```

## Key Takeaways

- `http.Client` creation opens zero connections -- connections are lazy, managed by `http.Transport`.
- HTTP/1.1 needs multiple TCP connections for concurrency (one in-flight request per connection), each with handshake cost.
- HTTP/2 multiplexes many concurrent streams on a single TCP connection via stream IDs. Go auto-negotiates it via TLS ALPN.
- TCP-level HoL blocking persists in HTTP/2 (lost packet delays all streams). HTTP/3 (QUIC/UDP) solves this.
- gRPC scales best: HTTP/2 multiplexing + Protobuf binary encoding + native streaming + per-stream flow control.
- Never create `http.Client` inside a loop -- reuse one client with a shared transport pool.
- For HTTP/1.1 concurrency, tune `MaxConnsPerHost`. For gRPC, use one persistent channel.
