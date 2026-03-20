---
title: "Summary: TCP Socket Internals"
---

> **Full notes:** [[notes/Networking/tcp-socket-internals|TCP Socket Internals: Listening vs Connected Sockets, Socket Buffers, and the Kernel Network Stack -->]]

## Key Concepts

### Sockets as Kernel Abstractions

A socket is created by the `socket()` syscall and returns a file descriptor (fd) -- an integer the process uses to `read()` and `write()` bytes. The kernel associates this fd with a `struct socket` / `struct sock` containing all TCP/IP state: connection state machine, sequence numbers, timers, congestion window, buffer pointers, etc. The application sees only a byte stream and has no knowledge of TCP segments, IP headers, netfilter rules, or NIC interactions.

Every socket operation crosses the userspace-kernel boundary via a syscall (context switch from ring 3 to ring 0). Key syscalls: `socket()`, `bind()`, `listen()`, `accept()`, `connect()`, `read()`/`recv()`, `write()`/`send()`, `close()`, `setsockopt()`.

### Listening Socket vs Connected Socket

A **listening socket** (LISTEN state) is created by calling `listen(fd, backlog)`. It never carries application data -- it only handles incoming SYN packets. It maintains a SYN queue (half-open connections) and an accept queue (completed connections). It stays alive for the server's lifetime, producing thousands of connected sockets.

A **connected socket** (ESTABLISHED state) is created when `accept()` pulls a completed connection from the accept queue. The kernel allocates a new `struct sock` with its own send/receive buffers and a new fd. It is identified by its unique 4-tuple: `(local IP, local port, remote IP, remote port)` and is completely independent of the listening socket.

### The 3-Way Handshake: Entirely Kernel-Managed

The application does NOT participate in the TCP handshake. The kernel handles SYN -> SYN-ACK -> ACK entirely. The connection is fully ESTABLISHED before the app calls `accept()`. If the app is slow to call `accept()`, completed connections pile up in the accept queue. If it overflows, the kernel drops incoming connections (behavior depends on `tcp_abort_on_overflow` sysctl).

```
Client SYN -> Kernel creates SYN queue entry, sends SYN-ACK
Client ACK -> Kernel moves to accept queue (ESTABLISHED)
App accept() -> Kernel returns new connected fd
```

### Why One Port Handles Thousands of Connections

The listening socket occupies one port (e.g., 8080). Every connected socket shares the same local port but has a different remote IP:port. The kernel demultiplexes by full 4-tuple (O(1) hash table lookup), not just destination port. Theoretical max: ~2^48 unique 4-tuples. Practical limits: file descriptors (`ulimit -n`), memory (~3-10 KB per socket), conntrack table size.

### Socket Buffers (Send and Receive)

Every connected socket has two kernel-space buffers that decouple the app's read/write pace from network speed.

**Send buffer (sk_write_queue):** App writes here via `write()`. Kernel drains it by segmenting data per MSS, applying Nagle's algorithm (unless TCP_NODELAY), respecting cwnd/rwnd, keeping copies for retransmission until ACKed. If full: blocking mode blocks `write()`, non-blocking returns EAGAIN, epoll removes EPOLLOUT.

**Receive buffer (sk_receive_queue):** Kernel fills with in-order received data. App reads via `read()`. If full: kernel advertises TCP window=0, sender stops sending (flow control), sender sends periodic window probes. If empty: blocking `read()` blocks, non-blocking returns EAGAIN.

### Buffer Sizes and Tuning

Controlled by `tcp_rmem` (receive) and `tcp_wmem` (send) sysctls -- each has min, default, max. With `tcp_moderate_rcvbuf` enabled (default), the kernel auto-tunes between min and max. `SO_RCVBUF`/`SO_SNDBUF` override, but kernel caps at 2x requested.

### Receive Buffer = TCP Receive Window

