---
title: "HTTP Streaming"
---

## How Streaming Differs from Standard HTTP

In a standard HTTP request-response cycle, the server knows the full response size upfront, sets `Content-Length`, sends the entire body, and the client processes it once complete.

In streaming HTTP, the server sends data incrementally while keeping the connection open. The client processes data as it arrives — potentially before the response is "finished." The server omits `Content-Length` because the total size is unknown at the time the response begins.

### How the connection stays open without `Content-Length`

In HTTP/1.1, there are exactly three ways for a client to know when a response body ends:

1. **`Content-Length` header** — the server declares the exact byte count upfront. Not possible for streaming.
2. **`Transfer-Encoding: chunked`** — the server sends data in self-delimiting chunks. Each chunk is prefixed with its size in hexadecimal, followed by CRLF, then the data, then CRLF. A zero-length chunk signals the end.
3. **Connection close** — the server simply closes the TCP connection when done. This works but prevents connection reuse (HTTP keep-alive).

For streaming, chunked encoding is the standard mechanism in HTTP/1.1:

```
25\r\n                              ← chunk size: 37 bytes (0x25)
This is the data in the first chunk\r\n  ← 37 bytes of data
1C\r\n                              ← chunk size: 28 bytes (0x1C)
and this is the second one\r\n      ← 28 bytes of data
0\r\n                               ← zero-length chunk = end of stream
\r\n                                ← final CRLF
```

In HTTP/2, chunked encoding does not exist and is explicitly prohibited by the spec (RFC 9113 §8.2.2). HTTP/2 has its own framing layer — each `DATA` frame carries a length prefix, so the protocol inherently knows chunk boundaries. Streaming in HTTP/2 is just a series of `DATA` frames on an open stream, with an `END_STREAM` flag on the final frame.

---

## Keeping Connections Alive

A connection isn't just a socket between two endpoints — it passes through routers, firewalls, load balancers, and proxies. If no data moves, these middlemen kill the connection to free resources. Defence happens at three layers:

**TCP Keepalives (OS layer):** The kernel sends invisible empty packets to check if the remote host is still reachable. Configured via `tcp_keepalive_time`, `tcp_keepalive_intvl`, `tcp_keepalive_probes`. This detects dead hosts but doesn't prevent application-level timeouts.

**Protocol PINGs (transport layer):** HTTP/2 has native `PING` frames that require an immediate `PONG` response. WebSockets have `Ping` (opcode `0x9`) and `Pong` (opcode `0xA`) control frames. These operate at the framing layer — no application code needed.

**Application heartbeats (code layer):** The application sends "junk" data to keep the connection hot for middlemen that only track data flow, not protocol-level pings. In SSE, a comment line (`: heartbeat\n\n`) is commonly used. This is the most reliable approach because it survives every kind of middleman.

---

## Server-Sent Events (SSE)

