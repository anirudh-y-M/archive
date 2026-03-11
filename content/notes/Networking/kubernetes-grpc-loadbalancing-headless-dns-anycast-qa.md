---
title: Kubernetes + gRPC Load Balancing, Headless Services, DNS Records, and Anycast (Q&A)
---

## Q1) What is a headless Service and what is its use?

### A1) Definition (what it is)

In Kubernetes, a **headless Service** is a `Service` created with:

- `spec.clusterIP: None`

This means Kubernetes **does not allocate a virtual ClusterIP** (no VIP), and Kubernetes **does not provide built-in Service-level load balancing** behind a single stable IP address.

Instead, the Service primarily acts as a **service discovery mechanism via DNS**.

---

### A1) What we get with a headless Service

#### 1) DNS returns Pod IPs (not a single Service IP)

- For a **normal** `Service` (ClusterIP), the Service DNS name resolves to **one ClusterIP**.
  - Example:
    - `my-svc.default.svc.cluster.local` → `10.x.y.z` (single VIP)
- For a **headless** `Service`, the Service DNS name resolves to **multiple A/AAAA records**:
  - One IP per **ready endpoint** (typically Pod IPs)
  - Example:
    - `my-headless.default.svc.cluster.local` → `10.2.0.11`, `10.2.0.12`, `10.2.0.13`, ...

Clients can then choose which backend to talk to, because they can see the **actual list of endpoints**.

---

#### 2) Stable network identities (especially with StatefulSets)

Headless Services are commonly paired with **StatefulSets** to provide stable DNS names per Pod.

Typical stable names look like:

- `pod-0.my-headless.default.svc.cluster.local`
- `pod-1.my-headless.default.svc.cluster.local`

This is critical when cluster members must discover and talk to **specific peers**, not “any replica”.

---

### A1) Common uses

We typically use headless Services for:

- **Stateful apps / clustered systems**:
  - Databases
  - Kafka/ZooKeeper-style clusters
  - Elasticsearch-like membership systems
  - Anything that needs peer discovery
- **Client-side load balancing**:
  - Clients retrieve the list of endpoints from DNS and choose a backend themselves
- **Service discovery without proxying**:
  - We want direct Pod-to-Pod addressing
  - We do not want kube-proxy to hide endpoints behind one VIP

---

### A1) When we usually do NOT use a headless Service

If we just want:

- A stable VIP
- Simple access
- Built-in Service load balancing

…then a normal ClusterIP Service is usually simpler and more appropriate.

---

### A1) Example headless Service YAML

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-headless
spec:
  clusterIP: None
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 8080
```

---

## Q2) We read that gRPC connections do not work well with Service resource load balancing, so we need client-side load balancing. Is it true? If so, why and how do we do client-side load balancing?

### A2) Yes—often true in Kubernetes, and the reason is how gRPC uses connections.

---

### A2) Why Kubernetes Service load balancing can look “bad” for gRPC

#### Kubernetes Service load balancing is connection-oriented (L4)

A Kubernetes `Service` (ClusterIP) load balances at approximately:

- **TCP connection creation time**

Once a TCP connection is established and mapped to a backend Pod (endpoint), it is typically “sticky” for that connection.

---

#### gRPC uses HTTP/2 and long-lived connections

gRPC runs on **HTTP/2** and commonly uses:

- A small number of **long-lived** TCP connections (channels)
- Many RPCs **multiplexed** over those same connections

So, even if we make thousands of RPC calls, if we run them all over 1–2 long-lived connections, they can all get routed to the **same single Pod** (or just a few Pods).

**Result:** load balancing becomes “how many connections we opened”, not “how many RPCs we made”.

This is why we can see hotspotting:

- One Pod gets most traffic because one connection landed there
- Other Pods sit idle

---

### A2) What “client-side load balancing” means in gRPC terms

The gRPC client generally does:

1. **Resolve** a target into a **list of backend addresses**
2. Apply a **client-side LB policy** (like `round_robin`) to decide which backend gets traffic

This requires that the resolver returns **multiple addresses**.

---

### A2) Practical Kubernetes approach: headless Service + `round_robin`

#### Step 1: Use a headless Service so DNS returns multiple endpoint IPs

With a headless Service, DNS returns multiple A/AAAA records (Pod IPs).

#### Step 2: Configure the gRPC client to use DNS resolution and round-robin

In many gRPC implementations, the default behavior is “pick one backend and stick with it” unless we explicitly enable an LB policy.

---

### A2) Example: gRPC Go (client-side round robin via DNS)

```go
grpc.Dial(
  "dns:///my-headless.default.svc.cluster.local:50051",
  grpc.WithTransportCredentials(creds),
  grpc.WithDefaultServiceConfig(`{"loadBalancingConfig":[{"round_robin":{}}]}`),
)
```

Key points:

- `dns:///...` tells gRPC-Go to use its DNS resolver pipeline explicitly
- `round_robin` tells gRPC-Go to spread requests across resolved backends (sub-connections)

