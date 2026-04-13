---
title: "Istio TLS Layering: App TLS vs Mesh mTLS, Webhooks, Egress, and DestinationRule TLS Modes"
---

## Overview

When Istio injects sidecars into pods, all service-to-service traffic passes through Envoy proxies. Istio adds its own mTLS layer (using SPIFFE certificates) between sidecars. This raises a practical question: what happens when the application itself also has TLS configured? This note covers how TLS works across each hop, what happens in various combinations of app TLS + mesh mTLS, how kube-apiserver webhook calls interact with Istio, and how egress HTTPS to the internet behaves.

For Istio's mTLS mechanics, SPIFFE identity, and PeerAuthentication policy, see [[notes/Networking/istio-security|Istio Security]].

For the iptables-based traffic interception that makes all of this transparent, see [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]].

---

## The Three Legs of Traffic

Every request between two meshed pods traverses three distinct network segments, each with different encryption characteristics:

```
  Pod A (Client)                                          Pod B (Server)
 ┌──────────────────────────────┐                       ┌──────────────────────────────┐
 │                              │                       │                              │
 │  ┌──────────┐   iptables    │                       │   iptables    ┌───────────┐  │
 │  │Client App│───redirect───▶│ ┌────────┐  Network ┌────────┐ │◀───redirect───│Server App│  │
 │  │          │               │ │ Envoy  │══════════│ Envoy  │ │               │          │  │
 │  │          │◀──────────────│ │sidecar │Istio mTLS│sidecar │ │──────────────▶│          │  │
 │  └──────────┘   localhost   │ └────────┘ (SPIFFE) └────────┘ │   localhost   └──────────┘  │
 └──────────────────────────────┘                       └──────────────────────────────┘

       Leg 1                          Leg 2                          Leg 3
  localhost, PLAINTEXT          network, Istio mTLS            localhost, PLAINTEXT
  (app → own sidecar)          (sidecar ↔ sidecar)           (sidecar → app)
```

### Leg 1: Client App to Its Own Sidecar

