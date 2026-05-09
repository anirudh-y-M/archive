---
title: "Summary: Istio TLS Layering — App TLS vs Mesh mTLS, Webhooks, Egress, DestinationRule Modes"
---

> **Full notes:** [[notes/Networking/istio-tls-layering|Istio TLS Layering -->]]

## Key Concepts

### The Three Legs of Traffic

Every meshed request crosses three distinct segments with different encryption properties:

| Leg | Path | Encryption |
|---|---|---|
| 1 | Client app → its own sidecar | Plaintext on localhost (iptables redirect to `:15001`; Envoy reads orig dest via `SO_ORIGINAL_DST`) |
| 2 | Client sidecar ↔ server sidecar | **Istio mTLS** with SPIFFE X.509 SVIDs, ALPN `istio-peer-exchange`, typically TLS 1.3 + ECDHE + AES-256-GCM |
| 3 | Server sidecar → server app | Plaintext on localhost |

Only Leg 2 traverses the wire; that's where Istio mTLS provides encryption + identity.

### App TLS + Mesh mTLS Combinations

| Scenario | Behavior |
|---|---|
| App listens TLS, sidecar sends plaintext | Server expects ClientHello, gets `GET /...` → handshake fails ✗ |
| Sidecar configured to TLS into app | **Double encryption** — Istio mTLS wraps app TLS; 2x handshake + symmetric crypto + cert mgmt |
| `PASSTHROUGH` mode | App handles TLS end-to-end; sidecar = TCP proxy. Lose L7 metrics/routing, AuthorizationPolicy on HTTP, tracing propagation. Only TCP-level signals survive. |

**Recommended for in-mesh services:** strip TLS from the app, let Istio own encryption. Gives full L7 visibility, retries/fault injection, identity-based AuthorizationPolicy, automatic 24 h cert rotation via SDS hot-swap.

Legitimate reasons to keep app TLS: compliance (PCI-DSS, HIPAA), in-pod zero-trust, in-flight migration with `PERMISSIVE`.

### DestinationRule TLS Modes

`spec.trafficPolicy.tls.mode` controls what the **client sidecar** sends:

| Mode | Client sidecar behavior | Use case |
|---|---|---|
| `DISABLE` | Plaintext, no TLS | Dest has no TLS; fails if server is `STRICT` |
| `SIMPLE` | One-way TLS, validates server cert, no client cert | External HTTPS (e.g. `api.stripe.com`) |
| `MUTUAL` | mTLS with **user-supplied** certs/key/CA | External services requiring specific mTLS certs |
| `ISTIO_MUTUAL` | mTLS with **istiod-issued SPIFFE certs** | In-mesh (auto-configured; rarely set manually) |

### PeerAuthentication ↔ DestinationRule Interaction

`PeerAuthentication` controls what the **server sidecar accepts**; `DestinationRule.tls.mode` controls what the **client sends**. Both must agree:

| Client (DR) | Server (PA) | Result |
|---|---|---|
| `ISTIO_MUTUAL` | `STRICT` | ✓ mTLS |
| `ISTIO_MUTUAL` | `PERMISSIVE` | ✓ mTLS |
| `DISABLE` | `STRICT` | ✗ server rejects plaintext |
| `DISABLE` | `PERMISSIVE` | ✓ plaintext |
| `ISTIO_MUTUAL` | `DISABLE` | ✗ server rejects mTLS |

### Port Protocol Detection vs Client TLS

Istio detects port protocol from the K8s Service port name (`http`, `grpc`, `https`, `tcp`) or `appProtocol`. Mismatch with what the client actually sends breaks things on the **client-side** Envoy:

| Port name | Envoy outbound mode | Client sends TLS? | Result |
|---|---|---|---|
| `http` / `grpc` (or auto-detected HTTP) | HTTP Connection Manager (expects plaintext) | Yes (`0x16 0x03 0x03` TLS record header) | HCM parser fails on TLS bytes → **connection reset** |
| `https` / `tls` / `tcp` (or unnamed) | Opaque TCP proxy | Yes | Tunneled inside Istio mTLS ✓ (but L7 features lost) |

### Webhook TLS — kube-apiserver + Sidecar

**kube-apiserver is NOT in the mesh** — no sidecar, no SPIFFE identity. It calls webhooks over regular one-way TLS validated against `MutatingWebhookConfiguration.caBundle`. When this hits the webhook pod's sidecar:

