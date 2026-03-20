---
title: "Summary: TURN / Relay Server and NAT Traversal"
---

> **Full notes:** [[notes/Networking/nat_relay_server|TURN Server -->]]

## Key Concepts

### Relay Server Role in NAT Traversal

A relay server (TURN server) acts as a publicly accessible intermediary bridge when two peers behind strict NATs cannot communicate directly. Both devices connect outward to the relay's public IP, and the server shuttles data between them. This solves the fundamental problem of NATs blocking unsolicited incoming traffic.

### Outward Connection and NAT Hole Punching

Most home routers block unsolicited inbound traffic but allow outgoing connections. When a device connects outward to the relay server, the NAT creates a temporary "hole" that allows the server's response back in. Since both peers do this simultaneously to the same server, a communication path is established that bypasses both NAT walls.

### Connection Reuse and the 5-Tuple

A video call is one session at the user level. At the network level, the connection is defined by a 5-tuple (source IP/port, destination IP/port, protocol). Once the relay path is established, the same pipe carries all data -- video, audio, chat -- continuously. There is no need to create a new connection for every packet or stream type.

### Symmetric NAT Problem

A Symmetric NAT assigns a different public port every time a device connects to a new destination. When a peer discovers its port via STUN (e.g., port 100), then tries to talk to a different peer, the NAT changes the port (e.g., to 200). The other peer sends to the wrong port and the connection fails. A relay server fixes this because the destination (the relay) never changes, so the NAT-assigned port stays consistent.

### Relay Server vs Forward Proxy

Both are intermediaries, but with different goals. A relay server is a "neutral meeting room" bridging two peers at the transport layer (TCP/UDP), handling raw data packets. A forward proxy is a "personal assistant" for a client, sitting in front of it to hide identity or filter browsing at the application layer (HTTP).

### Push Mechanism

Both peers act as clients that "check in" with the relay server. The server maintains a mapping table in memory. When Peer A pushes data to the server, it immediately forwards (pushes) it to Peer B through the already-open connection. This is a push mechanism, not polling -- peers don't have to keep asking for updates.

## Quick Reference

```
Peer A (behind NAT)                    Peer B (behind NAT)
      |                                       |
      |--- outward connect --->  TURN  <--- outward connect ---|
      |                         Server                         |
      |<========= data shuttled back and forth =========>      |
```

| Technique | Works with Symmetric NAT? | Needs Public Server? | Data Path |
|---|---|---|---|
| STUN (direct P2P) | No | Yes (discovery only) | Direct peer-to-peer |
| TURN (relay) | Yes | Yes (relays all data) | Through relay server |

| Concept | Relay Server | Forward Proxy |
|---|---|---|
| Layer | Transport (TCP/UDP) | Application (HTTP) |
| Purpose | Bridge two peers | Client-side gatekeeper |
| Direction | Bidirectional relay | Client -> server |

## Key Takeaways

- TURN is the fallback when direct P2P (STUN/hole-punching) fails, especially behind symmetric NATs where port mappings change per destination.
- Both peers act as clients connecting outward -- the relay maintains a mapping table and pushes data between them in real time.
- The relay sees raw data packets at the transport layer, unlike a forward proxy which understands HTTP.
- One established connection (5-tuple) carries all media streams continuously -- no new connections needed per data type.
- The relay server's public IP is the fixed rendezvous point that makes both NATs' outward connections work together.
