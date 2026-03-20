---
title: "Summary: TCP Keepalives & Next-Hop Devices"
---

> **Full notes:** [[notes/Networking/TCP_keepalives|TCP Keepalives & Next-Hop Devices -->]]

## Key Concepts

- **TCP keepalive**: A periodic probe packet sent between two endpoints over an idle TCP connection. Contains no data (or one dummy byte) and elicits an ACK. Purpose: detect dead peers and refresh middlebox state.

- **Middlebox state tables**: NATs, stateful firewalls, and L4 load balancers track connections via a 5-tuple `(src IP, src port, dst IP, dst port, protocol)`. If no packets flow for a timeout period, the entry is removed and the connection silently dies.

- **The real problem**: Default Linux keepalive fires after 2 hours. Most NAT/firewall idle timeouts are seconds to minutes. By the time keepalive fires, the state is already gone.

- **"Next hop" in this context**: Not a TCP concept -- refers to intermediate stateful devices (NAT, firewall, LB) that expire connection tracking entries on idle.

## Quick Reference

```
Client --> NAT --> Firewall --> LB --> Server
  |          |         |        |
  | Keepalive probe traverses all devices,
  | resetting each one's idle timeout
```

| Concern | Detail |
|---|---|
| Default keepalive interval | 2 hours (Linux) |
| Typical NAT timeout | 30s-5min |
| Fix | Tune keepalive to < smallest middlebox timeout |
| Alternative | App-layer heartbeats (HTTP/2 PING, WS ping) |

**Edge case**: If a firewall/LB *terminates* the connection (creates a second downstream connection), keepalives on one side do NOT refresh the other side.

## Key Takeaways

- TCP keepalive is end-to-end between two endpoints, but its side effect of refreshing middlebox state is often more important than the liveness check.
- Always tune keepalive interval shorter than the smallest idle timeout of any device in the path.
- Silent connection death is caused by middleboxes forgetting the connection, not by TCP failure.
- Application-layer heartbeats (HTTP/2 PING, WebSocket ping) are often more reliable than OS-level TCP keepalive.
- Know your network topology -- multiple NAT hops each have their own timeout.