**Always plaintext.** The app calls `connect("server-svc:8080")`, but iptables silently redirects to `127.0.0.1:15001` (Envoy's outbound listener). The app never opens a real TCP connection to the remote server — the connection stays on loopback within the pod's network namespace.

Envoy recovers the original destination via `getsockopt(SO_ORIGINAL_DST)` from the kernel's conntrack table, then routes based on that.

### Leg 2: Client Sidecar to Server Sidecar

**Istio mTLS.** When `PeerAuthentication` is `STRICT` or `PERMISSIVE` (the default), both sidecars perform a mutual TLS handshake using SPIFFE X.509 SVIDs issued by `istiod`. The ALPN is `istio-peer-exchange`. Both sides verify each other's certificates against the mesh root CA. Typically TLS 1.3 with ECDHE + AES-256-GCM.

This leg is the only one where data traverses the physical/virtual network. Istio mTLS ensures encryption and identity authentication on this segment.

### Leg 3: Server Sidecar to Server App

**Plaintext by default.** The server-side Envoy terminates the Istio mTLS, extracts the decrypted request, and forwards it to `127.0.0.1:<app-port>`. This is again loopback — no data on the wire.

---

## What Happens When the App Also Has TLS

### Scenario 1: No Special Configuration — Connection Fails

If the server app listens with TLS (e.g., on `:8443`) and you don't tell Istio, the server-side sidecar sends plaintext to the app (its default behavior). The app expects a TLS ClientHello but receives raw HTTP — handshake failure.

```
Client App ──plain──▶ Client Envoy ══Istio mTLS══▶ Server Envoy ──plaintext──▶ Server App (:8443 TLS)
                                                                                    │
                                                                   App expects TLS ClientHello
                                                                   Gets "GET /..." in plaintext
                                                                   → connection error ✗
```

### Scenario 2: Sidecar Configured to TLS Into the App — Double Encryption

You can configure the sidecar's upstream connection to use TLS when talking to the app. This results in two independent TLS layers:

```
On the wire between pods:
┌──────────────────────────────────────────────────┐
│ Istio mTLS (sidecar ↔ sidecar)                   │
│  ┌────────────────────────────────────────────┐  │
│  │ App TLS (sidecar → app on localhost)        │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │ GET /api/data HTTP/1.1               │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**Performance cost:**
- 2x TLS handshake latency per new connection (each involves ECDHE key exchange + cert verification)
- 2x symmetric encryption overhead (AES-GCM on every byte, twice)
- 2x per-connection TLS state memory
- 2x operational complexity (two sets of certificates, two rotation schedules, two layers to debug)

### Scenario 3: PASSTHROUGH Mode — App Handles TLS End-to-End

Istio passes the raw bytes through without terminating or originating TLS:

```
Client App ══app TLS══▶ Client Envoy ──TCP passthrough──▶ Server Envoy ──TCP passthrough──▶ Server App
                         (routes by SNI only,               (forwards raw bytes,
                          opaque TCP proxy)                   no Istio mTLS)
```

No Istio mTLS at all. Sidecars are reduced to TCP proxies. You lose:
- L7 metrics (request count, latency by path, status codes)
- Header-based routing, retries, fault injection
- `AuthorizationPolicy` rules on HTTP paths/methods
- Distributed tracing header propagation

Only TCP-level metrics (bytes in/out, connection count) and source-identity-based policies survive.

### Recommended Architecture for In-Mesh Services

**Disable TLS in the application. Let Istio own encryption.**

```
App ──plaintext──▶ Sidecar ═══Istio mTLS═══ Sidecar ──plaintext──▶ App

✓ Full L7 visibility (metrics, tracing, access logs)
✓ L7 routing (retries, fault injection, traffic splitting)
✓ AuthorizationPolicy based on SPIFFE identity
✓ Zero app-level TLS configuration
✓ Automatic cert rotation (24h default, no app restart — SDS hot-swap)
```

Legitimate reasons to keep app-level TLS:
- **Compliance** — PCI-DSS or HIPAA may not accept "the mesh handles it"
- **Zero-trust within the pod** — though if the sidecar is compromised, the attacker already sees decrypted traffic flowing through it
- **Migration** — transitioning to Istio, haven't stripped TLS from apps yet (use `PERMISSIVE` during transition)

---

## DestinationRule TLS Modes

`DestinationRule` controls how the **client-side sidecar** connects to the upstream. The `spec.trafficPolicy.tls.mode` field determines the TLS behavior:

| Mode | What the Client Sidecar Does | Use Case |
|---|---|---|
| `DISABLE` | Sends plaintext. No TLS origination. | Destination has no TLS. Will fail if server `PeerAuthentication` is `STRICT`. |
| `SIMPLE` | Originates one-way TLS. Validates server cert, does **not** present a client cert. | External HTTPS services outside the mesh (e.g., `api.stripe.com`). |
| `MUTUAL` | Originates mTLS using **user-supplied** certs (you specify `clientCertificate`, `privateKey`, `caCertificates`). | External services requiring mTLS with specific certs (not Istio-issued). |
| `ISTIO_MUTUAL` | Originates mTLS using **Istio-issued SPIFFE certs**. Fully auto-managed by `istiod`. | In-mesh communication. **Auto-configured by Istio** — rarely set manually. |

```yaml
# Talking to an external HTTPS API (one-way TLS)
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: external-api
spec:
  host: api.stripe.com
  trafficPolicy:
    tls:
      mode: SIMPLE

# Explicit ISTIO_MUTUAL (rarely needed — Istio auto-configures this)
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: my-service-mtls
spec:
  host: my-service.default.svc.cluster.local
  trafficPolicy:
    tls:
      mode: ISTIO_MUTUAL
```

### PeerAuthentication + DestinationRule Interaction

`PeerAuthentication` controls what the **server sidecar accepts**. `DestinationRule` controls what the **client sidecar sends**. Both must agree:

```
Client DestinationRule    Server PeerAuthentication    Result
────────────────────────  ─────────────────────────    ───────────────────────
ISTIO_MUTUAL              STRICT                       ✓ Works (mTLS)
ISTIO_MUTUAL              PERMISSIVE                   ✓ Works (mTLS)
DISABLE                   STRICT                       ✗ Fails (server rejects plaintext)
DISABLE                   PERMISSIVE                   ✓ Works (plaintext)
ISTIO_MUTUAL              DISABLE                      ✗ Fails (server rejects mTLS)
```

---

## Port Protocol Detection and TLS

Istio auto-detects port protocols (or uses explicit port naming in `Service` definitions). This directly affects what happens when the client app sends TLS:

| Port Detection | Envoy Outbound Behavior | Client Sends TLS? | Result |
|---|---|---|---|
| Port named `http` / `grpc` or auto-detected as HTTP | Envoy expects plaintext HTTP, runs HTTP Connection Manager | Client sends TLS bytes (`0x16 0x03 0x03`) | **Breaks** — Envoy's HTTP parser fails on TLS record header |
| Port named `https` / `tls` / `tcp` or unnamed | Envoy treats as opaque TCP | Client sends TLS bytes | **Passes through** — Envoy tunnels inside Istio mTLS |

```
Port named "http" + client sends TLS:

  Client App ──TLS bytes──▶ Envoy outbound
                              │
                              HTTP parser sees 0x16 0x03 0x03
                              (TLS record header, not "GET"/"POST")
                              → parse error → connection reset ✗

Port named "https" + client sends TLS:

  Client App ──TLS bytes──▶ Envoy outbound
                              │
                              TCP proxy mode — pipes bytes through
                              → tunneled inside Istio mTLS ✓
                              (but L7 features lost)
```

---

## Webhook TLS with Istio (kube-apiserver + Sidecar)

Kubernetes mutating/validating webhooks are called by `kube-apiserver` over HTTPS. The webhook spec mandates TLS — a `caBundle` is registered in the `MutatingWebhookConfiguration`/`ValidatingWebhookConfiguration`, and kube-apiserver validates the webhook server's cert against that CA.

### The Problem

**kube-apiserver is NOT in the mesh.** It runs on control plane nodes, has no Envoy sidecar, has no SPIFFE identity. It speaks regular TLS (one-way), not Istio mTLS.

```
kube-apiserver                                    Webhook Pod (operator)
(NOT in mesh,                                    ┌──────────────────────────────┐
 no sidecar)                                     │  iptables    ┌────────────┐  │
      │                                           │  redirect    │ Envoy      │  │
      │  Regular HTTPS                            │  ┌──────────▶│ sidecar    │  │
      │  (not Istio mTLS)                         │  │           │ (:15006)   │  │
      │───────────────────────────────────────────▶│──┘           └─────┬──────┘  │
      │                                           │               localhost      │
      │  Cannot present SPIFFE cert.              │                    │         │
      │  No istio-peer-exchange ALPN.             │            ┌──────▼───────┐  │
      │                                           │            │ Webhook      │  │
      │                                           │            │ Server :9443 │  │
      │                                           │            └──────────────┘  │
      │                                           └──────────────────────────────┘
```

When kube-apiserver's TLS connection arrives at the webhook pod, iptables redirects it to Envoy on `:15006`. Envoy performs protocol sniffing:

```
Envoy filter chain matching:

  Check: Is this Istio mTLS? (ALPN = istio-peer-exchange)
    → kube-apiserver doesn't send this → NO MATCH

  PeerAuthentication = STRICT:
    → Only Istio mTLS filter chain exists
    → No match → CONNECTION REJECTED ✗

  PeerAuthentication = PERMISSIVE:
    → Falls to second filter chain (TCP passthrough)
    → kube-apiserver's TLS bytes pass through to webhook server
    → Webhook server completes TLS handshake directly ✓
```

### Two Independent PKI Systems

The webhook pod has two completely separate trust chains operating simultaneously:

```
Istio PKI:
  istiod CA → issues SPIFFE SVIDs → Envoy sidecar
  Used for: sidecar ↔ sidecar mTLS (mesh traffic)

Webhook PKI:
  cert-manager CA (or manual certs) → webhook server cert
  Used for: kube-apiserver → webhook TLS
  Registered in: MutatingWebhookConfiguration.caBundle

These never interact. Independent trust chains, independent certificates.
```

### Solutions

**Option 1: Port-level PeerAuthentication override (recommended)**

Keep STRICT for mesh traffic, PERMISSIVE only on the webhook port:

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: my-operator-webhook
  namespace: my-operator-ns
spec:
  selector:
    matchLabels:
      app: my-operator
  mtls:
    mode: STRICT          # all other ports: Istio mTLS only
  portLevelMtls:
    9443:
      mode: PERMISSIVE    # webhook port: accept non-Istio TLS too
```

Traffic from mesh services hits STRICT. Traffic from kube-apiserver on `:9443` passes through as TCP — kube-apiserver's TLS handshake reaches the webhook server directly.

**Option 2: Exclude the webhook port from sidecar interception**

```yaml
metadata:
  annotations:
    traffic.sidecar.istio.io/excludeInboundPorts: "9443"
```

iptables skips redirecting port 9443 to Envoy. kube-apiserver connects directly to the webhook server. Downside: no mesh visibility or `AuthorizationPolicy` on that port.

**Option 3: Disable sidecar injection entirely**

```yaml
metadata:
  annotations:
    sidecar.istio.io/inject: "false"
```

Nuclear option — loses all mesh features for the entire pod.

---

## Egress HTTPS to the Internet with STRICT Mode

When a meshed client app makes an HTTPS request to an external service (e.g., `https://api.stripe.com`), `PeerAuthentication: STRICT` does **not** break it.

```
Client App ──HTTPS──▶ Client Envoy ──TLS passthrough──▶ api.stripe.com
                       │                                     │
                       No server-side sidecar.               Not in mesh.
                       STRICT doesn't apply —                No PeerAuthentication
                       there's no remote sidecar             to enforce.
                       to enforce it.
                       
                       Envoy peeks at SNI, routes
                       via TCP proxy, passes bytes through.
```

`PeerAuthentication: STRICT` only governs **sidecar-to-sidecar** connections within the mesh. For external destinations, there is no remote sidecar — the client sidecar tunnels the app's TLS bytes directly to the internet. The app's TLS handshake completes with the external server.

For L7 control over egress (allow/deny specific external hosts), use `ServiceEntry` + `DestinationRule` with `mode: SIMPLE` — that is routing policy, not `PeerAuthentication`.

---

## See Also

- [[notes/Networking/istio-security|Istio Security: mTLS, SPIFFE, AuthorizationPolicy]] — mTLS mechanics, PeerAuthentication policy, AuthorizationPolicy
- [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]] — Sidecar injection, iptables interception, xDS, ambient mode
- [[notes/Networking/istio-traffic-management|Istio Traffic Management]] — VirtualService, DestinationRule, Gateway API, ServiceEntry
- [[notes/Networking/tls-1.3-handshake|TLS 1.3 Handshake]] — The TLS protocol underlying both app TLS and Istio mTLS
- [[notes/AuthNZ/http-sessions-cookies-security|HTTP Sessions & Cookie Security]] — Application-layer auth that rides on top of these transport layers

