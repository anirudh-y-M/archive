---
title: "Summary: End-to-End HTTPS Flow: Content-Length vs Chunked vs HTTP/2"
---

> **Full notes:** [[notes/Networking/https-tcp-tls-flow-content-length-vs-chunked-vs-http2|End-to-End HTTPS Flow -->]]

## Key Concepts

### Overview

The note traces the complete lifecycle of an HTTPS request -- DNS, TCP handshake, TLS 1.3, HTTP request/response, body delivery, and teardown -- across three scenarios: HTTP/1.1 with Content-Length (50 MB file download), HTTP/1.1 with chunked encoding (streaming), and HTTP/2 with multiplexed streams. DNS, TCP, and TLS layers are nearly identical across all three; the differences emerge at the HTTP framing layer.

### Scenario 1: HTTP/1.1 with Content-Length

Full end-to-end flow: DNS lookup -> TCP 3-way handshake (SYN, SYN-ACK, ACK with MSS=1460, SACK, WScale) -> TLS 1.3 handshake (ClientHello with key_share/SNI/ALPN, ServerHello, EncryptedExtensions with ALPN `http/1.1`, Certificate, CertificateVerify, Finished -- 1-RTT) -> HTTP GET -> response with `Content-Length: 52428800`.

Body transfer: TLS records hold up to 16,384 bytes (each split into ~12 TCP segments of 1460 bytes). TCP slow start begins at cwnd=10 MSS, doubles each RTT (~5 RTTs to fill the pipe). Then congestion avoidance (linear growth). On a 100 Mbps/50ms link: BDP=625 KB, ~4 seconds to complete. Total: ~35,959 TCP segments. Client counts received bytes against Content-Length to know when done. Connection can be reused (keep-alive). Range requests supported for resume.

Teardown: TLS close_notify alerts, then TCP FIN/ACK (4-way). Client enters TIME_WAIT for 2xMSL (~60s).

### Scenario 2: HTTP/1.1 with Chunked Encoding

DNS, TCP, TLS identical. Response has `Transfer-Encoding: chunked` instead of Content-Length. Each chunk: hex-size + CRLF + data + CRLF. Terminated by zero-length chunk `0\r\n\r\n`. Optional trailers can appear after the last chunk.

```
Chunk: "400\r\n" + <1024 bytes> + "\r\n"  (total: 1031 bytes on wire)
End:   "0\r\n\r\n"                         (5 bytes)
```

TCP sends sparse bursts (1 segment per event, idle gaps). cwnd may decay during idle periods (RFC 7661). No progress bar possible (no total size). No Range requests. Connection reuse works after the terminator chunk. Nagle's algorithm can delay small chunks -- fix with `TCP_NODELAY`.

### Scenario 3: HTTP/2 with Multiplexed Streams

TLS differs only in ALPN result (`h2`). After TLS: HTTP/2 connection preface -- client sends 24-byte magic string `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n` + SETTINGS frame. Server sends its SETTINGS. Both exchange SETTINGS ACK.

Requests sent as HEADERS frames (HPACK-compressed) with odd stream IDs (1, 3, 5). Client sends multiple requests without waiting for responses. Responses interleave frame-by-frame -- stream 3 can complete while stream 1 is still sending DATA frames. Each frame has a 9-byte header: Length (24b) + Type (8b) + Flags (8b) + Stream ID (31b). END_STREAM flag marks the last frame.

HTTP/2 flow control: two levels -- per-stream window and per-connection window (stream 0). Default initial window: 65,535 bytes (RFC 9113 Section 6.9.2). Client sends WINDOW_UPDATE frames to extend. Connection close: GOAWAY frame with last stream ID, then TCP FIN/ACK.

### HPACK Header Compression

Static table: 61 predefined entries (e.g., `:method: GET` = 1 byte `0x82`). Dynamic table: headers from prior requests stored and referenced by index. First request: ~400 bytes of headers. Subsequent requests: 20-50 bytes (repeated headers compress to 1-2 bytes each). Sensitive headers (authorization, cookies) use the `sensitive` flag -- never indexed in the dynamic table to resist CRIME-like attacks.

### Layer-by-Layer Comparison

DNS and TCP identical across all three. TLS identical except ALPN. The HTTP layer is where everything differs: body framing, end-of-body signal, concurrency model, header compression, flow control.

