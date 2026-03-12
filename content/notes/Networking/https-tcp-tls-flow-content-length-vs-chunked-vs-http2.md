---
title: "End-to-End HTTPS Flow: Content-Length vs Chunked vs HTTP/2 Streams"
---

## Overview

This document traces the **complete lifecycle** of an HTTPS request — from DNS resolution through TCP handshake, TLS 1.3 negotiation, HTTP request/response, body delivery, and connection teardown — for three distinct scenarios:

1. **HTTP/1.1 with `Content-Length`** — downloading a 50 MB file
2. **HTTP/1.1 with `Transfer-Encoding: chunked`** — streaming a response of unknown size
3. **HTTP/2 with multiplexed streams** — concurrent requests over a single connection

At the TCP and TLS layers, all three scenarios are nearly identical. The differences emerge at the HTTP layer — in how the body is framed, how the receiver knows when the body ends, and how the application consumes data. Understanding exactly where the protocols diverge (and where they don't) is what separates surface-level knowledge from real depth.

For a deep dive into the TLS 1.3 handshake mechanics — key exchange, certificate chain of trust, authentication vs encryption, Perfect Forward Secrecy — see [[notes/Networking/tls-1.3-handshake|TLS 1.3 Handshake]].

---

## Scenario 1: HTTP/1.1 with Content-Length (50 MB File Download)

### Complete End-to-End Flow

```
 Client (192.168.1.50)                                       Server (93.184.216.34:443)
      |                                                            |
      |  ============= DNS RESOLUTION ============                 |
      |                                                            |
      |------ DNS Query A? files.example.com ------>  DNS Resolver |
      |<----- DNS Response: 93.184.216.34 ----------  DNS Resolver |
      |                                                            |
      |  ============= TCP 3-WAY HANDSHAKE ============            |
      |                                                            |
  [1] |---- SYN  seq=1000000000 ---------------------------->      |
      |     src=192.168.1.50:54321  dst=93.184.216.34:443          |
      |     window=65535  MSS=1460  SACK_PERM  WScale=7            |
      |                                                            |
  [2] |<--- SYN-ACK  seq=2000000000 ack=1000000001 ----------     |
      |     src=93.184.216.34:443   dst=192.168.1.50:54321         |
      |     window=65535  MSS=1460  SACK_PERM  WScale=7            |
      |                                                            |
  [3] |---- ACK  seq=1000000001 ack=2000000001 ------------->      |
      |     window=65535                                           |
      |                                                            |
      |  ============= TLS 1.3 HANDSHAKE ============              |
      |                                                            |
  [4] |---- ClientHello ---------------------------------->        |
      |     TLS Record: ContentType=0x16 (Handshake)               |
      |       Version: TLS 1.0 (0x0301) [compatibility]            |
      |       Handshake Type: ClientHello (0x01)                   |
      |       Fields:                                              |
      |         legacy_version: TLS 1.2 (0x0303)                   |
      |         random: 32 bytes of client random                  |
      |         session_id: 32 bytes [compatibility]               |
      |         cipher_suites: [                                   |
      |           TLS_AES_256_GCM_SHA384 (0x1302)                  |
      |           TLS_AES_128_GCM_SHA256 (0x1301)                  |
      |           TLS_CHACHA20_POLY1305_SHA256 (0x1303)            |
      |         ]                                                  |
      |         extensions:                                        |
      |           supported_versions: [TLS 1.3 (0x0304)]           |
      |           key_share: x25519 public key (32 bytes)          |
      |           supported_groups: [x25519, secp256r1]            |
      |           signature_algorithms: [                          |
      |             ecdsa_secp256r1_sha256,                        |
      |             rsa_pss_rsae_sha256                            |
      |           ]                                                |
      |           server_name: files.example.com (SNI)             |
      |           application_layer_protocol_negotiation: [h2, http/1.1]|
      |                                                            |
  [5] |<--- ServerHello --------------------------------           |
      |     TLS Record: ContentType=0x16 (Handshake)               |
      |       Handshake Type: ServerHello (0x02)                   |
      |       Fields:                                              |
      |         legacy_version: TLS 1.2 (0x0303)                   |
      |         random: 32 bytes of server random                  |
      |         session_id: echo of client's session_id            |
      |         cipher_suite: TLS_AES_256_GCM_SHA384 (0x1302)     |
      |         extensions:                                        |
      |           supported_versions: TLS 1.3 (0x0304)             |
      |           key_share: x25519 server public key (32 bytes)   |
      |                                                            |
      |     [ChangeCipherSpec — compatibility, not real TLS 1.3]   |
      |                                                            |
      |     {Encrypted Extensions}  ← encrypted with handshake keys|
      |       alpn: http/1.1                                       |
      |                                                            |
      |     {Certificate}                                          |
      |       server cert chain (files.example.com)                |
      |       X.509 cert + intermediate CA cert                    |
      |                                                            |
      |     {CertificateVerify}                                    |
      |       signature over handshake transcript                  |
      |       proves server owns the private key                   |
      |                                                            |
      |     {Finished}                                             |
      |       HMAC over entire handshake transcript                |
      |                                                            |
      |  ---- At this point, the server can send application data  |
      |  ---- This is called "0.5-RTT data" (server speaks first) |
      |                                                            |
  [6] |---- {Finished} ---------------------------------->         |
      |     HMAC over entire handshake transcript                  |
      |     (client proves it derived the same keys)               |
      |                                                            |
      |  ---- TLS 1.3 handshake complete: 1-RTT ----              |
      |  ---- Both sides now have application traffic keys ----    |
      |                                                            |
      |  ============= HTTP REQUEST ============                   |
      |                                                            |
  [7] |---- TLS Application Data Record ----------------->         |
      |     ContentType=0x17 (Application Data)                    |
      |     Encrypted payload contains:                            |
      |                                                            |
      |       GET /releases/app-v2.1.0.tar.gz HTTP/1.1\r\n        |
      |       Host: files.example.com\r\n                          |
      |       User-Agent: curl/8.5.0\r\n                           |
      |       Accept: */*\r\n                                      |
      |       Accept-Encoding: gzip, deflate\r\n                   |
      |       Connection: keep-alive\r\n                           |
      |       \r\n                                                 |
      |                                                            |
      |  ============= HTTP RESPONSE ============                  |
      |                                                            |
  [8] |<--- TLS Application Data Record -------------------        |
      |     Encrypted payload contains:                            |
      |                                                            |
      |       HTTP/1.1 200 OK\r\n                                  |
      |       Content-Type: application/gzip\r\n                   |
      |       Content-Length: 52428800\r\n                          |
      |       Accept-Ranges: bytes\r\n                             |
      |       ETag: "a1b2c3d4e5f6"\r\n                             |
      |       Cache-Control: public, max-age=86400\r\n             |
      |       Date: Thu, 12 Mar 2026 10:00:00 GMT\r\n              |
      |       \r\n                                                 |
      |       <first ~1400 bytes of body in this TLS record>       |
      |                                                            |
      |  ============= BODY TRANSFER (50 MB) ============          |
      |                                                            |
      |  TCP delivers the body in segments. Each TLS record        |
      |  can hold up to 16,384 bytes (2^14), and each TLS record  |
      |  is split across TCP segments of MSS=1460 bytes.           |
      |                                                            |
      |  TLS Record (16,384 bytes payload + 5 byte header + 16 byte tag)
      |    → split into ~12 TCP segments of 1460 bytes             |
      |                                                            |
  [9] |<--- TCP segments carrying TLS Application Data ---         |
      |                                                            |
      |  Phase 1: TCP Slow Start (exponential growth)              |
      |  ┌─────────────────────────────────────────────────┐       |
      |  │ cwnd = 10 MSS (14,600 bytes) — initial window   │       |
      |  │                                                 │       |
      |  │ RTT 1:  10 segments sent  → 10 ACKs received   │       |
      |  │ RTT 2:  20 segments sent  → 20 ACKs received   │       |
      |  │ RTT 3:  40 segments sent  → 40 ACKs received   │       |
      |  │ RTT 4:  80 segments sent  → 80 ACKs received   │       |
      |  │ RTT 5: 160 segments sent  → hit ssthresh       │       |
      |  │                                                 │       |
      |  │ After ~5 RTTs: cwnd ≈ 233 KB                    │       |
      |  │ At 50ms RTT → ~250ms to fill the pipe           │       |
      |  └─────────────────────────────────────────────────┘       |
      |                                                            |
      |  Phase 2: Congestion Avoidance (linear growth)             |
      |  ┌─────────────────────────────────────────────────┐       |
      |  │ cwnd grows by ~1 MSS per RTT                    │       |
      |  │ Steady-state throughput depends on:              │       |
      |  │   - Bandwidth-delay product (BDP)               │       |
      |  │   - Receiver window (rwnd)                      │       |
      |  │   - Actual link bandwidth                       │       |
      |  │                                                 │       |
      |  │ Example: 100 Mbps link, 50ms RTT                │       |
      |  │   BDP = 100 Mbps × 0.05s = 625 KB              │       |
      |  │   Need cwnd ≥ 625 KB to saturate the link       │       |
      |  │   At ~12.5 MB/s, 50 MB takes ~4 seconds         │       |
      |  └─────────────────────────────────────────────────┘       |
      |                                                            |
      |  Segment-by-segment on the wire:                           |
      |                                                            |
      |  seq=2000000001  [1460 bytes]  ← TLS record fragment       |
      |  seq=2000001461  [1460 bytes]                              |
      |  seq=2000002921  [1460 bytes]                              |
      |    ... (batch of cwnd worth of segments)                   |
      |  ACK ack=2000014601  window=131072  →                      |
      |    ... (more segments)                                     |
      |  ACK ack=2000043801  window=262144  →  (window scaling)    |
      |    ... continues until 52,428,800 bytes delivered          |
      |                                                            |
      |  Total TCP segments for 50 MB body:                        |
      |    50 MB + TLS overhead ≈ 52.5 MB on wire                  |
      |    52,500,000 / 1460 ≈ 35,959 TCP segments                 |
      |                                                            |
      |  ============= HOW THE CLIENT KNOWS IT'S DONE ============ |
      |                                                            |
      |  The client counts bytes received after the headers.       |
      |  When byte_count == Content-Length (52,428,800),            |
      |  the response is complete. The connection can be reused    |
      |  for another request (HTTP/1.1 keep-alive).                |
      |                                                            |
      |  ============= CONNECTION CLOSE ============               |
      |  (if client is done — otherwise keep-alive)                |
      |                                                            |
      |  TLS: client sends close_notify alert                      |
      |  TLS: server sends close_notify alert                      |
      |                                                            |
 [10] |---- FIN  seq=1000000350 ack=54000000001 -------->          |
 [11] |<--- ACK  ack=1000000351 -------------------------          |
 [12] |<--- FIN  seq=54000000001 ack=1000000351 ---------          |
 [13] |---- ACK  ack=54000000002 ----------------------->          |
      |                                                            |
      |  Client enters TIME_WAIT (2×MSL, typically 60s)            |
      |  The 4-tuple (src_ip, src_port, dst_ip, dst_port) is       |
      |  reserved for 60s to prevent confusion with delayed        |
      |  segments from this connection.                            |
```

### Key Properties of Content-Length Delivery

- **The server knows the full body size before sending.** It reads the file, knows it is 52,428,800 bytes, and sets `Content-Length: 52428800`.
- **The client knows exactly how many bytes to expect.** It can show a progress bar, pre-allocate a buffer, and detect truncated responses (if the connection dies before all bytes arrive).
- **Connection reuse is clean.** Because both sides agree on the body boundary, the next request can begin immediately on the same TCP connection.
- **Range requests work.** The client can send `Range: bytes=26214400-` to resume a download from the halfway point. The server responds with `206 Partial Content` and `Content-Range: bytes 26214400-52428799/52428800`.

---

## Scenario 2: HTTP/1.1 with Chunked Transfer Encoding (Streaming Response)

### Complete End-to-End Flow

DNS resolution, TCP handshake, and TLS handshake are **identical** to Scenario 1. The flow diverges at the HTTP layer.

```
 Client (192.168.1.50)                                       Server (93.184.216.34:443)
      |                                                            |
      |  ====== DNS + TCP + TLS: same as Scenario 1 ======        |
      |                                                            |
      |  ============= HTTP REQUEST ============                   |
      |                                                            |
  [7] |---- TLS Application Data ---------------------->           |
      |                                                            |
      |       GET /api/v1/events HTTP/1.1\r\n                      |
      |       Host: api.example.com\r\n                            |
      |       Accept: text/event-stream\r\n                        |
      |       Cache-Control: no-cache\r\n                          |
      |       Connection: keep-alive\r\n                           |
      |       \r\n                                                 |
      |                                                            |
      |  ============= HTTP RESPONSE (HEADERS) ============        |
      |                                                            |
  [8] |<--- TLS Application Data -------------------------         |
      |                                                            |
      |       HTTP/1.1 200 OK\r\n                                  |
      |       Content-Type: text/event-stream\r\n                  |
      |       Transfer-Encoding: chunked\r\n                       |
      |       Cache-Control: no-cache\r\n                          |
      |       X-Accel-Buffering: no\r\n                            |
      |       Date: Thu, 12 Mar 2026 10:00:00 GMT\r\n              |
      |       \r\n                                                 |
      |                                                            |
      |  ============= CHUNKED BODY ============                   |
      |                                                            |
      |  Chunk wire format (RFC 9112 Section 7.1):                 |
      |    chunk = chunk-size CRLF chunk-data CRLF                 |
      |    chunk-size is hex digits                                |
      |    last-chunk = "0" CRLF CRLF                              |
      |                                                            |
      |  ---- Chunk 1: server has first event ready ----           |
      |                                                            |
  [9] |<--- TLS Application Data -------------------------         |
      |                                                            |
      |       2e\r\n                                               |
      |       data: {"event":"user.login","id":1001}\n\n\r\n      |
      |       ^^                                                   |
      |       0x2e = 46 bytes of chunk data                        |
      |                                                            |
      |  ---- 3 seconds pass, server produces next event ----      |
      |                                                            |
 [10] |<--- TLS Application Data -------------------------         |
      |                                                            |
      |       35\r\n                                               |
      |       data: {"event":"order.created","id":1002}\n\n\r\n   |
      |       ^^                                                   |
      |       0x35 = 53 bytes of chunk data                        |
      |                                                            |
      |  ---- 500ms pass ----                                      |
      |                                                            |
 [11] |<--- TLS Application Data -------------------------         |
      |                                                            |
      |       3a\r\n                                               |
      |       data: {"event":"payment.processed","id":1003}\n\n\r\n|
      |       ^^                                                   |
      |       0x3a = 58 bytes of chunk data                        |
      |                                                            |
      |  ---- Irregular timing: events arrive when produced ----   |
      |  ---- Could be milliseconds or minutes between chunks ---- |
      |                                                            |
      |  ...many chunks later...                                   |
      |                                                            |
      |  ---- Server closes the stream ----                        |
      |                                                            |
 [N]  |<--- TLS Application Data -------------------------         |
      |                                                            |
      |       0\r\n                                                |
      |       \r\n                                                 |
      |       ^^ zero-length chunk = end of body                   |
      |                                                            |
      |  ============= TCP BEHAVIOR DURING CHUNKED ============    |
      |                                                            |
      |  Unlike Scenario 1 where TCP sends a continuous blast of   |
      |  segments, here TCP sends small bursts when data is        |
      |  available. Between chunks, the TCP connection is idle     |
      |  (no segments flowing, but the connection remains open).   |
      |                                                            |
      |  Chunk 1 (46 bytes + framing ≈ 52 bytes):                  |
      |    → fits in 1 TCP segment                                 |
      |    ← 1 ACK                                                 |
      |                                                            |
      |  [3 second gap — TCP keepalive may fire if configured]     |
      |                                                            |
      |  Chunk 2 (53 bytes + framing ≈ 59 bytes):                  |
      |    → fits in 1 TCP segment                                 |
      |    ← 1 ACK                                                 |
      |                                                            |
      |  TCP's congestion window is irrelevant here because the    |
      |  data rate is limited by the application, not the network. |
      |  cwnd may decay during idle periods (RFC 7661).            |
      |                                                            |
      |  ============= CONNECTION CLOSE ============               |
      |  Same FIN/ACK sequence as Scenario 1.                      |
```

### Detailed Chunk Wire Format

Each chunk on the wire looks like this at the byte level:

```
 Chunk frame (example: 1024-byte payload):
 ┌──────────────────────────────────────────────────┐
 │ "400"       ← chunk size in hex (3 ASCII bytes)  │
 │ "\r\n"      ← CRLF (2 bytes)                     │
 │ <1024 bytes of actual data>                      │
 │ "\r\n"      ← CRLF (2 bytes)                     │
 └──────────────────────────────────────────────────┘
 Total on wire: 3 + 2 + 1024 + 2 = 1031 bytes

 Terminator chunk:
 ┌──────────────────────────────────────────────────┐
 │ "0"         ← chunk size zero (1 ASCII byte)     │
 │ "\r\n"      ← CRLF (2 bytes)                     │
 │ "\r\n"      ← trailing CRLF (2 bytes)            │
 └──────────────────────────────────────────────────┘
 Total: 5 bytes

 Optional trailers can appear between the last CRLF pair:
 ┌──────────────────────────────────────────────────┐
 │ "0\r\n"                                          │
 │ "Checksum: sha256=abc123...\r\n"                 │
 │ "\r\n"                                           │
 └──────────────────────────────────────────────────┘
```

### Key Properties of Chunked Delivery

- **The server does not know the total size.** It cannot set `Content-Length`. The client cannot show a percentage progress bar — only a byte counter.
- **The client discovers chunk boundaries from the hex size prefix.** But most HTTP libraries hide this — `response.Body.Read()` in Go returns decoded bytes with no chunk framing visible to application code.
- **Connection reuse is still possible.** After the `0\r\n\r\n` terminator, the connection is ready for the next request. This is a critical advantage over HTTP/1.0 connection-close streaming.
- **Range requests do not work.** There is no `Content-Length` to define byte ranges against. Resuming a failed chunked transfer requires application-level logic (e.g., SSE `Last-Event-ID`).
- **Nagle's algorithm interaction.** Small chunks (a few bytes) may be delayed by Nagle's algorithm, which buffers small writes to form larger segments. Servers streaming SSE typically set `TCP_NODELAY` on the socket to disable Nagle and ensure each chunk (even if tiny) is sent immediately in its own segment.

---

## Scenario 3: HTTP/2 with Multiplexed Streams

### Complete End-to-End Flow

DNS and TCP are identical. The TLS handshake differs only in ALPN negotiation — the server selects `h2` instead of `http/1.1`. After TLS, the protocol is fundamentally different.

```
 Client (192.168.1.50)                                       Server (93.184.216.34:443)
      |                                                            |
      |  ====== DNS + TCP: same as Scenario 1 ======               |
      |                                                            |
      |  ====== TLS: same, except ALPN selects h2 ======           |
      |  ClientHello ALPN: [h2, http/1.1]                          |
      |  ServerHello / EncryptedExtensions ALPN: h2                |
      |                                                            |
      |  ============= HTTP/2 CONNECTION PREFACE ============      |
      |                                                            |
  [7] |---- Connection Preface (magic + SETTINGS) -------->        |
      |                                                            |
      |     "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"                    |
      |     (24-byte magic string — RFC 9113 Section 3.4)          |
      |                                                            |
      |     Frame: SETTINGS (type=0x04, stream=0, flags=0x00)      |
      |       SETTINGS_MAX_CONCURRENT_STREAMS = 100                |
      |       SETTINGS_INITIAL_WINDOW_SIZE = 1048576 (1 MB)        |
      |       SETTINGS_MAX_FRAME_SIZE = 16384                      |
      |       SETTINGS_HEADER_TABLE_SIZE = 4096                    |
      |       SETTINGS_ENABLE_PUSH = 0                             |
      |                                                            |
  [8] |<--- Frame: SETTINGS (server's settings) -----------        |
      |       SETTINGS_MAX_CONCURRENT_STREAMS = 128                |
      |       SETTINGS_INITIAL_WINDOW_SIZE = 65535                  |
      |       SETTINGS_MAX_FRAME_SIZE = 16384                      |
      |       SETTINGS_HEADER_TABLE_SIZE = 4096                    |
      |                                                            |
  [9] |---- Frame: SETTINGS ACK (flags=0x01) ------------>         |
 [10] |<--- Frame: SETTINGS ACK (flags=0x01) ---------------       |
      |                                                            |
      |  ============= REQUEST 1 (Stream 1) ============           |
      |                                                            |
 [11] |---- Frame: HEADERS (type=0x01, stream=1) -------->         |
      |     Flags: END_HEADERS (0x04)                              |
      |     HPACK-encoded header block:                            |
      |       :method = GET      (indexed: 0x82)                   |
      |       :scheme = https    (indexed: 0x87)                   |
      |       :path = /api/users (literal, name indexed: 0x04)     |
      |       :authority = api.example.com (literal, name idx 0x01)|
      |       accept = application/json  (literal)                 |
      |       authorization = Bearer eyJhbG... (literal, sensitive)|
      |                                                            |
      |  ============= REQUEST 2 (Stream 3) ============           |
      |  Client sends second request WITHOUT waiting for           |
      |  response to stream 1 — this is multiplexing.              |
      |  Stream IDs are odd numbers for client-initiated.          |
      |                                                            |
 [12] |---- Frame: HEADERS (type=0x01, stream=3) -------->         |
      |     Flags: END_HEADERS (0x04)                              |
      |     HPACK-encoded header block:                            |
      |       :method = GET       (indexed: 0x82)                  |
      |       :scheme = https     (indexed: 0x87)                  |
      |       :path = /api/orders (literal, name indexed)          |
      |       :authority = api.example.com (HPACK dynamic table    |
      |                    — reuses prior encoding, very compact)  |
      |       accept = application/json  (dynamic table hit)       |
      |       authorization = Bearer eyJhbG... (dynamic table hit) |
      |                                                            |
      |  ============= REQUEST 3 (Stream 5) ============           |
      |                                                            |
 [13] |---- Frame: HEADERS (type=0x01, stream=5) -------->         |
      |     Flags: END_HEADERS | END_STREAM (0x05)                 |
      |     (END_STREAM because GET has no body)                   |
      |       :method = GET                                        |
      |       :path = /api/products                                |
      |       ... (other headers via HPACK)                        |
      |                                                            |
      |  ============= RESPONSES (INTERLEAVED) ============        |
      |                                                            |
      |  The server responds to whichever request it processes     |
      |  first. Responses can interleave frame-by-frame.           |
      |                                                            |
 [14] |<--- Frame: HEADERS (stream=3) ----------------------       |
      |     Flags: END_HEADERS (0x04)                              |
      |       :status = 200                                        |
      |       content-type = application/json                      |
      |       (no content-length — optional in HTTP/2)             |
      |                                                            |
 [15] |<--- Frame: DATA (stream=3) -------------------------       |
      |     Flags: END_STREAM (0x01)                               |
      |     Length: 2048                                            |
      |     Payload: {"orders":[{"id":1,...},{"id":2,...},...]}     |
      |     ^^ Stream 3 is now complete                            |
      |                                                            |
 [16] |<--- Frame: HEADERS (stream=1) ----------------------       |
      |     Flags: END_HEADERS (0x04)                              |
      |       :status = 200                                        |
      |       content-type = application/json                      |
      |                                                            |
 [17] |<--- Frame: DATA (stream=1) -------------------------       |
      |     Length: 16384 (max frame size)                          |
      |     Flags: 0x00 (more data coming)                         |
      |     Payload: {"users":[{"id":1,"name":"Alice",...          |
      |                                                            |
 [18] |<--- Frame: DATA (stream=5) -------------------------       |
      |     Length: 8192                                            |
      |     Flags: 0x00                                            |
      |     Payload: {"products":[{"id":1,...                       |
      |     ^^ Stream 5 response begins BETWEEN stream 1 frames   |
      |                                                            |
 [19] |<--- Frame: DATA (stream=1) -------------------------       |
      |     Length: 12000                                           |
      |     Flags: END_STREAM (0x01)                               |
      |     Payload: ...,"name":"Zara"}]}                          |
      |     ^^ Stream 1 is now complete                            |
      |                                                            |
 [20] |<--- Frame: DATA (stream=5) -------------------------       |
      |     Length: 4096                                            |
      |     Flags: END_STREAM (0x01)                               |
      |     Payload: ...}]}                                        |
      |     ^^ Stream 5 is now complete                            |
      |                                                            |
      |  ============= FLOW CONTROL ============                   |
      |                                                            |
      |  HTTP/2 has TWO levels of flow control:                    |
      |    1. Per-connection window (stream 0)                     |
      |    2. Per-stream window                                    |
      |                                                            |
      |  Initial window = SETTINGS_INITIAL_WINDOW_SIZE             |
      |  (default 65535 bytes per RFC 9113 Section 6.9.2)          |
      |                                                            |
      |  After receiving 32768 bytes on stream 1:                  |
      |                                                            |
 [21] |---- Frame: WINDOW_UPDATE (stream=1) ------------->         |
      |     Window Size Increment: 32768                           |
      |                                                            |
 [22] |---- Frame: WINDOW_UPDATE (stream=0) ------------->         |
      |     Window Size Increment: 32768                           |
      |     ^^ Connection-level window must also be updated        |
      |                                                            |
      |  ============= CONNECTION CLOSE ============               |
      |                                                            |
 [23] |---- Frame: GOAWAY (stream=0) -------------------->         |
      |     Last-Stream-ID: 5                                      |
      |     Error Code: NO_ERROR (0x00)                            |
      |     ^^ "I won't start new streams; finish existing ones"   |
      |                                                            |
      |  Then TCP FIN/ACK as in Scenario 1.                        |
```

### HTTP/2 Frame Structure on the Wire

Every HTTP/2 frame has a fixed 9-byte header:

```
 HTTP/2 Frame Layout (RFC 9113 Section 4.1):
 ┌───────────────────────────────────────────────────────┐
 │  Length (24 bits)   │  Type (8 bits)  │ Flags (8 bits)│
 ├───────────────────────────────────────────────────────┤
 │ R │            Stream Identifier (31 bits)            │
 ├───────────────────────────────────────────────────────┤
 │                   Frame Payload                       │
 │               (Length bytes)                          │
 └───────────────────────────────────────────────────────┘

 Type values:
   0x00 = DATA           0x04 = SETTINGS     0x08 = WINDOW_UPDATE
   0x01 = HEADERS        0x05 = PUSH_PROMISE 0x09 = CONTINUATION
   0x02 = PRIORITY       0x06 = PING
   0x03 = RST_STREAM     0x07 = GOAWAY

 Example DATA frame in hex (8192-byte payload on stream 1):
   00 20 00    ← Length: 8192 (0x002000)
   00          ← Type: DATA
   00          ← Flags: none
   00 00 00 01 ← Stream ID: 1
   [8192 bytes of payload]

 Example HEADERS frame in hex:
   00 00 2a    ← Length: 42 bytes of HPACK data
   01          ← Type: HEADERS
   04          ← Flags: END_HEADERS
   00 00 00 01 ← Stream ID: 1
   [42 bytes of HPACK-encoded headers]
```

### HPACK Header Compression

HTTP/2 uses HPACK (RFC 7541) to compress headers. It maintains a dynamic table shared between encoder and decoder across all streams on a connection.

```
 Static table (predefined, 61 entries):
   Index 2:  :method = GET
   Index 3:  :method = POST
   Index 4:  :path = /
   Index 5:  :path = /index.html
   Index 7:  :scheme = https
   Index 8:  :status = 200
   ...

 First request on the connection:
   :method = GET           → 0x82 (indexed, 1 byte)
   :scheme = https         → 0x87 (indexed, 1 byte)
   :path = /api/users      → 0x04 0x0A "/api/users" (literal with name index)
   :authority = api.example.com → literal, ~18 bytes
   authorization = Bearer eyJ... → literal, sensitive (never indexed)

 Second request (same connection):
   :method = GET           → 0x82 (1 byte)
   :scheme = https         → 0x87 (1 byte)
   :path = /api/orders     → 0x04 0x0B "/api/orders" (literal, 14 bytes)
   :authority = api.example.com → 0xBE or similar (dynamic table hit, 1 byte!)
   authorization = ...     → still literal (sensitive, not indexed)

 Savings: headers that repeat across requests (Host, Accept, Auth scheme)
 compress to 1-2 bytes each after the first request.
```

---

## Layer-by-Layer Comparison

### DNS and TCP (Identical Across All Three)

| Aspect | Content-Length | Chunked | HTTP/2 |
|--------|---------------|---------|--------|
| DNS | Same | Same | Same |
| TCP handshake | 3-way, identical | 3-way, identical | 3-way, identical |
| TCP MSS | 1460 (Ethernet) | 1460 | 1460 |
| TCP segments | Identical format | Identical format | Identical format |

The TCP layer has no idea what HTTP version is running above it. It transports bytes.

### TLS (Nearly Identical)

| Aspect | Content-Length | Chunked | HTTP/2 |
|--------|---------------|---------|--------|
| TLS version | 1.3 | 1.3 | 1.3 |
| Handshake | Identical | Identical | Identical |
| ALPN negotiated | `http/1.1` | `http/1.1` | `h2` |
| Record max size | 16,384 bytes | 16,384 bytes | 16,384 bytes |
| Record overhead | 5 hdr + 16 auth tag = 21 bytes | Same | Same |

The only TLS difference is the ALPN extension result. TLS records wrap HTTP data identically regardless of HTTP version.

### HTTP Layer (Where Everything Differs)

| Aspect | Content-Length | Chunked | HTTP/2 |
|--------|---------------|---------|--------|
| **Body size known upfront** | Yes | No | Optional (`content-length` header is allowed but not required) |
| **How receiver detects end-of-body** | Byte count matches `Content-Length` | Zero-length chunk `0\r\n\r\n` | `END_STREAM` flag on last `DATA` frame |
| **Progress bar possible** | Yes (bytes received / total) | Bytes-only counter | Yes if `content-length` header present |
| **Connection reuse** | Yes, after body ends | Yes, after terminator chunk | N/A — streams multiplex on one connection |
| **Concurrent requests** | No (one at a time per connection; pipeline rarely used) | No | Yes — hundreds of concurrent streams |
| **Head-of-line blocking** | Yes — slow response blocks subsequent requests | Yes | No at HTTP layer (still exists at TCP layer) |
| **Header compression** | None (headers sent as ASCII every time) | None | HPACK — subsequent requests compress dramatically |
| **Flow control** | TCP only | TCP only | TCP + HTTP/2 per-stream + per-connection |
| **Range/resume** | Yes (`Range` header) | No | Yes if server supports it |
| **Framing overhead per chunk/frame** | None (raw bytes after headers) | Hex size + 2 CRLFs per chunk (~6-10 bytes) | 9-byte frame header per DATA frame |

### TCP Segment Patterns on the Wire

```
 Content-Length (50 MB file):
 ┌──────────────────────────────────────────────────────────────┐
 │ Time →                                                      │
 │ ████████████████████████████████████████████████████████████ │
 │ Continuous blast of TCP segments, limited only by cwnd/rwnd │
 │ Slow start → ramp up → steady state → done                 │
 │ ~36,000 segments over ~4 seconds                            │
 └──────────────────────────────────────────────────────────────┘

 Chunked (SSE events):
 ┌──────────────────────────────────────────────────────────────┐
 │ Time →                                                      │
 │ █·········█····█·······················█···█·········█··     │
 │ Sparse bursts: 1 segment per event, long idle gaps          │
 │ cwnd resets during idle periods                             │
 │ Possibly hundreds of segments over hours                    │
 └──────────────────────────────────────────────────────────────┘

 HTTP/2 (3 multiplexed requests):
 ┌──────────────────────────────────────────────────────────────┐
 │ Time →                                                      │
 │ ██████████████████████  (moderate burst)                     │
 │ Interleaved frames from different streams packed into        │
 │ TCP segments. Multiple frames can share one segment.         │
 │ Or one large DATA frame spans multiple segments.             │
 └──────────────────────────────────────────────────────────────┘
```

---

## Slow Network Behavior

### Content-Length on a Congested Network

When packet loss occurs during a 50 MB download:

```
 Normal:     cwnd grows: 10 → 20 → 40 → 80 → 160 → ...
 Packet loss detected (3 duplicate ACKs or timeout):
   - CUBIC/Reno: cwnd halved → 80, then linear growth resumes
   - BBR: does not react to isolated loss the same way;
          maintains rate based on measured bandwidth

 Timeline with 2% packet loss on 100 Mbps link:
 ┌──────────────────────────────────────────────────────┐
 │ 0.0s  TCP handshake + TLS                           │
 │ 0.1s  Slow start begins (cwnd=14,600)               │
 │ 0.3s  cwnd ≈ 116 KB                                 │
 │ 0.5s  cwnd ≈ 500 KB — packet loss! cwnd → 250 KB    │
 │ 0.6s  Retransmit, resume congestion avoidance        │
 │ 1.2s  cwnd recovers to 500 KB — another loss         │
 │  ...  Saw-tooth pattern: grow → loss → halve → grow  │
 │ 8.0s  Download complete (2× slower than ideal)       │
 └──────────────────────────────────────────────────────┘
```

### Chunked on a Congested Network

For small SSE events, congestion is rarely an issue — each event fits in one TCP segment. The real problems are:

1. **Idle connection timeout.** Proxies or NATs may close connections that have no traffic for 60-120 seconds. SSE servers send comment lines (`: keepalive\n\n`) as heartbeats.
2. **TCP keepalive probes.** If `SO_KEEPALIVE` is set, the OS sends TCP keepalive probes after idle periods (default 2 hours on Linux, configurable via `tcp_keepalive_time`). These are distinct from HTTP-level keepalives.
3. **Nagle + delayed ACK interaction.** If Nagle's algorithm is enabled and the receiver uses delayed ACKs (waits 40ms before ACK-ing), a small write can be delayed by up to 40ms. Fix: `TCP_NODELAY` on the sending socket.

### HTTP/2 on a Congested Network

HTTP/2 has a unique problem: **TCP-level head-of-line blocking**. All streams share one TCP connection. If a TCP segment carrying Stream 1 data is lost:

```
 TCP segment sequence:
   Seg 100: [Stream 1 DATA] [Stream 3 DATA fragment]
   Seg 101: [Stream 3 DATA continued] [Stream 5 DATA]   ← arrives
   Seg 102: [Stream 5 DATA]                              ← arrives
   Seg 100: LOST

 TCP must deliver in order. Segments 101 and 102 are buffered in
 the kernel's receive buffer, but the application cannot read them
 until segment 100 is retransmitted and received.

 Result: ALL streams stall, even though only Stream 1's data
 was in the lost segment. Streams 3 and 5 are collateral damage.

 This is WORSE than HTTP/1.1 with 6 parallel connections, where
 only 1 of 6 connections would stall on a lost packet.
```

This is the primary motivation for HTTP/3 (QUIC), which runs streams over independent UDP-based transport flows, eliminating TCP-level head-of-line blocking.

HTTP/2 flow control can also cause issues. If the client's per-stream window for Stream 1 reaches zero (client not consuming data fast enough), the server pauses sending Stream 1 data — but the connection-level window may also fill, blocking ALL streams:

```
 Connection window: 65535 bytes remaining
 Stream 1 window:   0 bytes remaining     ← client not reading stream 1
 Stream 3 window:   65535 bytes remaining
 Stream 5 window:   65535 bytes remaining

 Server wants to send on Stream 3, but the connection-level
 window is also exhausted (Stream 1 consumed it all).
 ALL streams stall until the client sends WINDOW_UPDATE for
 both Stream 1 and the connection (stream 0).
```

Well-implemented clients (browsers, Go's `net/http`) aggressively send `WINDOW_UPDATE` frames to prevent this. Poorly implemented clients can deadlock HTTP/2 connections.

---

## How the Client Application Receives Data

### Content-Length: Read Until Done

```go
// Go: reading a Content-Length response
resp, _ := http.Get("https://files.example.com/app-v2.1.0.tar.gz")
defer resp.Body.Close()

// resp.ContentLength == 52428800
file, _ := os.Create("app-v2.1.0.tar.gz")
written, _ := io.Copy(file, resp.Body)
// io.Copy reads from resp.Body in 32KB chunks internally
// and writes to the file. It returns when resp.Body is exhausted
// (all 52,428,800 bytes read) or on error.

fmt.Printf("Downloaded %d bytes\n", written)
// Output: Downloaded 52428800 bytes
```

The application sees a single, continuous byte stream. `resp.Body.Read()` returns bytes as TCP delivers them. `io.Copy` loops calling `Read` until `io.EOF`.

### Chunked: Read Incrementally

```go
// Go: reading a chunked/SSE response incrementally
resp, _ := http.Get("https://api.example.com/events")
defer resp.Body.Close()

// resp.ContentLength == -1 (unknown)
// Go's HTTP client transparently decodes chunked encoding.
// The application never sees chunk size prefixes or CRLFs.

scanner := bufio.NewScanner(resp.Body)
for scanner.Scan() {
    line := scanner.Text()
    if strings.HasPrefix(line, "data: ") {
        event := line[6:]
        processEvent(event)
        // Each call to scanner.Scan() may block for seconds or
        // minutes waiting for the next chunk from the server.
    }
}
```

```javascript
// Browser: reading a chunked response with fetch
const response = await fetch('/api/events');
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // value is a Uint8Array — one or more chunks decoded
  // The browser buffers and may coalesce multiple chunks
  // into a single read() result
  const text = decoder.decode(value, { stream: true });
  console.log(text);
}
```

### HTTP/2: Multiplexed Streams Demultiplexed by the Client Library

```go
// Go: HTTP/2 is transparent — same API as HTTP/1.1
// Go's http.Client uses HTTP/2 automatically for HTTPS.

// These three requests run concurrently on ONE TCP connection:
var wg sync.WaitGroup
for _, path := range []string{"/api/users", "/api/orders", "/api/products"} {
    wg.Add(1)
    go func(p string) {
        defer wg.Done()
        resp, _ := http.Get("https://api.example.com" + p)
        defer resp.Body.Close()
        body, _ := io.ReadAll(resp.Body)
        fmt.Printf("%s: %d bytes\n", p, len(body))
    }(path)
}
wg.Wait()

// Under the hood:
// 1. First goroutine triggers TCP + TLS + HTTP/2 connection setup
// 2. All three goroutines share the same *http2.ClientConn
// 3. Each request gets its own stream ID (1, 3, 5)
// 4. Response DATA frames are demultiplexed by stream ID and
//    delivered to the correct goroutine's resp.Body reader
// 5. Flow control WINDOW_UPDATE frames are sent automatically
```

```javascript
// Browser: HTTP/2 multiplexing is automatic
// These three fetch() calls use ONE TCP connection to the same origin:
const [users, orders, products] = await Promise.all([
  fetch('/api/users').then(r => r.json()),
  fetch('/api/orders').then(r => r.json()),
  fetch('/api/products').then(r => r.json()),
]);
// The browser's HTTP/2 stack handles stream multiplexing,
// HPACK compression, flow control, and priority internally.
// To the application, it looks like three independent requests.
```

---

## The Full Picture: One Diagram to Rule Them All

```
                        Content-Length         Chunked              HTTP/2
                        ──────────────         ───────              ──────

 DNS Lookup             ← identical across all three →

 TCP Handshake          ← identical across all three →
   SYN →
   ← SYN-ACK
   ACK →

 TLS 1.3 Handshake      ← identical except ALPN result →
   ClientHello →         ALPN: http/1.1        ALPN: http/1.1     ALPN: h2
   ← ServerHello
   ← EncryptedExtensions
   ← Certificate
   ← CertificateVerify
   ← Finished
   Finished →

 Connection Setup        (none)                 (none)              SETTINGS exchange
                                                                    Connection preface

 Request                 ASCII headers           ASCII headers      HPACK-compressed
                         GET ... HTTP/1.1        GET ... HTTP/1.1   HEADERS frame
                         Host: ...               Host: ...          :method, :path, etc.
                         Content-Length: N        (no CL)

 Response Headers        ASCII headers           ASCII headers      HEADERS frame
                         Content-Length: 52M      Transfer-Encoding: :status = 200
                                                  chunked

 Body Delivery           Raw bytes after         Chunk-framed:      DATA frames:
                         headers, counted        hex\r\n            9-byte header +
                         to Content-Length        data\r\n           payload, with
                                                 0\r\n\r\n          END_STREAM flag

 End-of-Body Signal      Byte count matches      Zero-length        END_STREAM flag
                         Content-Length           chunk

 Concurrency             1 request at a time     1 request at a     100+ concurrent
                         (or pipelining, rare)   time                streams

 Connection Close        FIN/ACK                  FIN/ACK            GOAWAY + FIN/ACK
```

---

## See also

- [[notes/Networking/tcp-packets-vs-http-chunks-vs-streaming|TCP Packets vs HTTP Chunks vs Streaming]] — clarifies the transport/application boundary
- [[notes/Networking/http-streaming-directionality|HTTP Streaming Directionality]] — client vs server streaming, bidirectional, browser limitations
- [[notes/Networking/http_streaming|HTTP Streaming]] — SSE, WebSockets, gRPC streaming
- [[notes/Networking/proxies-and-tls-termination|Proxies & TLS Termination]] — how proxies interact with each of these scenarios
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110) — content, content-length, transfer coding
- [RFC 9112: HTTP/1.1](https://www.rfc-editor.org/rfc/rfc9112) — chunked transfer encoding (Section 7.1), message body length (Section 6)
- [RFC 9113: HTTP/2](https://www.rfc-editor.org/rfc/rfc9113) — framing layer (Section 4), flow control (Section 5.2), HPACK usage
- [RFC 7541: HPACK](https://www.rfc-editor.org/rfc/rfc7541) — header compression for HTTP/2
- [RFC 8446: TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446) — handshake, key schedule, record protocol
- [RFC 9293: TCP](https://www.rfc-editor.org/rfc/rfc9293) — segment structure, connection management
- [RFC 5681: TCP Congestion Control](https://www.rfc-editor.org/rfc/rfc5681) — slow start, congestion avoidance
- [RFC 9000: QUIC](https://www.rfc-editor.org/rfc/rfc9000) — HTTP/3 transport, eliminates TCP HOL blocking

---

## Interview Prep

### Q: Walk through the complete sequence of events when a browser navigates to `https://example.com/file.tar.gz` and downloads a 50 MB file. Cover every layer.

**A:** The sequence proceeds through five phases: DNS, TCP, TLS, HTTP, and body transfer.

**DNS:** The browser checks its DNS cache, then the OS resolver cache, then queries the configured DNS resolver (e.g., 8.8.8.8). A recursive lookup resolves `example.com` to an IP like `93.184.216.34`. If the record is cached (typical TTL: 60-300s), this step is skipped. The result is an IP address.

**TCP:** The browser's networking stack opens a socket and initiates a 3-way handshake: SYN (client picks an ISN, say 1000000000), SYN-ACK (server responds with its ISN, say 2000000000, and ACKs client's ISN+1), ACK (client acknowledges server's ISN+1). Both sides negotiate MSS (typically 1460 bytes on Ethernet), window scaling (enabling receive windows up to 1 GB), and SACK (selective acknowledgments for efficient retransmission). This takes 1 RTT.

**TLS 1.3:** The client sends ClientHello containing: supported cipher suites (e.g., TLS_AES_256_GCM_SHA384), a key_share extension with an x25519 public key, the supported_versions extension listing TLS 1.3, and the SNI extension with the hostname. The server responds with ServerHello (selecting the cipher suite and providing its key_share), then immediately sends EncryptedExtensions (including ALPN — `http/1.1` or `h2`), Certificate (the X.509 cert chain), CertificateVerify (a signature proving possession of the private key), and Finished (an HMAC over the handshake transcript). All of these after ServerHello are encrypted with handshake-derived keys. The client verifies the certificate chain against its trust store, verifies the CertificateVerify signature, verifies the Finished HMAC, then sends its own Finished. Total: 1 additional RTT. Combined with TCP, the connection is ready after 2 RTTs (or 1 RTT if TLS 1.3 0-RTT resumption is used).

**HTTP Request:** Inside a TLS Application Data record, the client sends: `GET /file.tar.gz HTTP/1.1\r\nHost: example.com\r\n...headers...\r\n\r\n`.

**HTTP Response + Body:** The server responds with `200 OK`, `Content-Length: 52428800`, and begins sending the body. TCP segments the body into ~1460-byte segments. TCP slow start begins with an initial congestion window of 10 segments (14,600 bytes per RFC 6928), doubling each RTT. After about 5 RTTs on a 50ms link, the congestion window reaches ~460 KB. Growth then transitions to linear (congestion avoidance). On a 100 Mbps link, the pipe fills when cwnd exceeds the bandwidth-delay product (625 KB), and the download sustains ~12.5 MB/s, completing in about 4 seconds. The client counts received bytes against `Content-Length` and knows the download is complete when they match.

**Teardown:** TLS close_notify alerts are exchanged, then TCP FIN/ACK. The client enters TIME_WAIT for 2xMSL (typically 60 seconds).

### Q: What is the difference between how TCP delivers data for a Content-Length response vs a Chunked response?

**A:** At the TCP layer, there is zero difference. TCP is a byte-stream protocol — it segments application data into MSS-sized packets regardless of what that data represents. TCP does not know or care about HTTP headers, chunk boundaries, or content length.

The difference is entirely in the **application-layer data pattern** that TCP is asked to carry:

For Content-Length, the server has the entire 50 MB file ready (or can read it from disk at wire speed). It writes continuously to the socket, and TCP sends a continuous blast of segments, limited only by the congestion window and receiver window. The pipe is saturated.

For chunked encoding (e.g., SSE events), the server writes small amounts of data (tens to hundreds of bytes) at irregular intervals driven by application events. TCP sends a tiny burst (often just 1 segment) per event, then the connection is idle until the next event. The congestion window may decay during idle periods (RFC 7661 recommends restarting slow start after an idle period exceeding 1 RTO). This means after a long gap between events, the first few segments of a large burst may be sent slowly.

The framing overhead is also different: Content-Length has zero framing overhead in the body — raw bytes flow after the headers. Chunked encoding adds hex-size + CRLF + CRLF per chunk (typically 6-10 bytes of overhead per chunk). For SSE with small events, this can be 10-20% overhead. For large chunks, it is negligible.

### Q: Why does HTTP/2 still suffer from head-of-line blocking despite having stream multiplexing?

**A:** HTTP/2 eliminates head-of-line blocking at the **HTTP layer** but not at the **TCP layer**. Multiple logical streams are multiplexed onto a single TCP connection. If a TCP segment is lost, TCP's in-order delivery guarantee prevents the kernel from delivering any subsequent data to the application — even data belonging to completely independent streams that was in later, successfully-received segments.

Consider: the server sends DATA frames for streams 1, 3, and 5 interleaved. These frames are packed into TCP segments. If TCP segment #100 (carrying part of stream 1's data) is lost, segments #101 and #102 (carrying stream 3 and stream 5 data) arrive fine but are held in the kernel's receive buffer. The HTTP/2 library cannot read them until segment #100 is retransmitted (which takes at minimum 1 RTT, and more if the retransmission timer fires).

With HTTP/1.1, browsers open 6 parallel TCP connections. A loss on one connection stalls only that connection's request. The other 5 connections continue unaffected. Under moderate packet loss (1-2%), HTTP/1.1 with 6 connections can actually outperform HTTP/2 with 1 connection.

This is the fundamental reason HTTP/3 uses QUIC instead of TCP. QUIC provides independent byte streams over UDP — a lost packet on stream 1 does not block delivery on streams 3 or 5. Each QUIC stream has its own reassembly buffer.

### Q: In TLS 1.3, what exactly goes in each "flight" of the handshake, and why is it faster than TLS 1.2?

**A:** TLS 1.3 completes in 1 RTT (versus 2 RTTs for TLS 1.2). The handshakes differ structurally:

**TLS 1.3 — Flight 1 (Client to Server):** ClientHello contains everything the server needs to derive keys: cipher suite list, key_share (the client's ephemeral public key for the selected group, e.g., x25519), and supported_versions listing `0x0304` (TLS 1.3). The critical change from TLS 1.2 is that the client sends its key share *in the first message*, not after negotiation.

**TLS 1.3 — Flight 2 (Server to Client):** ServerHello selects the cipher suite and provides the server's key_share. At this point, both sides can compute the handshake secret (ECDHE shared secret from the two key_shares). Everything after ServerHello in this flight is encrypted: EncryptedExtensions (ALPN, etc.), Certificate, CertificateVerify, and Finished. All of these travel in a single flight because the server already has everything it needs from the ClientHello.

**TLS 1.3 — Flight 3 (Client to Server):** Client Finished (HMAC proving key derivation). After this, application data flows.

In TLS 1.2, the client sends ClientHello, the server responds with ServerHello + Certificate + ServerKeyExchange + ServerHelloDone (Flight 2), then the client sends ClientKeyExchange + ChangeCipherSpec + Finished (Flight 3), and the server sends ChangeCipherSpec + Finished (Flight 4). That is 2 full RTTs before application data.

TLS 1.3 saves a full RTT by having the client speculatively send its key share in ClientHello, eliminating the separate "server says which group, client generates key" round trip.

TLS 1.3 also supports **0-RTT resumption**: if the client has a PSK (pre-shared key) from a previous session, it can send application data in the ClientHello flight itself. The server processes this "early data" before completing the handshake. The trade-off: 0-RTT data is not forward-secret and is vulnerable to replay attacks, so it should only be used for idempotent requests.

### Q: How does HTTP/2 flow control differ from TCP flow control, and can they conflict?

**A:** TCP and HTTP/2 both implement flow control, but at different layers and for different purposes:

**TCP flow control** (receiver window / rwnd) prevents the sender from overwhelming the receiver's kernel buffer. It operates per-connection. The receiver advertises how many bytes it can buffer, and the sender does not exceed this. TCP flow control is mandatory and cannot be disabled.

**HTTP/2 flow control** operates at two levels: per-stream and per-connection. It prevents one stream from consuming all of the shared connection's resources. The initial window size is negotiated via SETTINGS (default: 65,535 bytes per RFC 9113 Section 6.9.2). The receiver sends `WINDOW_UPDATE` frames to extend the window. HTTP/2 flow control applies only to DATA frames, not to HEADERS, SETTINGS, or other control frames.

They can conflict in several ways:

1. **HTTP/2 window smaller than TCP rwnd:** The server has data ready, TCP has room to send (rwnd is large), but the HTTP/2 stream window is zero. The data sits in the HTTP/2 layer's buffer, not sent. The application perceives a stall even though the network is fine.

2. **TCP rwnd smaller than HTTP/2 window:** The HTTP/2 layer thinks it can send (stream window is open), but TCP cannot transmit because the receiver's kernel buffer is full (rwnd = 0). TCP handles this transparently — the HTTP/2 layer's write call blocks until TCP can accept more data.

3. **Connection-level starvation:** The HTTP/2 connection-level window is shared across all streams. If a client opens 100 streams and is slow to send WINDOW_UPDATE on the connection level, all streams can starve even if individual stream windows are open. A well-implemented client sends connection-level WINDOW_UPDATE proactively (e.g., when half the window is consumed).

The most common real-world issue is a naive HTTP/2 client that reads stream 1 slowly (causing stream 1's window to fill), which indirectly exhausts the connection window, blocking all other streams. This is a form of head-of-line blocking at the flow control layer — distinct from the TCP HOL blocking discussed earlier, but equally problematic.

### Q: What happens if a 50 MB download over Content-Length is interrupted halfway (TCP connection drops)? How does the client know, and what can it do?

**A:** The client has received 25 MB but `Content-Length` says 52,428,800 bytes. The HTTP library detects the premature EOF — `resp.Body.Read()` returns an error (e.g., `io.ErrUnexpectedEOF` in Go, or a network error). The client knows the response is incomplete because bytes received < Content-Length.

For resumption, the client can use HTTP Range Requests (RFC 9110 Section 14.2). It sends:

```
GET /file.tar.gz HTTP/1.1
Host: files.example.com
Range: bytes=26214400-
```

If the server supports ranges (indicated by `Accept-Ranges: bytes` in the original response), it responds with:

```
HTTP/1.1 206 Partial Content
Content-Range: bytes 26214400-52428799/52428800
Content-Length: 26214400
```

And sends only the remaining 25 MB. The client appends this to the partial file.

With chunked encoding, this is impossible at the HTTP level — there is no Content-Length to define byte ranges against. The application must implement its own resumption logic (e.g., SSE's `Last-Event-ID` header, or application-level sequence numbers).

With HTTP/2, range requests work the same way if the server supports them. The stream that was interrupted is gone (RST_STREAM with CANCEL or the connection dropped), but the client can open a new stream with a Range header on the same or a new connection.

### Q: Does chunked transfer encoding require `Transfer-Encoding: chunked` to be explicitly set?

**A:** In HTTP/1.1, yes — the response must include the `Transfer-Encoding: chunked` header for the receiver to correctly parse the chunk framing. Without it, the receiver has no way to know that the body contains hex size prefixes and CRLF delimiters. If the server sends chunked-formatted data without the header, the client reads the raw chunk metadata as part of the body, producing garbled output.

However, in practice, the server or its HTTP framework sets this header automatically. When a Go handler calls `w.Write()` without having set `Content-Length`, Go's `net/http` server automatically uses chunked encoding and sets the header. When a Python Flask handler uses `yield` in a generator response, Flask/Werkzeug sets `Transfer-Encoding: chunked` automatically. Application developers rarely set this header manually.

In HTTP/2, chunked encoding is explicitly prohibited (RFC 9113 Section 8.2.2). The `Transfer-Encoding` header must not appear. HTTP/2's binary framing layer provides its own mechanism — DATA frames with length fields and END_STREAM flags — making chunked encoding redundant and ambiguous. If a proxy downgrades HTTP/2 to HTTP/1.1, it must add `Transfer-Encoding: chunked` (or buffer and add `Content-Length`).

### Q: How does HPACK in HTTP/2 help compared to HTTP/1.1 headers, and what are the security implications?

**A:** In HTTP/1.1, every request sends headers as full ASCII text. A typical request with `Host`, `User-Agent`, `Accept`, `Accept-Encoding`, `Cookie`, `Authorization` can be 500-2000 bytes. On a page load with 100 requests to the same origin, that is 50-200 KB of redundant header data.

HPACK (RFC 7541) compresses headers using two mechanisms:

1. **Static table:** 61 predefined header name-value pairs (e.g., `:method: GET` is index 2 — encoded as a single byte `0x82`).
2. **Dynamic table:** Headers from previous requests are stored and referenced by index. After the first request sends `authorization: Bearer eyJhbG...` (potentially 200+ bytes), subsequent requests reference it by a 1-2 byte index.

The result: the first request might send 400 bytes of headers, but the second through hundredth requests to the same server might send 20-50 bytes each.

**Security implication — CRIME and BREACH attacks:** HPACK was designed specifically to resist compression oracle attacks. Unlike DEFLATE (used in the original SPDY and vulnerable to the CRIME attack), HPACK uses Huffman coding on individual header values (not across the entire header block) and a static or entry-by-entry dynamic table (not a sliding window). This prevents an attacker from injecting headers and observing compressed size to deduce secret header values (like cookies).

The `sensitive` flag in HPACK instructs the encoder to never index a header in the dynamic table. Browsers use this for `authorization` and `cookie` headers to prevent them from being recoverable from the dynamic table state. An attacker who can inject requests on the same HTTP/2 connection could otherwise reference indexed secrets.