---

### A2) Example: gRPC Java (round robin)

```java
ManagedChannel channel = ManagedChannelBuilder
  .forTarget("dns:///my-headless.default.svc.cluster.local:50051")
  .defaultLoadBalancingPolicy("round_robin")
  .useTransportSecurity() // or plaintext in dev
  .build();
```

---

### A2) Important limitation even with client-side LB

- **Streaming RPCs** will generally stay on the chosen sub-connection for the duration of the stream.
- DNS refresh and caching behavior can affect how quickly clients learn about new Pods or removed Pods.
- If we only have a small number of clients and connections, distribution can still be imperfect.

---

### A2) Alternatives (mentioned for completeness)

We also noted that Envoy/service meshes and xDS exist, and can do more advanced L7-aware balancing, retries, outlier detection, etc.
But we also discussed “vanilla” approaches below.

---

## Q3) Is it not possible using vanilla gRPC and Golang (without Envoy or xDS or headless service)?

### A3) It is possible, but only in limited ways, because without headless Service (or something similar), gRPC sees only one address.

---

### A3) Why “normal Service + vanilla gRPC” cannot really do true client-side LB

With a normal `Service` (ClusterIP):

- DNS usually resolves the Service name to **one ClusterIP (VIP)**

If gRPC resolves to only **one** address, then client-side LB policies like round robin have nothing to balance across.

Also, Kubernetes load balancing is connection-level, and gRPC channels are long-lived, so a single channel can pin us to one Pod.

---

### A3) Option A (vanilla): Connection sharding (no headless, no xDS, no Envoy)

We can open **N separate gRPC connections** to the _same_ Service VIP and pick one connection per RPC.

Because each connection is a separate TCP flow, Kubernetes may distribute those connections across different backends. This is not guaranteed, but often improves balance.

#### Connection sharding code (Go)

```go
type Pool struct {
	conns []*grpc.ClientConn
	next  uint32
}

func NewPool(target string, n int, opts ...grpc.DialOption) (*Pool, error) {
	p := &Pool{conns: make([]*grpc.ClientConn, 0, n)}
	for i := 0; i < n; i++ {
		cc, err := grpc.Dial(target, opts...)
		if err != nil {
			for _, c := range p.conns { _ = c.Close() }
			return nil, err
		}
		p.conns = append(p.conns, cc)
	}
	return p, nil
}

func (p *Pool) pick() *grpc.ClientConn {
	i := atomic.AddUint32(&p.next, 1)
	return p.conns[int(i)%len(p.conns)]
}

func (p *Pool) Invoke(ctx context.Context, method string, args, reply any, opts ...grpc.CallOption) error {
	return p.pick().Invoke(ctx, method, args, reply, opts...)
}

func (p *Pool) NewStream(ctx context.Context, desc *grpc.StreamDesc, method string, opts ...grpc.CallOption) (grpc.ClientStream, error) {
	return p.pick().NewStream(ctx, desc, method, opts...)
}
```

#### Usage

```go
pool, _ := NewPool(
  "my-svc.default.svc.cluster.local:50051",
  8,
  grpc.WithTransportCredentials(creds),
)
client := pb.NewMyServiceClient(pool) // pool implements grpc.ClientConnInterface
```

**Tradeoffs**

- ✅ No special Kubernetes DNS setup
- ✅ No K8s API access
- ✅ Often good enough for unary calls
- ❌ Still connection-level balancing, not per-endpoint aware
- ❌ Streaming calls still “stick” to the chosen connection

---

### A3) Option B (still “vanilla gRPC”): Custom resolver (no headless, no xDS, no Envoy)

We can implement (or use a library implementing) a **custom gRPC name resolver** that:

- watches Kubernetes Endpoints / EndpointSlices
- returns the list of Pod IPs to gRPC

Then round robin works, because gRPC now has multiple addresses.

We noted an example library approach:

- `sercand/kuberesolver` (watches K8s endpoints and feeds addresses into gRPC resolver)

This is still “vanilla gRPC” in the sense that:

- we stay in the gRPC client
- we do not introduce Envoy
- we do not require xDS

**Tradeoffs**