### TCP Segment Patterns

```
Content-Length:  ████████████████████████  (continuous blast, ~36K segments)
Chunked:         █···█····█·······█···█··  (sparse bursts, idle gaps)
HTTP/2:          ██████████████████████    (interleaved frames from streams)
```

### Slow Network Behavior

**Content-Length + congestion**: Packet loss causes sawtooth pattern -- cwnd grows, loss detected (3 dup ACKs or timeout), cwnd halved, linear recovery. 2% loss on 100 Mbps -> ~2x slower.

**Chunked + congestion**: Small events rarely hit congestion. Real problems: idle connection timeout (proxies/NATs kill after 60-120s, solved by heartbeats), TCP keepalive probes (default 2h), Nagle + delayed ACK interaction (up to 40ms delay, fix with TCP_NODELAY).

**HTTP/2 + congestion**: TCP-level HOL blocking. All streams share one TCP connection. Lost segment for stream 1 stalls streams 3 and 5 because TCP guarantees in-order delivery. Can be **worse** than HTTP/1.1 with 6 parallel connections (where only 1 of 6 stalls). Flow control can also starve all streams if the connection-level window fills. This is the fundamental motivation for HTTP/3 (QUIC over UDP -- per-stream independent delivery).

### Client Application Code

Content-Length: `io.Copy` reads continuously until `io.EOF` (when byte count matches Content-Length). Chunked: Go/browser transparently decode chunk framing -- app sees raw bytes, never chunk headers. Each `Read` may block for seconds waiting for next event. HTTP/2: completely transparent -- same Go `http.Get` API, library handles stream muxing, HPACK, flow control internally.

## Quick Reference

| Aspect | Content-Length | Chunked | HTTP/2 |
|--------|---------------|---------|--------|
| Size known upfront | Yes | No | Optional |
| End-of-body signal | Byte count match | Zero-length chunk `0\r\n\r\n` | END_STREAM flag |
| Progress bar | Yes | Bytes-only counter | Yes if content-length present |
| Concurrent requests | 1 per connection | 1 per connection | 100+ streams |
| Header compression | None | None | HPACK (1-2 bytes for repeated headers) |
| Range/resume | Yes | No | Yes (if server supports) |
| HOL blocking | HTTP layer | HTTP layer | No at HTTP, yes at TCP |
| Framing overhead | None | Hex size + 2 CRLFs (~6-10 bytes/chunk) | 9-byte frame header per DATA frame |
| Flow control | TCP only | TCP only | TCP + per-stream + per-connection |

```
HTTP/2 Frame (9-byte header):
  ┌──────────────────────────────────────────┐
  │ Length (24b) │ Type (8b) │ Flags (8b)    │
  │ R │      Stream Identifier (31b)         │
  │            Frame Payload                  │
  └──────────────────────────────────────────┘

Type: 0x00=DATA, 0x01=HEADERS, 0x04=SETTINGS,
      0x06=PING, 0x07=GOAWAY, 0x08=WINDOW_UPDATE
```

## Key Takeaways

- TCP and TLS behave identically regardless of HTTP version -- differences are purely in HTTP framing.
- Content-Length enables progress bars, Range request resume, and clean connection reuse. Chunked cannot do any of these at the HTTP level.
- HTTP/2 eliminates HTTP-level HOL blocking via multiplexing, but TCP-level HOL blocking remains (lost packet stalls all streams). HTTP/3/QUIC gives each stream independent delivery.
- HTTP/2 has two flow control layers (per-stream + per-connection) on top of TCP. A slow consumer on one stream can starve all streams if the connection window exhausts -- well-implemented clients send WINDOW_UPDATE proactively.
- TLS 1.3 completes in 1 RTT (vs 2 for TLS 1.2) because the client sends its key share speculatively in ClientHello. 0-RTT resumption possible but not forward-secret and replay-vulnerable.
- HPACK compresses repeated headers to 1-2 bytes after the first request. Sensitive headers (auth, cookies) use the `sensitive` flag to resist compression oracle attacks (CRIME/BREACH).
- For chunked streaming, set `TCP_NODELAY` to prevent Nagle's algorithm from delaying small writes.
- Go and browsers transparently handle chunked decoding and HTTP/2 muxing -- application code uses the same API regardless of HTTP version.