- Envoy filter chain matching looks for ALPN `istio-peer-exchange` → kube-apiserver doesn't send it.
- `PeerAuthentication: STRICT` → only the Istio mTLS chain exists → **REJECTED**.
- `PERMISSIVE` → falls through to second filter chain (TCP passthrough) → kube-apiserver's TLS reaches the webhook server ✓.

**Two independent PKI systems coexist on the webhook pod:**
- Istio PKI: istiod CA → SPIFFE SVIDs → sidecar mTLS (mesh traffic)
- Webhook PKI: cert-manager (or manual) CA → webhook server cert → registered in `caBundle` (kube-apiserver→webhook)

#### Fixes

| Option | Mechanism | Trade-off |
|---|---|---|
| Port-level PA override (recommended) | `portLevelMtls: { 9443: { mode: PERMISSIVE } }` while top-level stays STRICT | Webhook port accepts non-Istio TLS; mesh traffic still STRICT |
| Exclude port from interception | `traffic.sidecar.istio.io/excludeInboundPorts: "9443"` | iptables skips the port; loses mesh visibility on it |
| Disable injection entirely | `sidecar.istio.io/inject: "false"` | Nuclear; pod loses all mesh features |

### Egress HTTPS to the Internet under STRICT

`PeerAuthentication: STRICT` does **NOT** break egress to external HTTPS. STRICT only governs **sidecar↔sidecar** within the mesh. External destinations have no remote sidecar, so there's no PA to enforce. Client Envoy peeks at SNI from the ClientHello, routes via TCP proxy, passes the app's TLS bytes through. Handshake completes directly between client app and external server.

For L7 control over egress (allow/deny specific external hosts), use `ServiceEntry` + `DestinationRule` with `mode: SIMPLE`.

## Quick Reference

### The three-leg picture

```
Pod A (Client)                                              Pod B (Server)
┌────────────┐  iptables   ┌────────┐   network    ┌────────┐  iptables   ┌────────────┐
│ Client App │──redirect──▶│ Envoy  │═══mTLS══════▶│ Envoy  │──redirect──▶│ Server App │
└────────────┘  loopback   └────────┘  (SPIFFE)    └────────┘  loopback   └────────────┘
       Leg 1                    Leg 2                    Leg 3
   plaintext              Istio mTLS on wire             plaintext
```

### Webhook port-level override

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: my-operator-webhook
spec:
  selector: { matchLabels: { app: my-operator } }
  mtls: { mode: STRICT }
  portLevelMtls:
    9443:
      mode: PERMISSIVE
```

### Egress under STRICT

```
Client App ──HTTPS──▶ Client Envoy ──TLS passthrough (SNI route)──▶ api.stripe.com
                       (no remote sidecar; PA doesn't apply)
```

## Key Takeaways

- All mesh traffic crosses three legs: plaintext loopback in, mTLS on the wire, plaintext loopback out. Only Leg 2 needs encryption — Istio handles it.
- Disable app-level TLS for in-mesh services. Otherwise you double-encrypt or break L7 features. Compliance is the main legitimate exception.
- `PASSTHROUGH` reduces sidecars to TCP proxies — you lose all L7 features including `AuthorizationPolicy` on HTTP paths/methods and request-level metrics.
- `DestinationRule.tls.mode` and `PeerAuthentication.mtls.mode` MUST agree. Mismatched STRICT/DISABLE pairings cause silent breaks.
- Port naming matters: an HTTP-named port + a client sending TLS bytes (`0x16 0x03 0x03`) breaks at the client-side Envoy's HCM, not on the wire.
- kube-apiserver is not in the mesh — STRICT mTLS will block its webhook calls. Fix with port-level `PERMISSIVE` (cleanest) or `excludeInboundPorts`.
- The webhook pod runs two independent PKI systems simultaneously (Istio SPIFFE + webhook cert via `caBundle`). They never interact.
- Egress HTTPS to external services works under STRICT — PA only applies sidecar↔sidecar. Client Envoy SNI-routes and passes TLS bytes through to the internet.
- For controlled egress, use `ServiceEntry` + `DestinationRule` with `SIMPLE` (one-way TLS) or `MUTUAL` (user-supplied certs).
- Auto-managed cert rotation (24 h default via SDS hot-swap, no app restart) is a major operational win of letting Istio own TLS.