---

## Interview Prep

### Q: A pod has both app-level TLS and Istio mTLS enabled. Walk through what happens on each network segment.

**A:**

```
Leg 1 (client app → client sidecar):
  Plaintext on localhost. iptables redirects to Envoy :15001.
  Envoy reads original destination via SO_ORIGINAL_DST.

Leg 2 (client sidecar → server sidecar):
  Istio mTLS. Both sidecars present SPIFFE X.509 SVIDs.
  TLS 1.3, ECDHE + AES-256-GCM. Encrypted on the wire.
  If client sent app-TLS bytes, they are tunneled inside
  this mTLS connection (double encryption on the wire).

Leg 3 (server sidecar → server app):
  Sidecar terminates Istio mTLS. Forwards inner bytes to
  localhost. If inner bytes are app TLS and app expects TLS,
  the app completes its own TLS handshake. If app expects
  plaintext, it fails.
```

The recommended approach is to disable app TLS entirely for in-mesh services and let Istio handle encryption. This gives full L7 visibility and avoids redundant crypto overhead.

### Q: Mesh-wide `PeerAuthentication` is STRICT. Your operator's validating webhook stops working. Why, and how do you fix it?

**A:** kube-apiserver is not in the mesh — it has no sidecar and no SPIFFE identity. It speaks regular TLS, not Istio mTLS. When its TLS connection hits the webhook pod's sidecar, Envoy checks for the `istio-peer-exchange` ALPN and doesn't find it. In STRICT mode, only the Istio mTLS filter chain exists — the connection is rejected.

