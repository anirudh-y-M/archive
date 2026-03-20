---
title: "Summary: HTTP Connection Behavior, Multiplexing, and gRPC Scaling in Go"
---

> **Full notes:** [[notes/Networking/HTTP_GRPC_connections|HTTP Connection Behavior, Multiplexing, and gRPC Scaling -->]]

## Key Concepts

- **`http.Client` is lazy**: Creating an `http.Client{}` in Go opens zero TCP connections. Connections are established on the first request by `http.Transport`.

- **HTTP/1.1 -- one request per connection**: Supports keep-alive (reuse connection sequentially) but cannot multiplex. Concurrent goroutines open many TCP connections, each with its own handshake cost. Head-of-line blocking is per-connection.

- **HTTP/2 -- multiplexed streams**: Multiple requests/responses share a single TCP connection via stream IDs. Go uses HTTP/2 automatically if the server supports it. 1000 goroutines may share one connection.

- **TCP head-of-line blocking remains**: HTTP/2 solves HTTP-level blocking but a lost TCP packet still delays all streams. HTTP/3 (QUIC over UDP) eliminates this.

- **gRPC advantages**: Built on HTTP/2 + Protobuf (binary, smaller, faster). Persistent channels, built-in streaming (unary, server, client, bidirectional), per-stream flow control.

## Quick Reference

| Aspect | HTTP/1.1 | HTTP/2 | gRPC |
|---|---|---|---|
| Connections per host | Many (1 per concurrent req) | Few (1 with many streams) | Very few (persistent channel) |
| Serialization | Text/JSON | Binary framing | Protobuf (very compact) |
| Streaming | No | Yes | Yes, native |
| Flow control | None (app level) | Per-stream | Per-stream |

**Go best practices:**
- Reuse a single `http.Client` (never create inside a loop)
- Tune `MaxConnsPerHost` for HTTP/1.1 workloads
- Use one gRPC channel, make RPCs through it

## Key Takeaways

- Never create a new `http.Client` per request -- the transport pool is the expensive part.
- HTTP/2 multiplexing dramatically reduces handshake overhead for concurrent requests.
- gRPC scales best due to persistent connections + binary encoding + native streaming.
- Go auto-negotiates HTTP/2 via TLS ALPN if the server supports it.
- TCP-level head-of-line blocking is the fundamental limitation HTTP/2 cannot solve (that's what QUIC/HTTP/3 addresses).
