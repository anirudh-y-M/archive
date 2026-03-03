---
title: "TCP Keepalives & Next-Hop Devices"
---

### What “next hop” means with TCP keepalives

*Explained in a structured, clear, step-by-step pattern with definitions, problems, causes, behavior, and recommendations*

---

## Problem

Long-lived TCP connections (e.g., SSH, database tunnels, websockets) sometimes **silently break** even if both endpoints think the connection is alive. This is especially common when connection paths include network devices like NAT gateways, stateful firewalls, or load balancers.

---

## Key Terms

### **TCP Keepalive**

A periodic TCP *probe packet* sent over an idle TCP connection to detect if the peer is still reachable and to keep the connection active in intermediate network devices that track connection state. ([Wikipedia][1])

### **Next hop**

The *immediate intermediate device* (router, NAT, firewall, load balancer) that a packet is forwarded to on its way toward the destination. This is a routing/networking concept (Layer 3/IP) and isn’t part of the TCP protocol itself. Routers don’t interpret TCP semantics — they just forward. ([Stack Overflow][2])

### **Connection tracking / state table**

Many network devices (NAT, stateful firewalls, L4 load balancers) maintain a table of active connections based on a 5-tuple:

```
(src IP, src port, dst IP, dst port, protocol)
```

This table entry lets the device know how to forward return traffic or apply firewall policies. ([Wikipedia][3])

---

## Why This Becomes a Problem

### Idle connection timeouts

Network state tracking entries have **idle timeout values** — if **no packets traverse the connection for some time**, the device removes the entry.

Example:

```
Client (10.0.0.5:54321)  →  NAT  →  Server (142.250.190.78:443)
```

If *no packets* are seen for 60 seconds:

* NAT removes the session mapping
* Later server → client packets will be *dropped*
* Connection silently dies on that path

This is NOT a TCP error — it’s a side effect of idle timeout in middlebox state tables. ([IT SPY][4])

---

## What TCP Keepalive Does

### End-to-End traffic

A TCP keepalive works between the **two endpoints** of a TCP connection. It is *not* a broadcast, multicast, or next-hop-to-multiple-devices mechanism — it is sent between the TCP endpoints. ([Wikipedia][1])

### Probe packet

When idle for a configured period, TCP sends a tiny probe packet that *elicits an ACK* from the opposite endpoint if still alive. This packet has **no data** (or just one dummy byte) and is interpreted as normal TCP traffic. ([Wikipedia][1])

---

## How Keepalive Helps with Next-Hop Devices

### Keeps network state alive

Every time a keepalive packet traverses the next hop devices:

```
Client → NAT → Firewall → Load Balancer → Server
```

Each of those maintains an entry for the TCP connection. A keepalive resets the idle timeout for **each connection row** in their tables because:

* The stateful firewall sees a packet and keeps the state alive
* NAT sees traffic on the 5-tuple and refreshes the NAT binding
* L4 load balancer sees activity and keeps the session alive

In other words:

> TCP keepalive doesn’t just help the endpoints; it lets intermediate devices *see activity* and thus keeps their state entries from expiring. ([IT SPY][4])

This is *especially important* because:

* NAT has limited resource (port mapping) allocations
* Firewalls close idle state for security/resource management
* Load balancers enforce idle connection timeouts

---

## Limitation: Default Keepalive is Too Slow

By default (e.g., Linux), TCP keepalive is sent after **2 hours of idle time**. ([tex2e.github.io][5])

However:

* Many NAT/firewalls idle timeout is **tens of seconds or minutes**
* Keepalive occurs *after* the device already dropped the state

So TCP keepalive *may not prevent* NAT state removal unless tuned.

---

## Where “Next Hop” Confusion Comes From

People talk about “next hop” in this context because:

* Network devices along the route are the next hops that inspect packets
* They maintain intermediate state which depends on traffic
* When no packet is seen, they expire state and break the connection

But:

> The TCP connection *logically* exists only between the two endpoints. The next hops **don’t engage in the TCP handshake or protocol**, they just *track* it. ([Wikipedia][3])

Routers don’t maintain connection state — only stateful firewalls, NATs, and load balancers do.

---

## Edge Cases & Network Architecture Effects

### With firewalls / proxies that break the path

If a firewall or load balancer *terminates* the connection and creates a second downstream connection, TCP keepalive on the client side **only affects the first hop**; the downstream connection to the server may not get refreshed by the same keepalive packets. ([Stack Overflow][2])

### NAT + multiple hops

Each NAT hop (e.g., double NAT from ISP + router + CGNAT) has its own timeout — keepalives must be frequent enough to refresh *all* of them. ([4judgement.github.io][6])

---

## Best Practices

### Tune keepalive

Reduce the keepalive idle time and interval so they are **shorter than the smallest idle timeout of any intermediate device** (e.g., send every 30–60 seconds). ([Wikipedia][1])

### Application-layer heartbeats

Sometimes application protocols implement their own heartbeat (e.g., HTTP/2 PING, WebSocket ping) because those can be shorter and more reliable than system TCP keepalive. ([Stack Overflow][2])

### Understand network topology

Know which devices maintain state (firewalls, NATs, load balancers) and configure both them and your TCP keepalive accordingly to avoid silent drops.

---

## Why This Matters

Without proper keepalives:

* Idle long-running connections often die silently
* Endpoints don’t know until they send data and get nothing
* Apps may block indefinitely
* User experience suffers

With proper keepalives:

* Intermediate states stay refreshed
* Stale connections are detected earlier
* Resources are freed efficiently

---

## Summary

TCP keepalive is:

* A periodic probe between two endpoints over an established TCP connection
* Sent to check liveliness and prompt ACKs
* Used to refresh intermediate network device state

“Next hop” in discussions refers to:

* Intermediate devices (NAT, firewalls, load balancers)
* That track connection state with idle timeouts
* Which remove entries if no packets (including no keepalives) are seen

If those devices drop state before a keepalive arrives, the TCP connection can silently die — not because TCP failed, but because *middleboxes forgot* about the connection. ([Wikipedia][1])

---

If you want, I can also create a **visual example diagram** showing how packets flow through NAT/firewall/load balancer and how idle timeout interacts with keepalive.

[1]: https://en.wikipedia.org/wiki/Keepalive?utm_source=chatgpt.com "Keepalive"
[2]: https://stackoverflow.com/questions/18467293/will-keep-alive-useful-to-use-with-load-balancer-and-firewalls?utm_source=chatgpt.com "tcp - Will keep-alive useful to use with load balancer and firewalls - Stack Overflow"
[3]: https://en.wikipedia.org/wiki/Stateful_firewall?utm_source=chatgpt.com "Stateful firewall"
[4]: https://www.itspy.cz/wp-content/uploads/2015/11/acmspy2015__3.pdf?utm_source=chatgpt.com "Slovak University of Technology Bratislava"
[5]: https://tex2e.github.io/rfc-translater/html/rfc5382.html?utm_source=chatgpt.com "RFC 5382 - NAT Behavioral Requirements for TCP 日本語訳"
[6]: https://4judgement.github.io/rfc-translater/html/rfc8445.html?utm_source=chatgpt.com "RFC 8445 - Interactive Connectivity Establishment (ICE): A Protocol for Network Address Translator (NAT) Traversal 日本語訳"