SSE is a W3C/WHATWG standard ([HTML Living Standard §9.2](https://html.spec.whatwg.org/multipage/server-sent-events.html)) for **unidirectional** server-to-client streaming over plain HTTP. The browser's `EventSource` API handles connection management, parsing, and automatic reconnection.

### Protocol requirements

The SSE specification defines the **event stream format and parsing rules**, not the transport mechanism. The only hard requirements are:

| Requirement | Detail |
| --- | --- |
| HTTP method | `GET` |
| Response `Content-Type` | Must be `text/event-stream` (spec mandates: if not, fail the connection) |
| `Cache-Control` | Should be `no-cache` to prevent stale cached streams |
| Encoding | UTF-8 only |
| Buffering | Spec recommends line buffering; block buffering can delay event dispatch |

> **The `Transfer-Encoding: chunked` nuance:** The SSE spec does **not** require chunked encoding. It defines the event format and parsing rules but is agnostic about how the HTTP transport keeps the connection open. On HTTP/1.1, servers commonly use `Transfer-Encoding: chunked` because it's the standard way to stream without knowing `Content-Length` upfront, but the SSE specification itself does not mandate it. A server could technically use connection-close semantics or any other valid HTTP/1.1 transfer mechanism. On **HTTP/2**, chunked encoding is prohibited entirely — HTTP/2's native `DATA` framing handles streaming natively.

For proxies like Nginx that buffer responses by default, the server should also send `X-Accel-Buffering: no` to disable output buffering.

### Event stream format

Each event is a block of `field: value` lines, terminated by a **blank line** (two consecutive newlines). The spec accepts CRLF, LF, or CR as line endings:

```
event: userlogin
data: {"username": "bob", "time": "2025-05-15T22:08:54Z"}
id: 1

data: {"stock": "ACME", "price": 42.50}
id: 2
retry: 10000

: this is a comment (used for heartbeats)
```

| Field | Purpose | Parsing details |
| --- | --- | --- |
| `data:` | Message content | Multiple consecutive `data:` lines are concatenated with `\n` between them. Trailing newline stripped on dispatch |
| `event:` | Event type name | Triggers `addEventListener(name, ...)` on client. If omitted, fires `onmessage` |
| `id:` | Event ID | Stored internally; sent as `Last-Event-ID` header on reconnect. Rejects values containing NULL characters |
| `retry:` | Reconnection delay (ms) | Must be ASCII digits only. Non-integer values are silently ignored |
| `:` | Comment | Entire line ignored by the client. Used for heartbeats / keep-alive |

Lines without a colon are treated as a field name with an empty string value. Unknown field names are ignored.

### Automatic reconnection

The `EventSource` API has three states:

| readyState | Value | Meaning |
| --- | --- | --- |
| `CONNECTING` | 0 | Initial state or reconnecting after a drop |
| `OPEN` | 1 | Connected and dispatching events |
| `CLOSED` | 2 | Permanently closed, no further reconnection |

When the connection drops (network error, server restart, proxy timeout), the browser:

1. Sets `readyState` to `CONNECTING`.
2. Fires the `error` event.
3. Waits for the `retry` interval (default ~3 seconds, overridable by the server's `retry:` field).
4. Opens a **new** HTTP GET request to the same URL.
5. Includes `Last-Event-ID: <last-id>` in the request header.

The server reads `Last-Event-ID` and resumes from that point. No duplicate events, no gaps — assuming the server implements ID-based resumption. This is entirely built into the browser API; the developer writes no reconnection logic.

To **permanently** close the connection (no reconnect), the client calls `evtSource.close()`, which sets `readyState` to `CLOSED`. The server can also fail the connection by responding with a non-200 status code or a `Content-Type` other than `text/event-stream` — the browser will not attempt to reconnect.

### Connection limit

On HTTP/1.1, browsers enforce a **6 concurrent connections per domain** limit (this is per browser+domain, not per tab). Each SSE stream consumes one connection. This is severe with multiple tabs — it's marked "Won't fix" in both Chrome and Firefox. On HTTP/2, streams are multiplexed over a single connection (default limit: 100 concurrent streams), so this is not a practical issue.

### CORS

The `EventSource` constructor accepts a `withCredentials` option for cross-origin requests. The browser creates a CORS-preflight request with the appropriate `Origin` header. Without `withCredentials: true`, cookies are not sent on cross-origin SSE connections.

```javascript
const evtSource = new EventSource("https://other-domain.com/events", {
    withCredentials: true
});
```

### Go implementation

Go uses the `http.Flusher` interface to push buffered data to the client immediately:

```go
func streamHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    w.Header().Set("X-Accel-Buffering", "no") // disable Nginx buffering

    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "streaming not supported", http.StatusInternalServerError)
        return
    }

    heartbeat := time.NewTicker(15 * time.Second)
    defer heartbeat.Stop()

    eventID := 0
    for {
        select {
        case <-r.Context().Done():
            return
        case <-heartbeat.C:
            fmt.Fprintf(w, ": heartbeat\n\n")
            flusher.Flush()
        case msg := <-messageChannel:
            eventID++
            fmt.Fprintf(w, "id: %d\ndata: %s\n\n", eventID, msg)
            flusher.Flush()
        }
    }
}
```

`Flush()` is critical — without it, Go's `ResponseWriter` buffers data internally and the client sees nothing until the buffer fills or the connection closes. When `Flush()` is called with no `Content-Length` set on HTTP/1.1, Go automatically applies `Transfer-Encoding: chunked`. On HTTP/2 connections, Go sends `DATA` frames directly — no chunked encoding involved.

> **Note on `http.Flusher` support:** The HTTP/1.1 and HTTP/2 `ResponseWriter` implementations both support `Flusher`. However, if the `ResponseWriter` is wrapped (e.g., by middleware that adds gzip compression), the wrapper may not implement `Flusher`. Always check with a type assertion at runtime.

---

## WebSockets

WebSockets upgrade an HTTP connection to a persistent, **bidirectional** binary protocol. After the upgrade handshake, both client and server can send messages at any time without waiting for the other side.

### The upgrade handshake

Client sends a standard HTTP request with upgrade headers:

```http
GET /chat HTTP/1.1
Host: server.example.com
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

Server responds with `101 Switching Protocols`:

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

The `Sec-WebSocket-Accept` value is computed as `base64(SHA1(client_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`. This prevents accidental upgrades — the server proves it understood the WebSocket request.

After the handshake, the connection is no longer HTTP. Raw binary frames flow in both directions.

### Frame types

| Opcode | Type | Purpose |
| --- | --- | --- |
| `0x1` | Text | UTF-8 text message |
| `0x2` | Binary | Binary data |
| `0x8` | Close | Connection teardown |
| `0x9` | Ping | Heartbeat request |
| `0xA` | Pong | Heartbeat response |
| `0x0` | Continuation | Fragment of a multi-frame message |

Ping/Pong frames are handled at the protocol level — the endpoint must respond to a Ping with a Pong automatically. Control frames (Ping, Pong, Close) are limited to 125 bytes. Client-to-server frames must be masked with a random 32-bit XOR key (prevents cache poisoning attacks on proxies).

### Heartbeats with deadlines (Go)

In `gorilla/websocket`, heartbeats use **deadlines** — a timer that kills the connection if no activity is detected:

```go
const (
    pongWait   = 60 * time.Second
    pingPeriod = 54 * time.Second // must be less than pongWait
)

// Server side: set initial deadline
conn.SetReadDeadline(time.Now().Add(pongWait))

// Extend deadline every time a Pong arrives
conn.SetPongHandler(func(string) error {
    conn.SetReadDeadline(time.Now().Add(pongWait))
    return nil
})

// Send Pings on a ticker
go func() {
    ticker := time.NewTicker(pingPeriod)
    defer ticker.Stop()
    for range ticker.C {
        if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
            return
        }
    }
}()
```

If the server doesn't receive a Pong within `pongWait`, `ReadMessage()` returns an error and the connection is closed. This detects zombie connections — clients that disappeared without sending a Close frame.

---

## Long Polling

Long polling simulates server push using standard HTTP. The client sends a request, and the server **holds it open** until new data is available (or a timeout expires). Once the server responds, the client immediately sends a new request.

```
Client → GET /updates?since=42  (hangs open)
         ... server waits for new data ...
Server → 200 OK { "events": [...], "lastId": 57 }
Client → GET /updates?since=57  (new request, hangs open again)
```

Every response is a full HTTP request-response cycle with complete headers (~500+ bytes overhead per message). No special protocol — works everywhere, through any proxy or firewall.

---

## gRPC Streaming

gRPC is built on HTTP/2 and uses Protocol Buffers for serialization. It supports four RPC patterns:

**Unary:** Single request → single response. Equivalent to a standard HTTP call. Each RPC creates a new HTTP/2 stream.

**Server streaming:** Single request → stream of responses. The server sends multiple messages on the same stream. Client reads until the server closes the stream.

**Client streaming:** Stream of requests → single response. The client sends multiple messages, then the server responds once after receiving all of them.

**Bidirectional streaming:** Both sides send streams simultaneously. Read and write ordering is independent — either side can send at any time.

In HTTP/2 terms: a gRPC channel is an HTTP/2 connection, each RPC is an HTTP/2 stream, and each message is one or more HTTP/2 `DATA` frames (default frame size is 16KB; larger messages span multiple frames).

gRPC uses HTTP/2 `PING` frames for keepalive to prevent proxy timeouts (GCP's default idle timeout is 10 minutes, AWS ALB is 60 seconds).

---

## HTTP/2 Multiplexing and Streaming

HTTP/2 fundamentally changes how streaming works compared to HTTP/1.1.

In HTTP/1.1, each stream consumes one TCP connection. Six SSE streams to the same domain exhaust the browser's connection limit.

In HTTP/2, all streams are multiplexed over a single TCP connection as independent bidirectional frame sequences. Stream IDs are odd (client-initiated) or even (server-initiated). Frames from different streams interleave freely — stream 9 can complete while stream 7 is still processing. This eliminates **head-of-line blocking** at the HTTP layer.

The caveat: TCP-level packet loss still causes HOL blocking across all streams, because TCP guarantees in-order delivery. HTTP/3 (QUIC over UDP) solves this by giving each stream its own independent delivery.

HTTP/2 also has `PUSH_PROMISE` — the server proactively sends resources before the client requests them. Not streaming per se, but a related server-initiated data push. Rarely used in practice due to caching complexity.

---

## Comparison

| | Long Polling | SSE | WebSockets | gRPC Streaming |
| --- | --- | --- | --- | --- |
| Direction | Simulated bidirectional | Server → Client | Bidirectional | All four patterns |
| Protocol | HTTP | HTTP | WebSocket (after upgrade) | HTTP/2 |
| Overhead per message | ~500+ bytes (full headers) | ~5 bytes | ~2 bytes (frame header) | ~5 bytes + protobuf |
| Data types | Any | UTF-8 text only | Text or binary | Binary (protobuf) |
| Reconnection | Manual | Automatic (`Last-Event-ID`) | Manual | Automatic (channel reconnect) |
| Heartbeats | Manual | Application-level (comments) | Protocol-level (Ping/Pong) | HTTP/2 PING frames |
| Proxy/firewall compat | Best (standard HTTP) | Good | Moderate (some proxies block upgrade) | Moderate (requires HTTP/2) |
| Best for | Legacy systems, infrequent updates | Live feeds, notifications, AI token streaming | Chat, gaming, collaboration | Microservice communication |

---

## The Zombie Connection Problem

A zombie connection is one where the client has disappeared (entered an elevator, phone died, tab crashed) but the server still holds resources for it. Without heartbeats and deadlines, a server accumulates thousands of zombie connections — each consuming memory for buffers, goroutines, and state.

Heartbeats detect zombies by requiring a response within a deadline. If the deadline expires, the server closes the connection and frees resources. In SSE, the server can't detect zombies directly (unidirectional), so it relies on TCP keepalives and write errors. In WebSockets, the Ping/Pong mechanism with `ReadDeadline` catches zombies within one `pongWait` interval.

---

## See also

- [[notes/Networking/TCP_keepalives|TCP Keepalives]]
- [[notes/Networking/HTTP_GRPC_connections|HTTP & gRPC Connections]]
- [WHATWG HTML Living Standard: Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [RFC 6455: The WebSocket Protocol](https://datatracker.ietf.org/doc/html/rfc6455)
- [RFC 9113: HTTP/2](https://datatracker.ietf.org/doc/html/rfc9113)
- [gRPC: Core Concepts](https://grpc.io/docs/what-is-grpc/core-concepts/)
- [Go: net/http Flusher](https://pkg.go.dev/net/http#Flusher)

---

## Interview Prep

### Q: How does `Transfer-Encoding: chunked` work at the wire level?

**A:** Instead of declaring `Content-Length` upfront, the server sends data in discrete chunks. Each chunk has three parts: the size in hexadecimal, a CRLF delimiter, the data bytes, and another CRLF. For example, a 37-byte chunk starts with `25\r\n` (37 in hex), followed by 37 bytes of data, followed by `\r\n`. The stream terminates with a zero-length chunk: `0\r\n\r\n`.

The key property is that the server doesn't need to know the total response size before it starts sending. This enables true streaming — the server can generate and send data incrementally. The client reads chunk by chunk, processing each as it arrives. HTTP/1.1 requires chunked encoding for streaming because the protocol needs *some* way to know where the response ends. Without `Content-Length` or chunked encoding, the only signal would be closing the TCP connection — which prevents connection reuse.

In HTTP/2, chunked encoding is not used. HTTP/2 has its own framing layer (`DATA` frames with length prefixes), so `Transfer-Encoding: chunked` is actually prohibited by the spec.

### Q: Walk through what happens when a browser opens an SSE connection, receives events, the connection drops, and reconnects.

**A:** The browser creates an `EventSource` object pointing at the server URL. The `readyState` is set to `CONNECTING` (0). The browser opens a standard HTTP GET request — it may set `Accept: text/event-stream` (spec says this is optional but recommended). If `withCredentials` was set in the constructor, cookies and auth headers are included (CORS mode).

The server validates the request and responds with `200 OK` and `Content-Type: text/event-stream`. On HTTP/1.1, the server typically (but is not required to) use `Transfer-Encoding: chunked` to keep the connection open without declaring `Content-Length`. On HTTP/2, the server simply sends `DATA` frames on the open stream — no chunked encoding exists in HTTP/2. The SSE spec itself is transport-agnostic; it only mandates `Content-Type: text/event-stream` and the event format.

The browser verifies the status is 200 and the Content-Type is `text/event-stream`. If either check fails, the connection is permanently failed (no reconnect). On success, `readyState` moves to `OPEN` (1) and the `open` event fires.

The server starts sending events. Each event is a text block: `id: 42\ndata: {...}\n\n`. The browser's SSE parser reads line by line (accepting CRLF, LF, or CR as line endings). When it hits a blank line, it dispatches the buffered event. If an `event:` field was present, it fires a custom event listener (`addEventListener("eventName", ...)`); otherwise it fires `onmessage`. The `id` value is stored internally as the last event ID.

The connection drops — WiFi blip, proxy timeout, server restart. The browser detects the broken connection (TCP RST, read error, or EOF). `readyState` moves back to `CONNECTING` (0) and the `error` event fires. The browser waits for the `retry` interval (default ~3 seconds, overridable by the server's last `retry:` field). It then opens a **new** HTTP GET to the same URL, this time including the header `Last-Event-ID: 42`.

The server receives the reconnection request, reads `Last-Event-ID: 42`, queries its data source for events after ID 42, and resumes streaming. No duplicates, no gaps — assuming the server implements ID-based resumption correctly.

This entire reconnection cycle is built into the `EventSource` API. The developer writes no retry logic, no backoff, no state tracking. WebSockets, by contrast, require manual reconnection with application-level state management — the protocol has no concept of "resume from ID."

The only way to **permanently** stop reconnection is: (1) the client calls `evtSource.close()`, setting `readyState` to `CLOSED` (2), or (2) the server responds with a non-200 status or wrong Content-Type on reconnect, which the spec treats as a fatal error.

### Q: Does SSE require `Transfer-Encoding: chunked`?

**A:** No. This is a common misconception. The SSE specification (WHATWG HTML Living Standard §9.2) defines the **event stream format** (`data:`, `event:`, `id:`, `retry:`, comments) and **parsing rules** (line-by-line, blank line dispatches event), but it is agnostic about the HTTP transport mechanism. The only hard requirements are `Content-Type: text/event-stream` and a 200 status code.

On **HTTP/1.1**, `Transfer-Encoding: chunked` is commonly used because it's the standard way to send a response of unknown length without closing the connection. But it's not the only option — a server could also omit both `Content-Length` and `Transfer-Encoding` and rely on connection-close semantics (the response ends when the TCP connection closes). This sacrifices connection reuse but is technically valid. In practice, nearly all HTTP/1.1 SSE implementations use chunked encoding because it's the most practical choice.

On **HTTP/2**, `Transfer-Encoding: chunked` is **explicitly prohibited** (RFC 9113 §8.2.2). HTTP/2 has its own binary framing layer — each `DATA` frame carries a length prefix, so chunk boundaries are handled natively by the protocol. SSE over HTTP/2 is just a series of `DATA` frames on an open stream, terminated by the `END_STREAM` flag. The SSE event format rides inside the `DATA` frame payloads without any chunked wrapper.

This distinction matters because if you're asked "how does SSE keep the connection open," the answer depends on the HTTP version: chunked encoding on HTTP/1.1, native stream framing on HTTP/2 — but the SSE spec itself doesn't care which.

### Q: What is the WebSocket upgrade handshake and why is `Sec-WebSocket-Key` needed?

**A:** The WebSocket connection starts as a regular HTTP/1.1 request. The client sends `GET` with `Connection: Upgrade`, `Upgrade: websocket`, and a `Sec-WebSocket-Key` header containing a random 16-byte value, base64-encoded.

The server computes `SHA1(client_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")`, base64-encodes the hash, and returns it as `Sec-WebSocket-Accept` in a `101 Switching Protocols` response. After this, the connection is no longer HTTP — binary WebSocket frames flow directly.

`Sec-WebSocket-Key` exists to prevent **accidental protocol confusion**. Without it, a misconfigured HTTP proxy or cache might treat a WebSocket upgrade response as a regular HTTP response and cache it, or a server that doesn't understand WebSockets might return `200 OK` with some HTML body, and the client would try to parse HTML as WebSocket frames. The key-accept handshake proves the server intentionally agreed to the upgrade. It is not a security mechanism — it doesn't authenticate or encrypt anything.

### Q: When would you choose SSE over WebSockets? What are the tradeoffs?

**A:** SSE when the data flow is primarily server-to-client: live feeds, stock tickers, CI/CD log tailing, AI token streaming (like ChatGPT responses). WebSockets when the client needs to send data back at the same frequency: chat applications, collaborative editors, multiplayer games.

**SSE advantages:** Works over standard HTTP — no protocol upgrade, no special proxy configuration, survives HTTP/2 multiplexing naturally. Automatic reconnection with `Last-Event-ID` is built into the browser API. Simpler server implementation — just write text to the response body and flush.

**SSE limitations:** Unidirectional (server → client only). UTF-8 text only — no binary data. On HTTP/1.1, each SSE stream consumes one of the browser's 6 connections per domain. The client can only send data by making separate HTTP requests.

**WebSocket advantages:** True bidirectional with minimal overhead (~2 byte frame header). Supports binary data natively. No per-domain connection limit since it's a single upgraded connection.

**WebSocket limitations:** Requires explicit reconnection logic (no built-in resume). Some corporate proxies and firewalls block the upgrade handshake. More complex server implementation — manage connection lifecycle, ping/pong, frame parsing.

For most modern use cases (dashboards, notifications, streaming responses), SSE over HTTP/2 is sufficient and simpler. WebSockets are only necessary when bidirectional low-latency messaging is a hard requirement.

### Q: What is a zombie connection and how does each streaming protocol handle it?

**A:** A zombie connection is one where the client has disappeared (network failure, process crash, device off) but the server still holds resources for it — memory, goroutines, file descriptors, state. At scale, thousands of zombies can exhaust server resources and cause outages.

**SSE:** The server can't actively probe the client (unidirectional). It relies on two mechanisms: (1) TCP keepalives — the OS detects that the remote host is unreachable after `keepalive_time + (keepalive_intvl × keepalive_probes)` seconds (default ~2 hours on Linux, configurable). (2) Write errors — when the server writes a heartbeat comment (`: heartbeat\n\n`) and calls `Flush()`, the write eventually fails if the client's TCP stack has closed. The failure surfaces as an error on the next `Fprintf` or `Flush` call. Heartbeat intervals of 15–30 seconds catch zombies much faster than TCP keepalives alone.

**WebSockets:** The Ping/Pong mechanism with deadlines is the primary zombie detector. The server sends Ping frames on a ticker (e.g., every 54 seconds) and sets a `ReadDeadline` of 60 seconds. Each incoming Pong resets the deadline. If the client disappears and no Pong arrives, `ReadMessage()` returns a timeout error after 60 seconds, and the server closes the connection. This is more precise than SSE because the server actively probes and gets a guaranteed response (or timeout).

**gRPC:** Uses HTTP/2 `PING` frames with configurable keepalive parameters (`keepalive.ClientParameters` / `keepalive.ServerParameters`). The server sends pings at a set interval and expects a response within a timeout. If the ping fails, the transport closes. gRPC also has `MaxConnectionIdle` and `MaxConnectionAge` to proactively cycle long-lived connections regardless of activity.

### Q: How does HTTP/2 multiplexing change the streaming landscape compared to HTTP/1.1? What problem remains?

**A:** In HTTP/1.1, each concurrent stream requires a separate TCP connection. A browser opening 6 SSE streams to one domain hits the connection limit — no more requests to that domain until a stream closes. This is why long polling and SSE were historically limited in scale on a single domain.

HTTP/2 multiplexes all streams over a **single TCP connection**. Each stream has an independent ID, and frames from different streams interleave freely on the wire. You can have 100 concurrent SSE streams, gRPC RPCs, and regular page loads all sharing one connection. Stream 9 can complete while stream 7 is still buffering — no application-level head-of-line (HOL) blocking.

The remaining problem is **TCP-level HOL blocking**. TCP guarantees in-order byte delivery. If a single TCP packet is lost, the kernel buffers all subsequent packets (even those belonging to other HTTP/2 streams) until the lost packet is retransmitted and received. So a packet loss on stream 3 stalls streams 5, 7, and 9 — even though they're independent at the HTTP layer.

HTTP/3 solves this by replacing TCP with QUIC (over UDP). QUIC gives each stream its own independent byte sequence. A lost packet on stream 3 only stalls stream 3 — other streams continue unblocked. This is the fundamental reason HTTP/3 exists: true per-stream independence that HTTP/2 over TCP cannot provide.

## See also

- [[notes/Networking/https-tcp-tls-flow-content-length-vs-chunked-vs-http2|End-to-End HTTPS Flow]] — Content-Length vs chunked vs HTTP/2 body framing in the context of a full HTTPS lifecycle
- [[notes/Networking/TCP_keepalives|TCP Keepalives]] — how keepalive probes interact with long-lived streaming connections
