---
title: "Summary: HTTP Streaming"
---

> **Full notes:** [[notes/Networking/http_streaming|HTTP Streaming -->]]

## Key Concepts

- **Streaming vs standard HTTP**: Standard HTTP sends the full response with `Content-Length`. Streaming sends data incrementally while the connection stays open. The server doesn't know total size upfront.

- **How connections stay open (HTTP/1.1)**: Three ways to signal body end -- `Content-Length`, `Transfer-Encoding: chunked`, or connection close. Chunked is the standard for streaming.

- **SSE (Server-Sent Events)**: W3C standard for unidirectional server-to-client streaming over plain HTTP. Uses `text/event-stream` content type. Built-in browser `EventSource` API handles auto-reconnection with `Last-Event-ID`.

- **WebSockets**: Bidirectional binary protocol after an HTTP upgrade handshake (101 Switching Protocols). Supports text, binary, ping/pong, and close frames. Client frames must be masked.

- **Long Polling**: Simulates push -- client sends request, server holds it open until data is available, responds, client immediately re-requests. High overhead (~500+ bytes per message).

- **gRPC Streaming**: Built on HTTP/2. Four patterns: unary, server-streaming, client-streaming, bidirectional.

- **Zombie connections**: Clients that disappear without closing. Detected via heartbeats + deadlines (WebSocket ping/pong, SSE heartbeat comments, gRPC PING frames).

## Quick Reference

| Feature | Long Polling | SSE | WebSockets | gRPC Streaming |
|---------|-------------|-----|------------|----------------|
| Direction | Simulated bidi | Server -> Client | Bidirectional | All four |
| Overhead/msg | ~500+ bytes | ~5 bytes | ~2 bytes | ~5 bytes + protobuf |
| Reconnection | Manual | Automatic | Manual | Automatic |
| Data types | Any | UTF-8 only | Text or binary | Binary (protobuf) |
| Best for | Legacy, infrequent | Live feeds, AI streaming | Chat, gaming | Microservices |

```
SSE Event Format:
  event: userlogin\n
  data: {"user":"bob"}\n
  id: 42\n
  \n                    <-- blank line dispatches event

Chunked Encoding:
  1C\r\n              <-- hex size (28 bytes)
  <28 bytes of data>\r\n
  0\r\n\r\n           <-- zero chunk = end
```

## Key Takeaways

- SSE does NOT require chunked encoding -- the spec is transport-agnostic. HTTP/2 uses DATA frames instead.
- HTTP/1.1 browsers limit 6 connections per domain -- SSE consumes one each. HTTP/2 multiplexes, solving this.
- WebSocket `Sec-WebSocket-Key` prevents accidental protocol confusion, not security.
- Always implement heartbeats for long-lived connections to detect zombie connections and keep middleboxes from killing idle sockets.
- For most modern server-push use cases (dashboards, notifications, AI token streaming), SSE over HTTP/2 is simpler than WebSockets.