The TCP receive window (in every ACK's `Window` field) equals the free space in the receive buffer. This is TCP flow control (RFC 9293, Section 3.8.6): full buffer -> window=0 -> sender stops. Sender enters persist mode, sending window probes until space opens. Flow control (rwnd) protects the receiver; congestion control (cwnd) protects the network. Effective send rate = `min(rwnd, cwnd)`.

**Bandwidth-delay product:** Default 128 KB buffer with 100ms RTT limits throughput to ~10 Mbps. For 10 Gbps links, you need 125 MB buffers. BDP = bandwidth x RTT.

### Kernel Network Stack: Packet Send Path

```
App write() -> Socket layer (validate, copy to send buffer, return)
  -> TCP (segment by MSS, Nagle, seq#, checksum, cwnd/rwnd check, retransmit queue)
  -> IP (header, route lookup, TTL)
  -> Netfilter (OUTPUT chain, POSTROUTING chain, DNAT/SNAT, conntrack)
  -> NIC driver (ARP, Ethernet frame, TX ring buffer, DMA to wire)
```

`write()` returns after copying to the send buffer -- data is NOT on the wire yet. The kernel sends at its own pace based on Nagle, cwnd, rwnd, and MSS.

### Kernel Network Stack: Packet Receive Path

```
Wire -> NIC (DMA, interrupt, softirq) -> L2 (validate frame, strip Ethernet)
  -> Netfilter PREROUTING (DNAT) -> IP (validate, routing decision)
  -> Netfilter INPUT -> TCP (demux by 4-tuple, checksum, state machine, buffer, ACK)
  -> Socket (wake blocked reader) -> App read()
```

### Netfilter vs Sockets: Independent Subsystems

Sockets and netfilter are completely independent kernel subsystems. The socket layer records `dst = 10.96.0.1:80` at connect time. Netfilter rewrites packets after they leave the socket layer (on send, OUTPUT chain) and before they reach it (on receive, PREROUTING chain). The socket never sees the rewritten addresses. Conntrack records the NAT mapping so return packets are reverse-NATted.

This is why kube-proxy iptables DNAT is transparent: the app connects to ClusterIP `10.96.0.1:80`, netfilter rewrites to Pod IP `10.48.2.7:8080` on the wire, conntrack reverses it on return, and the socket always sees `10.96.0.1:80`.

### SYN Queue and Accept Queue Internals

**SYN queue:** Holds half-open connections (SYN_RECV state). Size: `tcp_max_syn_backlog`. If full and `tcp_syncookies=1` (default), kernel encodes connection params in the SYN-ACK sequence number, bypassing the SYN queue. Trade-off: SYN cookies disable some TCP options (window scaling, SACK).

**Accept queue:** Holds completed connections (ESTABLISHED). Size: `min(listen backlog, net.core.somaxconn)`. If full with `tcp_abort_on_overflow=0` (default): silently drops the client's final ACK, causing a retry loop. With `=1`: sends RST (immediate failure).

```
Monitoring:
  ss -tn state syn-recv | wc -l           # SYN queue depth
  nstat -az TcpExtListenOverflows          # accept queue overflows
  ss -ltn                                  # Recv-Q = current, Send-Q = max
```

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

| Queue | State | Size Control | Overflow Behavior |
|---|---|---|---|
| SYN queue | SYN_RECV | `tcp_max_syn_backlog` | SYN cookies (if enabled) or drop |
| Accept queue | ESTABLISHED | `min(backlog, somaxconn)` | Drop ACK (default) or RST |

| Socket Option | Purpose |
|---|---|
| `SO_REUSEADDR` | Bind to port with TIME_WAIT connections (bypass 60s wait on restart) |
| `SO_REUSEPORT` | Multiple listeners on same port (kernel LB across threads/processes) |
| `TCP_NODELAY` | Disable Nagle's algorithm (low latency) |
| `SO_RCVBUF` / `SO_SNDBUF` | Set buffer sizes |

| | `SO_REUSEADDR` | `SO_REUSEPORT` |
|---|---|---|
| Purpose | Bypass TIME_WAIT bind conflicts | Multiple LISTEN sockets on same port |
| Multi-listener? | No | Yes |
| Load balancing | N/A | Kernel distributes by 4-tuple hash |
| Security | Any process can bind | Same effective UID only |

**Flow control:** recv buffer free space = TCP Window. Full buffer -> Window=0 -> sender stops.
**Congestion control:** separate mechanism (cwnd). Effective rate = min(rwnd, cwnd).
**BDP:** For high-latency, high-bandwidth links, buffer_size >= bandwidth x RTT.

## Key Takeaways

- `write()` returning does NOT mean data is on the wire -- it means the kernel accepted it into the send buffer. The kernel sends at its own pace based on Nagle, cwnd, rwnd, and MSS.
- The TCP handshake completes entirely in the kernel. A slow `accept()` loop causes the accept queue to overflow, silently dropping connections.
- Sockets and netfilter are independent subsystems. kube-proxy DNAT rewrites packets transparently -- the app thinks it's talking to ClusterIP, never sees the real pod IP.
- One server port handles millions of connections via 4-tuple demultiplexing. "Each connection needs its own port" is a common misconception (clients use ephemeral ports, ~28K per destination).
- For high-bandwidth, high-latency links, tune buffer sizes based on bandwidth-delay product (BDP = bandwidth x RTT). Default 128 KB limits throughput to ~10 Mbps at 100ms RTT.
- SYN cookies bypass the SYN queue during floods but disable some TCP options. Accept queue overflow silently drops connections by default.
- `SO_REUSEADDR` avoids TIME_WAIT bind failures on server restart. `SO_REUSEPORT` enables multi-listener load balancing across threads.
- Go's `net.Listen()` sets `SO_REUSEADDR` automatically. Go's `net.Dial()` wraps `socket()` + `connect()` (triggers 3-way handshake).
