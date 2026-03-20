---
title: "Summary: TCP Socket Internals"
---

> **Full notes:** [[notes/Networking/tcp-socket-internals|TCP Socket Internals: Listening vs Connected Sockets, Socket Buffers, and the Kernel Network Stack -->]]

## Key Concepts

**Socket as Kernel Abstraction** -- A socket is a file descriptor (integer) that the application uses to read/write bytes. The kernel handles everything below: TCP segments, IP headers, routing, netfilter, NIC interaction. The app sees only a byte stream.

**Listening vs Connected Socket** -- A listening socket (LISTEN state) never carries data -- it only handles incoming SYNs via two queues. `accept()` pops a completed connection from the accept queue and returns a new connected socket fd (ESTABLISHED state) with its own buffers.

**3-Way Handshake is Kernel-Managed** -- The application does not participate. The kernel handles SYN -> SYN-ACK -> ACK entirely. The connection is ESTABLISHED before the app calls `accept()`.

**SYN Queue + Accept Queue** -- SYN queue holds half-open connections (SYN received, SYN-ACK sent). Accept queue holds fully established connections waiting for `accept()`. Overflow behavior: SYN cookies bypass the SYN queue; accept queue overflow silently drops ACKs (or sends RST if `tcp_abort_on_overflow=1`).

**Socket Buffers** -- Each connected socket has a send buffer and receive buffer in kernel space. The receive buffer's free space = the TCP receive window advertised to the sender. Full buffer -> window=0 -> sender pauses (flow control).

**Netfilter vs Sockets** -- Completely independent kernel subsystems. Netfilter rewrites packets (DNAT/SNAT) after they leave the socket layer and before they reach it on return. The socket never sees rewritten addresses. This is why kube-proxy DNAT is transparent to applications.

**4-Tuple Demultiplexing** -- All connected sockets on a server share the same local port. The kernel distinguishes them by `(local IP, local port, remote IP, remote port)`. One port can handle millions of connections.

## Quick Reference

```
Packet send path:
  App write() -> Socket Layer -> TCP (segment, seq#, checksum)
    -> IP (header, route lookup) -> Netfilter (OUTPUT, POSTROUTING)
    -> NIC driver (Ethernet frame, DMA) -> Wire

Packet receive path:
  Wire -> NIC (DMA, interrupt) -> L2 (strip Ethernet)
    -> Netfilter (PREROUTING) -> IP (routing) -> Netfilter (INPUT)
    -> TCP (demux by 4-tuple, buffer) -> Socket -> App read()
```

| Queue          | State     | Overflow Behavior                     |
|----------------|-----------|---------------------------------------|
| SYN queue      | SYN_RECV  | SYN cookies (if enabled) or drop SYN  |
| Accept queue   | ESTABLISHED| Drop ACK (default) or send RST       |

| Socket Option    | Purpose                                      |
|------------------|----------------------------------------------|
| `SO_REUSEADDR`   | Bind to port with TIME_WAIT connections       |
| `SO_REUSEPORT`   | Multiple listeners on same port (kernel LB)   |
| `TCP_NODELAY`    | Disable Nagle's algorithm (low latency)       |
| `SO_RCVBUF`      | Set receive buffer size                       |

**Flow control:** recv buffer free space = TCP Window. Full buffer -> Window=0 -> sender stops.
**Congestion control:** separate mechanism (cwnd). Effective rate = min(rwnd, cwnd).

## Key Takeaways

- `write()` returning does NOT mean data is on the wire -- it means the kernel accepted it into the send buffer. The kernel sends at its own pace.
- The TCP handshake completes entirely in the kernel. A slow `accept()` loop causes the accept queue to overflow, silently dropping connections.
- Sockets and netfilter are independent. kube-proxy DNAT rewrites packets transparently -- the app thinks it's talking to the ClusterIP, never sees the real pod IP.
- One server port handles millions of connections via 4-tuple demultiplexing. "Each connection needs its own port" is a common misconception.
- For high-bandwidth, high-latency links, tune buffer sizes based on bandwidth-delay product (BDP = bandwidth x RTT).
