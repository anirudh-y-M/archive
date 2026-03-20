---
title: "Summary: End-to-End HTTPS Flow: Content-Length vs Chunked vs HTTP/2"
---

> **Full notes:** [[notes/Networking/https-tcp-tls-flow-content-length-vs-chunked-vs-http2|End-to-End HTTPS Flow -->]]

## Key Concepts

- **Three scenarios compared**: HTTP/1.1 with Content-Length (file download), HTTP/1.1 with chunked encoding (streaming), and HTTP/2 with multiplexed streams -- all sharing the same DNS, TCP, and TLS layers.

- **DNS + TCP + TLS are identical** across all three. The only TLS difference is ALPN negotiation (`http/1.1` vs `h2`). TCP has no awareness of the HTTP version above it.

- **Content-Length**: Server knows full size upfront. Client can show progress bar, resume via Range requests. Continuous TCP segment blast.

- **Chunked encoding**: Server sends data in hex-prefixed chunks as it's generated. No progress bar, no Range resume. Sparse TCP bursts with idle gaps.

- **HTTP/2**: Binary framing with 9-byte frame headers. HPACK header compression. Multiplexed streams (100+ concurrent) on one TCP connection. Flow control at both per-stream and per-connection levels.

## Quick Reference

| Aspect | Content-Length | Chunked | HTTP/2 |
|--------|---------------|---------|--------|
| Size known upfront | Yes | No | Optional |
| End-of-body signal | Byte count match | Zero-length chunk `0\r\n\r\n` | END_STREAM flag |
| Concurrent requests | 1 per connection | 1 per connection | 100+ streams |
| Header compression | None | None | HPACK |
| Range/resume | Yes | No | Yes (if supported) |
| HOL blocking | Yes (HTTP layer) | Yes | No at HTTP layer, yes at TCP layer |

```
TCP Segment Patterns:
  Content-Length:  ████████████████████████  (continuous blast)
  Chunked:         █···█····█·······█···█··  (sparse bursts)
  HTTP/2:          ██████████████████████    (interleaved frames)

HTTP/2 Frame (9-byte header):
  ┌─────────────────────────────────────────┐
  │ Length (24b) │ Type (8b) │ Flags (8b)   │
  │ R │     Stream Identifier (31b)         │
  │           Frame Payload                 │
  └─────────────────────────────────────────┘
```

## Key Takeaways

- TCP and TLS behave identically regardless of HTTP version -- the difference is purely in the HTTP framing layer.
- HTTP/2 eliminates HTTP-level HOL blocking via multiplexing, but TCP-level HOL blocking remains (lost packet stalls all streams). HTTP/3/QUIC solves this.
- HTTP/2 has two flow control layers (per-stream + per-connection) on top of TCP flow control -- a slow consumer on one stream can starve all streams if the connection window is exhausted.
- TLS 1.3 completes in 1 RTT (vs 2 for TLS 1.2) because the client sends its key share speculatively in ClientHello.
- HPACK compresses repeated headers to 1-2 bytes each after the first request, dramatically reducing overhead on the same connection.
