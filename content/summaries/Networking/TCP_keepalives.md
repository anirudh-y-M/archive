---
title: "Summary: TCP Keepalives & Next-Hop Devices"
---

> **Full notes:** [[notes/Networking/TCP_keepalives|TCP Keepalives & Next-Hop Devices -->]]

## Key Concepts

### Problem

Long-lived TCP connections (SSH, database tunnels, websockets) sometimes **silently break** even though both endpoints believe the connection is alive. This happens when intermediate network devices (NAT gateways, stateful firewalls, L4 load balancers) drop their connection tracking entries due to idle timeouts.

### Key Terms

**TCP Keepalive** -- a periodic probe packet sent over an idle TCP connection to detect peer liveness and refresh middlebox state. Contains no data (or one dummy byte) and elicits an ACK.

**Next hop** -- the immediate intermediate device (router, NAT, firewall, LB) a packet traverses. A routing/IP concept (L3), not part of TCP itself. Routers forward packets without interpreting TCP semantics.

**Connection tracking / state table** -- NATs, stateful firewalls, and L4 LBs maintain a table of active connections keyed by a 5-tuple: `(src IP, src port, dst IP, dst port, protocol)`. This lets them forward return traffic and apply policies.

### Why This Becomes a Problem (Idle Connection Timeouts)

Middlebox state entries have idle timeouts. If no packets traverse the connection within that timeout, the device removes the entry. Subsequent packets (e.g., server responses) are silently dropped. The connection dies without a TCP error -- it is a side effect of middlebox state expiration, not a TCP protocol failure.

### What TCP Keepalive Does

TCP keepalive is **end-to-end** between two endpoints. When idle for a configured period, TCP sends a tiny probe packet that elicits an ACK from the peer. It is not broadcast/multicast -- it travels the normal packet path between the two endpoints.

### How Keepalive Helps with Next-Hop Devices

Every time a keepalive traverses intermediate devices, it resets the idle timeout for **each device's** connection tracking entry. The firewall sees a packet and keeps state alive, NAT refreshes the binding, and the LB keeps the session. The side effect of refreshing middlebox state is often more important than the liveness check itself.

### Limitation: Default Keepalive is Too Slow

Linux default: keepalive fires after **2 hours** of idle time. Most NAT/firewall idle timeouts are **seconds to minutes** (30s-5min typical). By the time keepalive fires, middlebox state is already gone. TCP keepalive only prevents state expiration if tuned to fire **shorter than the smallest idle timeout** of any intermediate device.

### Where "Next Hop" Confusion Comes From

People say "next hop" because the intermediate stateful devices along the route maintain state that depends on seeing traffic. But the TCP connection logically exists only between the two endpoints. The next hops don't engage in the TCP handshake or protocol -- they just track it via 5-tuple entries. Stateless routers do NOT maintain connection state; only stateful firewalls, NATs, and LBs do.

### Edge Cases

**Connection-terminating middleboxes:** If a firewall or LB *terminates* the TCP connection and creates a second downstream connection, keepalives on the client side only affect the first hop. The downstream connection to the server is not refreshed by the same keepalive packets.

**Multiple NAT hops:** Each NAT (e.g., double NAT from ISP + router + CGNAT) has its own timeout. Keepalives must be frequent enough to refresh ALL of them.

### Best Practices

- **Tune keepalive** to fire shorter than the smallest intermediate device timeout (e.g., 30-60 seconds).
- **Application-layer heartbeats** (HTTP/2 PING, WebSocket ping) are often more reliable than OS-level TCP keepalive because they can be shorter and more granular.
- **Know your network topology** -- identify which devices maintain state (firewalls, NATs, LBs) and their idle timeouts.

### Why This Matters

Without proper keepalives: idle connections die silently, endpoints block indefinitely, apps hang. With proper keepalives: middlebox state stays refreshed, stale connections are detected earlier, resources are freed.

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
| Fix | Tune keepalive < smallest middlebox timeout |
| Alternative | App-layer heartbeats (HTTP/2 PING, WS ping) |
| Connection-terminating LB | Keepalive refreshes only the first hop |
| Multiple NATs | Must refresh ALL hops |

## Key Takeaways

- TCP keepalive is end-to-end between two endpoints, but its critical side effect is refreshing middlebox state tables along the path.
- Silent connection death is caused by middleboxes forgetting the connection (idle timeout expiry), not by TCP protocol failure.
- Default Linux keepalive (2 hours) is far too slow for most NAT/firewall timeouts -- always tune it shorter.
- Application-layer heartbeats (HTTP/2 PING, WebSocket ping) are often more reliable and flexible than OS-level TCP keepalive.
- If a middlebox terminates the connection (creates two independent TCP connections), keepalives only refresh one side.
- Know your network topology -- each stateful device (NAT, firewall, LB) has its own idle timeout, and keepalives must be frequent enough for all of them.
