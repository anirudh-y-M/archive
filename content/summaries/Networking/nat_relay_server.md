---
title: "Summary: TURN / Relay Server and NAT Traversal"
---

> **Full notes:** [[notes/Networking/nat_relay_server|TURN Server -->]]

## Key Concepts

**Relay Server (TURN)** -- A publicly accessible intermediary that bridges two peers behind NATs. Both peers connect outward to the relay, and it shuttles data between them. Solves the problem of strict NATs blocking unsolicited inbound traffic.

**Outward Connection** -- NATs allow outgoing connections and create temporary "holes" for responses. Both peers connect outward to the relay's public IP, so neither peer needs to accept unsolicited inbound traffic.

**Symmetric NAT** -- Assigns a different public port for every new destination. STUN-discovered ports become useless when talking to a different peer. Relay servers fix this because the destination (the relay) never changes.

**Relay vs Forward Proxy** -- A relay is a neutral meeting room bridging two peers at the transport layer (TCP/UDP). A forward proxy is a client-side gatekeeper that operates at the application layer (HTTP).

**Connection Reuse** -- Once the relay path or hole-punch is established, the same connection (5-tuple) carries all data (video, audio, chat) continuously. No new connection per packet.

## Quick Reference

```
Peer A (behind NAT)                    Peer B (behind NAT)
      |                                       |
      |--- outward connect --->  TURN  <--- outward connect ---|
      |                         Server                         |
      |<========= data shuttled back and forth =========>|
```

| Technique | Works with Symmetric NAT? | Needs Public Server? |
|-----------|--------------------------|---------------------|
| STUN (direct P2P) | No  | Yes (discovery only) |
| TURN (relay)       | Yes | Yes (relays all data) |

## Key Takeaways

- TURN is the fallback when direct P2P (STUN/hole-punching) fails, especially behind symmetric NATs.
- Both peers act as clients connecting outward -- the relay maintains a mapping table and pushes data between them.
- The relay sees raw data packets but operates at the transport layer, unlike a forward proxy which understands HTTP.
- One established connection carries all media streams -- no new connections needed per data type.