- ✅ True endpoint-aware client-side LB
- ✅ Can react to endpoint changes
- ❌ Needs K8s API access + RBAC (or an external endpoint source)

---

### A3) Summary of what we cannot get without headless or a resolver

If we only dial a normal Service like:

- `my-svc:50051`

…then gRPC sees one VIP, and we cannot do real client-side load balancing across Pods by default.

---

## Q4) We thought headless Service doesn’t have an IP, so why this `dns:///my-headless.default.svc.cluster.local:50051`? Is it just an example or does it actually mean something?

### A4) It actually means something. It’s central to DNS-based client-side load balancing in gRPC.

---

### A4) Headless Service has no VIP, but still has DNS

Headless Service:

- has **no Service IP (no VIP)**
- but **does have a DNS name**

The DNS name resolves to:

- the set of endpoint IPs (Pod IPs) via multiple A/AAAA records

So `my-headless.default.svc.cluster.local` is a real name and it resolves to multiple backend IPs.

---

### A4) What `dns:///...` means in gRPC-Go

`dns:///my-headless.default.svc.cluster.local:50051` is a **gRPC target URI**:

- `dns` = use gRPC’s DNS resolver
- `///` = “no authority; treat the rest as an absolute name”
- the resolver produces a list of addresses, which enables gRPC load balancing policies

The point is not “headless has an IP” (it doesn’t).
The point is:

- headless DNS returns multiple Pod IPs
- `dns:///` makes gRPC consume those records as a backend set

---

### A4) Why `grpc.Dial("my-headless:50051")` can behave differently

We noted that:

- Go’s standard name resolution at the socket layer may pick one address and stick to it for a long-lived connection.
- Using the explicit gRPC target scheme `dns:///` is a common way to ensure gRPC’s resolver/LB pipeline is actually engaged.

---

### A4) Mental model

- Headless Service provides “many backends under one name”
- gRPC `dns:///` provides “use DNS as service discovery”
- `round_robin` provides “spread traffic across resolved backends”

---

## Q5) What is CNAME and A/AAAA records, and how is it different from Anycast?

### A5) A/AAAA records map names to IPs; CNAME maps names to names; Anycast is routing, not DNS.

---

### A5) A and AAAA records (name → IP)

These map a hostname directly to an IP address:

- **A** record → IPv4
- **AAAA** record → IPv6

Example:

- `api.example.com A 203.0.113.10`
- `api.example.com AAAA 2001:db8::10`

A hostname can have multiple A/AAAA records:

- `api.example.com A 203.0.113.10`
- `api.example.com A 203.0.113.11`
- `api.example.com A 203.0.113.12`

This is often used for:

- simple distribution
- redundancy
- multi-region endpoints
  …but behavior depends on client/resolver selection and caching.

---

### A5) CNAME record (name → name)

A **CNAME** makes one name an alias of another name.

Example:

- `www.example.com CNAME web-frontend.example.net`

Resolution flow:

1. Client asks for `www.example.com`
2. DNS answers: “use `web-frontend.example.net`”
3. Client then resolves `web-frontend.example.net` to A/AAAA records

Key differences vs A/AAAA:

- CNAME points to a **hostname**, not an IP
- Requires an additional lookup step (follow the alias)
- In standard DNS practice, a hostname that is a CNAME should not have other record types at the same name (providers sometimes offer non-standard “ALIAS/ANAME” features to work around this)

---

### A5) Anycast (not DNS; it’s routing)

**Anycast is not a DNS record type.**

Anycast is a **network routing technique**:

- the same IP address is advertised from multiple locations (PoPs) via BGP
- the network routes a client to the “nearest” location in routing terms

So:

- DNS tells us “what IP do we connect to?”
- Anycast tells the network “where does that IP live physically?” (many places)

---

### A5) Concrete comparison: multi-A vs Anycast

#### Multiple A records

DNS returns a list of different IPs:

- client picks one (often first, or based on resolver logic)
- caching/TTLs heavily affect how quickly changes propagate

#### Anycast

DNS can return one IP:

- but that same IP is served from many places
- BGP routing decides which place the client reaches

---

### A5) Why we care

- Anycast is great for global edge services:

  - DNS resolvers
  - CDNs
  - DDoS absorption

- DNS-based multi-IP setups are flexible but depend on:

  - caching
  - TTLs
  - client/resolver selection behavior

---

## Appendix: All code examples we discussed (for quick copy/paste)

