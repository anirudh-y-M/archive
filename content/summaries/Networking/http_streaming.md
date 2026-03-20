---
title: "Summary: HTTP Streaming"
---

> **Full notes:** [[notes/Networking/http_streaming|HTTP Streaming -->]]

## Key Concepts

### Streaming vs Standard HTTP

Standard HTTP sends the full response with a known `Content-Length`. Streaming sends data incrementally while the connection stays open -- the server omits `Content-Length` because the total size is unknown when the response begins. The client processes data as it arrives, potentially before the response is "finished."

### How Connections Stay Open

In HTTP/1.1, three ways signal body end: `Content-Length`, `Transfer-Encoding: chunked` (self-delimiting hex-prefixed chunks, zero-length chunk terminates), or connection close (prevents reuse). Chunked is the standard for streaming. In HTTP/2, chunked encoding is explicitly prohibited (RFC 9113 Section 8.2.2) -- HTTP/2 uses its own DATA frames with length prefixes, terminated by the `END_STREAM` flag.

### Keeping Connections Alive

Three layers of keepalive exist. **TCP keepalives** (OS layer) send invisible empty packets to detect dead hosts. **Protocol PINGs** (HTTP/2 PING frames, WebSocket Ping/Pong opcodes 0x9/0xA) operate at the framing layer. **Application heartbeats** (SSE comment lines `: heartbeat\n\n`) are the most reliable because they survive every kind of middlebox. Without these, routers/firewalls/load balancers kill idle connections.

### Server-Sent Events (SSE)

W3C/WHATWG standard for **unidirectional** server-to-client streaming. Hard requirements: `GET` method, `Content-Type: text/event-stream`, UTF-8 encoding. The event stream format uses `field: value` lines (data, event, id, retry, comments) separated by blank lines. The `EventSource` browser API handles auto-reconnection with `Last-Event-ID` -- the browser waits `retry` interval, opens a new GET, includes `Last-Event-ID` header. No developer reconnection logic needed.

SSE does NOT require chunked encoding -- the spec is transport-agnostic. Connection limit: HTTP/1.1 browsers enforce 6 connections per domain (each SSE stream uses one), but HTTP/2 multiplexes over a single connection (default 100 concurrent streams). CORS: use `withCredentials: true` on the EventSource constructor for cross-origin cookies. Go implementation uses `http.Flusher` -- `Flush()` is critical or buffered data never reaches the client.

### WebSockets

Upgrades an HTTP connection to a persistent **bidirectional** binary protocol via a `101 Switching Protocols` handshake. `Sec-WebSocket-Accept` is computed as `base64(SHA1(client_key + magic_GUID))` to prevent accidental protocol confusion (not a security mechanism). Frame types: text (0x1), binary (0x2), close (0x8), ping (0x9), pong (0xA), continuation (0x0). Client-to-server frames must be XOR-masked with a random 32-bit key. Control frames limited to 125 bytes. Heartbeats use Ping/Pong with read deadlines -- if no Pong arrives within `pongWait`, the connection is killed.

### Long Polling

Simulates server push using standard HTTP. Client sends a request, server holds it open until data is available or timeout, responds, client immediately re-requests. Every response is a full HTTP cycle with ~500+ bytes of header overhead. No special protocol -- works through any proxy or firewall. Simplest to implement, highest overhead.

### gRPC Streaming

Built on HTTP/2 with Protocol Buffers. Four RPC patterns: unary, server-streaming, client-streaming, bidirectional. A gRPC channel = HTTP/2 connection, each RPC = HTTP/2 stream, each message = one or more DATA frames (default 16KB frame size). Uses HTTP/2 PING frames for keepalive (GCP idle timeout 10 min, AWS ALB 60s).

### HTTP/2 Multiplexing and Streaming

All streams multiplexed over a single TCP connection as independent bidirectional frame sequences. Stream IDs: odd = client-initiated, even = server-initiated. Eliminates HTTP-level head-of-line blocking. **Caveat:** TCP-level packet loss still causes HOL blocking across all streams because TCP guarantees in-order delivery. HTTP/3 (QUIC over UDP) solves this with per-stream independent delivery.

### The Zombie Connection Problem

Zombie connections = client disappeared but server still holds resources (memory, goroutines, state). SSE relies on TCP keepalives + write errors from heartbeat flushes. WebSockets use Ping/Pong with `ReadDeadline` for precise detection. gRPC uses HTTP/2 PING frames with configurable keepalive + `MaxConnectionIdle` / `MaxConnectionAge`.

## Quick Reference

| Feature | Long Polling | SSE | WebSockets | gRPC Streaming |
|---------|-------------|-----|------------|----------------|
| Direction | Simulated bidi | Server -> Client | Bidirectional | All four |
| Protocol | HTTP | HTTP | WebSocket (post-upgrade) | HTTP/2 |
| Overhead/msg | ~500+ bytes | ~5 bytes | ~2 bytes | ~5 bytes + protobuf |
| Data types | Any | UTF-8 only | Text or binary | Binary (protobuf) |
| Reconnection | Manual | Automatic (Last-Event-ID) | Manual | Automatic (channel) |
| Heartbeats | Manual | App-level (comments) | Protocol (Ping/Pong) | HTTP/2 PING |
| Proxy compat | Best | Good | Moderate | Moderate (needs H2) |
| Best for | Legacy, infrequent | Live feeds, AI streaming | Chat, gaming | Microservices |

```
SSE Event Format:              Chunked Encoding:
  event: userlogin\n             1C\r\n              <-- hex size (28 bytes)
  data: {"user":"bob"}\n         <28 bytes of data>\r\n
  id: 42\n                       0\r\n\r\n           <-- zero chunk = end
  \n   <-- blank line dispatches

WebSocket Upgrade:
  Client: GET /chat HTTP/1.1 + Connection: Upgrade + Upgrade: websocket
  Server: HTTP/1.1 101 Switching Protocols + Sec-WebSocket-Accept: <hash>
  After: raw binary frames, no more HTTP
```

## Key Takeaways

- SSE does NOT require chunked encoding -- the spec is transport-agnostic. HTTP/1.1 commonly uses chunked, HTTP/2 uses DATA frames.
- HTTP/1.1 browsers limit 6 connections per domain -- each SSE stream uses one. HTTP/2 multiplexes, solving this.
- WebSocket `Sec-WebSocket-Key` prevents accidental protocol confusion, not security. The handshake proves the server intentionally agreed to upgrade.
- Always implement heartbeats for long-lived connections to detect zombies and prevent middleboxes from killing idle sockets.
- For most modern server-push use cases, SSE over HTTP/2 is simpler than WebSockets. WebSockets only necessary for bidirectional low-latency messaging.
- Go's `http.Flusher` is critical for SSE -- without `Flush()`, data is buffered until the buffer fills. Check with type assertion since middleware wrappers may not implement it.
- HTTP/2 eliminates HTTP-level HOL blocking but TCP-level HOL blocking remains. HTTP/3 (QUIC) solves this with per-stream independence.
