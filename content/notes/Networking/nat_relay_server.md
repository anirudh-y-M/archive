Q: What is the primary role of a relay server in resolving NAT blocks?
A: A relay server (often called a TURN server) acts as a publicly accessible intermediary bridge. When two devices (peers) are behind strict firewalls or NATs that block direct peer-to-peer (P2P) communication, both devices connect outwardly to the relay server. The server then shuttles data back and forth between them.

Q: What does it mean to connect "outwardly" to a public IP?
A: Most home routers (NATs) block "unsolicited" incoming traffic—meaning a stranger cannot send data to your computer if you didn't ask for it. However, routers almost always allow outgoing connections.
By connecting "outwardly" to a relay server's public IP, the router creates a temporary "hole" to let the server's response back in.
Since both peers do this simultaneously to the same server, a communication path is established that ignores the "walls" of the NAT.

Q: In a video call, does every stream of bytes require a "new connection"?
A: No.
The Session: To the user, the call is one single session.
The Network Connection: At the network level, a connection is defined by a "5-tuple" (Source IP/Port, Destination IP/Port, and Protocol).
Once the "hole" is punched or the relay path is established, that same "pipe" is used to send all the data (video, audio, and chat) continuously. You do not need to create a new connection for every packet of data.

Q: What is a "Symmetric NAT" and why does it break standard P2P?
A: A Symmetric NAT is a strict type of router that assigns a different public port every time a device connects to a new destination.
If Peer A uses a discovery server (STUN) to find its port, the router might give it Port 100.
But when Peer A tries to use that same info to talk to Peer B, the router sees a new destination and changes the port to 200.
Peer B is now sending data to the wrong port (100), and the connection fails. A Relay Server fixes this because the destination (the server) never changes.

Q: How does a Relay Server differ from a Forward Proxy?
A: While both are intermediaries, they have different goals:
Relay Server: A "neutral meeting room" used to bridge two peers who cannot see each other. It works at the transport layer (TCP/UDP) and handles raw data packets.
Forward Proxy: A "personal assistant" or gatekeeper for a client. It sits in front of a client to hide their identity or filter their web browsing (usually at the Application layer like HTTP).

Q: In a relay setup, do both peers act as clients?
A: Yes. Both peers act as clients that "check in" with the relay server. The server maintains a mapping table in its memory. When Peer A pushes data to the server, the server immediately forwards (pushes) it to Peer B through the already-open connection. It is a Push mechanism rather than a "Fetch" (where a client would have to keep asking for updates).