### Headless Service YAML

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-headless
spec:
  clusterIP: None
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 8080
```

### gRPC Go: DNS + round_robin

```go
grpc.Dial(
  "dns:///my-headless.default.svc.cluster.local:50051",
  grpc.WithTransportCredentials(creds),
  grpc.WithDefaultServiceConfig(`{"loadBalancingConfig":[{"round_robin":{}}]}`),
)
```

### gRPC Java: DNS + round_robin

```java
ManagedChannel channel = ManagedChannelBuilder
  .forTarget("dns:///my-headless.default.svc.cluster.local:50051")
  .defaultLoadBalancingPolicy("round_robin")
  .useTransportSecurity()
  .build();
```

### Go connection sharding pool (no headless, no Envoy, no xDS)

```go
type Pool struct {
	conns []*grpc.ClientConn
	next  uint32
}

func NewPool(target string, n int, opts ...grpc.DialOption) (*Pool, error) {
	p := &Pool{conns: make([]*grpc.ClientConn, 0, n)}
	for i := 0; i < n; i++ {
		cc, err := grpc.Dial(target, opts...)
		if err != nil {
			for _, c := range p.conns { _ = c.Close() }
			return nil, err
		}
		p.conns = append(p.conns, cc)
	}
	return p, nil
}

func (p *Pool) pick() *grpc.ClientConn {
	i := atomic.AddUint32(&p.next, 1)
	return p.conns[int(i)%len(p.conns)]
}

func (p *Pool) Invoke(ctx context.Context, method string, args, reply any, opts ...grpc.CallOption) error {
	return p.pick().Invoke(ctx, method, args, reply, opts...)
}