Fix with port-level override:

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: webhook-auth
spec:
  selector:
    matchLabels:
      app: my-operator
  mtls:
    mode: STRICT
  portLevelMtls:
    9443:
      mode: PERMISSIVE   # accept kube-apiserver's regular TLS
```

This keeps STRICT for all mesh traffic while allowing the webhook port to accept non-Istio TLS from kube-apiserver.

### Q: Your client app is hardcoded to use `https://` for an in-mesh service. The service port is named `http`. What breaks and why?

**A:** The client app sends TLS bytes (starting with `0x16 0x03 0x03` — TLS record header) to its sidecar. Because the port is named `http`, the client-side Envoy's filter chain uses the HTTP Connection Manager, which expects plaintext HTTP. The HCM tries to parse the TLS record header as an HTTP method — fails immediately. Connection reset.

This breaks on the **client side** before traffic even reaches the wire. `PeerAuthentication` mode is irrelevant — the issue is protocol mismatch at the outbound Envoy.

Fix: either rename the port to `https`/`tcp` (Envoy treats it as opaque TCP, but you lose L7 features), or — the better fix — remove `https://` from the client and let it send plaintext HTTP so Istio can handle encryption transparently.

### Q: An in-mesh client sends HTTPS to an external API (`api.stripe.com`). `PeerAuthentication` is STRICT. Does it break?

**A:** No. `PeerAuthentication: STRICT` only governs sidecar-to-sidecar connections within the mesh. External destinations have no sidecar — there is no `PeerAuthentication` to enforce. The client sidecar peeks at the SNI from the TLS ClientHello, routes the connection via TCP proxy, and passes the app's TLS bytes through to the internet. The TLS handshake completes directly between the client app and the external server.

### Q: Compare `DestinationRule` TLS modes: DISABLE, SIMPLE, MUTUAL, ISTIO_MUTUAL.

**A:**

```
Mode            Client sidecar behavior             Typical use case
──────────────  ──────────────────────────────────  ──────────────────────────────
DISABLE         Sends plaintext, no TLS             Dest has no TLS, or
                                                    explicitly disabling mTLS

SIMPLE          One-way TLS: validates server        External HTTPS service
                cert, no client cert presented       (api.stripe.com, etc.)

MUTUAL          mTLS with user-supplied certs        External service requiring
                (you specify cert/key/CA paths)      mTLS with specific certs

ISTIO_MUTUAL    mTLS with auto-managed SPIFFE        In-mesh service-to-service
                certs from istiod                    (auto-configured by Istio,
                                                     rarely set manually)
```

`ISTIO_MUTUAL` is what Istio auto-configures for in-mesh traffic. You almost never write a `DestinationRule` with this mode unless overriding a specific port or subset.

### Q: Why can't kube-apiserver just use Istio mTLS for webhooks?

**A:** Three reasons:

1. **kube-apiserver runs outside the mesh.** Even on managed Kubernetes (GKE, EKS), the control plane has no sidecar and no SPIFFE certificate.
2. **The webhook spec hardcodes regular TLS.** `caBundle` is how trust is established — there's no extension point for "use Istio mTLS instead."
3. **Separate PKI.** kube-apiserver uses the cluster CA or a dedicated webhook CA (often cert-manager). Istio's SPIFFE trust chain is completely separate. The two PKI systems coexist on the same pod but never interact.