func (p *Pool) NewStream(ctx context.Context, desc *grpc.StreamDesc, method string, opts ...grpc.CallOption) (grpc.ClientStream, error) {
	return p.pick().NewStream(ctx, desc, method, opts...)
}
```

---

## Notes

- This document preserves and expands all points we covered.
- We did not add external citations here, because we did not browse the web in this conversation to fetch authoritative sources.

```
::contentReference[oaicite:0]{index=0}
```

# kube-proxy Sync, Service VIP Routing, and Endpoint Selection (Q&A)

## Q1) How does kube-proxy sync the node IP policies? When a client calls a Service DNS, DNS returns the Cluster VIP. kube-proxy configures nodes to send traffic to one of the backend endpoints. How is it decided which node and which endpoint (Pod)?

### A1) Mental model: kube-proxy programs _every node_ so Service VIPs “work anywhere”

When we talk about “kube-proxy syncing node IP policies,” we’re talking about a **continuous reconciliation loop**:

- **kube-proxy runs on every node** (typically as a **DaemonSet**), so each node has its own local instance.
- Each kube-proxy instance **watches the Kubernetes API server** for changes to:
  - **Services** (e.g., ClusterIP VIP, ports, session affinity settings)
  - **EndpointSlices / Endpoints** (the set of backend Pod IPs + ports that are currently ready)
- Based on what it observes, kube-proxy **programs node-local dataplane rules** using one of the supported backends:
  - **iptables mode**
  - **nftables mode**
  - **IPVS mode**
- There is also typically a periodic reconciliation interval (often referred to as a **sync period**) that:
  - helps kube-proxy re-assert correctness even if something else modified rules
  - performs cleanup of stale rules

**Key consequence:** every node learns the mapping:

- **Service VIP:port → {endpoint PodIP:port list}**
  and installs rules locally.

> Note: this assumes the “classic” kube-proxy model (iptables/nftables/IPVS). Some clusters replace this behavior with **eBPF dataplanes** (e.g., “kube-proxy replacement / kube-proxy-free”), which change _how_ rules are installed and executed, but the conceptual steps (learn Services + endpoints, program dataplane) remain similar.

---

# Kube-Proxy

### A2) When we call a Service DNS name, “which node” handles it?

This depends on _where the packet enters the node networking stack_, but for the most common case (Pod calling a ClusterIP Service inside the cluster), it is usually the **client’s own node**.

#### Case 1: Pod → ClusterIP Service (in-cluster)

1. The client resolves:
   - `my-svc.default.svc.cluster.local` → **ClusterIP VIP** (for a normal Service)
2. The client Pod sends traffic to that VIP.
3. The packet leaves the Pod via its veth and enters the **host (node) network stack**.
4. Since kube-proxy has installed rules **on that node**, that node applies the VIP handling.

**Answer to “which node?”**

- It’s typically the **node where the client Pod is running** (the source node), because that’s where the packet first hits the host networking and the kube-proxy-managed rules.

**Important nuance about the VIP**

- The ClusterIP VIP is commonly **not assigned to a real interface**.
- It “exists” via NAT / dataplane rules, so packets to the VIP get intercepted and rewritten.

---

#### Case 2: External → Service (NodePort / LoadBalancer / Ingress)

In this case, “which node?” depends on **how the packet enters the cluster**:

- **NodePort:** the client hits a specific node’s IP:NodePort (or a load balancer in front chooses a node).
- **LoadBalancer:** the cloud/provider LB chooses a node (based on its own algorithm and health checks).
- **Ingress:** traffic may land on specific nodes running the ingress controller.

Once the packet arrives on **some** node:

- the kube-proxy instance on that node applies the Service handling rules (unless specific traffic policies restrict which endpoints can be selected—see below).

---

### A3) How is the backend endpoint (Pod) chosen?

This depends on kube-proxy mode, but the important shared behavior we discussed is:

- The selection is typically made **at connection establishment time** (for a TCP flow).
- After selection, the connection tends to remain mapped (“sticky”) to that endpoint for the life of the connection due to connection tracking / NAT behavior.

Below are the modes and what we said about how they select endpoints:

---

#### Mode 1: iptables mode (common)

In iptables mode, kube-proxy installs:

- rules for each Service VIP:port
- “jumps” into Service-specific chains
- and then uses per-endpoint chains as possible targets

**How selection happens (conceptually):**

- kube-proxy arranges iptables rules so new connections get distributed across endpoints.
- The selection is often implemented using iptables matching that approximates **random distribution**.
  - A typical pattern used is `-m statistic --mode random --probability ...` so each rule has some chance to match, steering traffic across endpoints.

**Key takeaway:**

- Endpoint selection is effectively **randomized** (unless session affinity is enabled), and is **per connection**, not per individual RPC.

---

#### Mode 2: nftables mode (modern)

In nftables mode, the kube-proxy dataplane rules typically:

- select a backend endpoint **at random by default**

The practical outcome remains similar:

- backend choice is usually **per connection**
- and persists for the life of that connection

---

#### Mode 3: IPVS mode

With IPVS, kube-proxy programs:

- IPVS virtual services and real servers (endpoints)
- and IPVS then uses a configured **scheduling algorithm** to choose endpoints

Common scheduling algorithms can include:

- round-robin-like behavior
- least-connections
- etc.

We also mentioned that in newer Kubernetes directions, IPVS is considered legacy compared to nftables in many setups; the important point is that it is a distinct mode with explicit scheduling behavior.

---

### A4) Once an endpoint is chosen, how does traffic reach the right node?

After kube-proxy chooses a backend:

- it rewrites the destination from:
  - **Service VIP:port**
    to:
  - **PodIP:port** (one of the endpoints)

At that point, the packet is simply destined to a **Pod IP**.
How does it reach the Pod?

- The **CNI networking** provides routes / overlay / encapsulation such that PodIP traffic can be delivered to the node hosting that Pod.

So the path becomes:

- client Pod → client node (VIP handling + DNAT) → network (CNI routing) → destination node → destination Pod

---

### A5) How is it decided “which endpoint” vs “which node”?

It helps to separate the decisions:

#### “Which node handles the VIP?”

- Usually the **node where the packet first enters** the host networking stack.
  - For Pod → ClusterIP, that is the **client’s node**.
  - For external traffic, that is the **node that received the packet** (chosen by the external LB / NodePort targeting / ingress routing).

#### “Which endpoint is chosen?”

- That’s done by the **local node’s dataplane rules** (iptables/nftables/IPVS) using:
  - random distribution patterns (iptables/nftables) or
  - a scheduler (IPVS),
    usually **at connection time**.

#### Policies that can constrain endpoint choice (high-level)

While not deeply expanded earlier, it’s worth keeping the same implication we referenced:

- Some Service configurations can restrict endpoint selection behavior in certain traffic-entry scenarios (e.g., “local only” behaviors), which changes which endpoints are eligible on the node that received traffic.

---

### A6) Why this matters for gRPC (the implication we called out)

gRPC typically uses:

- long-lived HTTP/2 connections (channels)
- many RPCs multiplexed over those connections

Because kube-proxy selection is effectively:

- **per TCP connection**, not per RPC

A single long-lived gRPC connection can end up sending many RPCs to:

- one chosen endpoint (Pod)

This is why gRPC can look “imbalanced” behind a normal ClusterIP Service if the client uses a small number of long-lived channels.

---

### A7) Summary in one line

- kube-proxy **watches Services + EndpointSlices** and **programs rules on every node**
- **the node that first sees the packet** applies VIP handling
- **the local dataplane** chooses an endpoint **typically per connection**
- then CNI networking delivers traffic to the chosen Pod’s node/PodIP
