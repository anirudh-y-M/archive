---
title: "Istio Security: mTLS, SPIFFE, AuthorizationPolicy, JWT Validation, and External Authorization"
---

## Overview

Istio provides a comprehensive security layer for service-to-service communication: automatic mutual TLS (mTLS) with SPIFFE identities, request-level JWT authentication, fine-grained RBAC authorization, and delegation to external authorization services. All security features are enforced transparently by the Envoy sidecar -- application code requires zero changes.

For the Istio control plane architecture and xDS protocol, see [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]]. For traffic management CRDs, see [[notes/Networking/istio-traffic-management|Istio Traffic Management]]. For Envoy filter internals (including the RBAC and jwt_authn filters), see [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]].

---

## mTLS in Istio

Istio provides automatic mutual TLS between all meshed workloads. Every sidecar gets a short-lived X.509 certificate with a SPIFFE identity, and all service-to-service communication is encrypted and authenticated.

### SPIFFE Identity

Every workload in the mesh receives a SPIFFE (Secure Production Identity Framework for Everyone) identity based on its Kubernetes service account:

```
spiffe://<trust-domain>/ns/<namespace>/sa/<service-account>

Example:
spiffe://cluster.local/ns/default/sa/reviews
```

This identity is embedded in the SAN (Subject Alternative Name) field of the X.509 certificate that istiod issues to the workload.

### Certificate Issuance Flow

```
  Pod starts with istio-proxy container
       │
       ▼
  pilot-agent reads the pod's Kubernetes Service Account token
  (projected token mounted at /var/run/secrets/tokens/istio-token)
       │
       ▼
  pilot-agent generates a private key + CSR
  (CSR includes SPIFFE ID: spiffe://cluster.local/ns/default/sa/reviews)
       │
       ▼
  pilot-agent sends CSR + SA token to istiod (gRPC, port 15012)
       │
       ▼
  istiod validates the SA token with Kubernetes API server
  (TokenReview API -- confirms the token is valid and not expired)
       │
       ▼
  istiod CA signs the CSR, producing an X.509 certificate
  (short TTL, default 24 hours)
       │
       ▼
  istiod returns the signed certificate to pilot-agent
       │
       ▼
  pilot-agent serves the certificate + private key to Envoy
  via the SDS API over a local Unix domain socket
  (/var/run/secrets/workload-spiffe-uds/socket)
       │
       ▼
  Envoy uses the certificate for:
  - Outbound: presenting identity when connecting to other services
  - Inbound: authenticating to peers + encrypting traffic
       │
       ▼
  pilot-agent monitors expiration, rotates before TTL expires
  (no Envoy restart needed -- SDS hot-swaps the cert)
```

### mTLS Handshake Between Services

```
  Envoy A (client)                              Envoy B (server)
       │                                              │
       │ ──── TLS ClientHello ─────────────────────► │
       │      (ALPN: istio-peer-exchange, h2)         │
       │                                              │
       │ ◄─── TLS ServerHello + Certificate ───────── │
       │      cert SAN: spiffe://cluster.local/       │
       │                ns/default/sa/reviews          │
       │      + CertificateVerify                     │
       │                                              │
       │ ──── Client Certificate ──────────────────► │
       │      cert SAN: spiffe://cluster.local/       │
       │                ns/default/sa/productpage      │
       │      + CertificateVerify                     │
       │                                              │
       │ ◄──► Finished ──────────────────────────────►│
       │                                              │
       │ ═══════ Encrypted application data ═════════ │
       │      (HTTP request/response over mTLS)       │
```

Both sides verify:

1. The peer's certificate is signed by the mesh CA (istiod)
2. The SPIFFE identity in the SAN matches the expected service account
3. The certificate is not expired

### PeerAuthentication Policy

Controls the mTLS mode at different scopes:

```yaml
# Mesh-wide: enforce STRICT mTLS everywhere
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system     # root namespace = mesh-wide
spec:
  mtls:
    mode: STRICT              # reject any plaintext traffic
```

```yaml
# Namespace-level: allow plaintext for migration
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: legacy-apps
spec:
  mtls:
    mode: PERMISSIVE          # accept both mTLS and plaintext
```

```yaml
# Workload-specific: port-level override
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: reviews-mtls
  namespace: default
spec:
  selector:
    matchLabels:
      app: reviews
  mtls:
    mode: STRICT
  portLevelMtls:
    8080:
      mode: PERMISSIVE        # allow plaintext on this port only
```


| Mode         | Behavior                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------ |
| `STRICT`     | Only mTLS traffic accepted. Plaintext connections are rejected.                            |
| `PERMISSIVE` | Accepts both mTLS and plaintext. Envoy auto-detects the protocol. Useful during migration. |
| `DISABLE`    | mTLS disabled for this scope. Not recommended.                                             |
| `UNSET`      | Inherits from parent scope (workload inherits namespace, namespace inherits mesh).         |

---

## Security Evaluation Flow

Every inbound request to a meshed workload passes through the following security checks inside Envoy, in this exact order:

```
┌──────────────────────────────────────────────────────────────────────────┐
│              SECURITY EVALUATION ORDER FOR INCOMING REQUEST               │
│                                                                           │
│  Incoming connection                                                      │
│         │                                                                 │
│         ▼                                                                 │
│  ┌─────────────────────┐                                                 │
│  │  1. mTLS Handshake   │  PeerAuthentication policy                     │
│  │                       │  - STRICT: require valid client cert           │
│  │  Validate peer cert   │  - PERMISSIVE: accept with or without         │
│  │  Extract SPIFFE ID    │  - DISABLE: no TLS                            │
│  │  from SAN             │                                                │
│  └──────────┬────────────┘                                               │
│             │  Peer identity established (or plaintext if PERMISSIVE)    │
│             ▼                                                             │
│  ┌─────────────────────────┐                                             │
│  │  2. RequestAuthentication│  JWT validation                            │
│  │                           │  - Fetch JWKS from issuer                 │
│  │  Validate JWT token       │  - Verify signature, expiry, audience     │
│  │  (if present in request)  │  - Extract claims to filter metadata      │
│  │                           │                                            │
│  │  Missing token?           │                                            │
│  │  → Allowed (unless        │                                            │
│  │    AuthorizationPolicy    │                                            │
│  │    requires JWT claims)   │                                            │
│  └──────────┬────────────────┘                                           │
│             │  JWT claims available (if token was present and valid)     │
│             ▼                                                             │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │  3. AuthorizationPolicy evaluation                                 │   │
│  │                                                                     │   │
│  │  Three actions, evaluated in strict order:                          │   │
│  │                                                                     │   │
│  │  ┌─────────────────┐                                               │   │
│  │  │  a. CUSTOM       │ → Calls ext_authz service                    │   │
│  │  │  (if configured) │   If DENY → 403, stop                        │   │
│  │  │                   │   If ALLOW → continue                        │   │
│  │  └────────┬──────────┘                                             │   │
│  │           ▼                                                         │   │
│  │  ┌─────────────────┐                                               │   │
│  │  │  b. DENY         │ → If ANY deny rule matches → 403, stop       │   │
│  │  │  (if configured) │   If no deny rule matches → continue         │   │
│  │  └────────┬──────────┘                                             │   │
│  │           ▼                                                         │   │
│  │  ┌─────────────────┐                                               │   │
│  │  │  c. ALLOW        │ → If ANY allow rule matches → allow          │   │
│  │  │  (if configured) │   If NO allow rule matches → 403, deny       │   │
│  │  │                   │                                              │   │
│  │  │  If NO ALLOW      │                                              │   │
│  │  │  policies exist   │ → Allow all (implicit allow)                │   │
│  │  └─────────────────┘                                               │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│             │                                                             │
│             ▼                                                             │
│  Request forwarded to application                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

The evaluation order is **CUSTOM -> DENY -> ALLOW**. This is critical to understand:

1. **CUSTOM** policies are evaluated first. If any CUSTOM policy denies the request, evaluation stops immediately.
2. **DENY** policies are evaluated next. If any DENY rule matches, the request is denied regardless of ALLOW policies.
3. **ALLOW** policies are evaluated last. If ALLOW policies exist, at least one must match for the request to proceed. If no ALLOW policies exist at all, the request is implicitly allowed (after passing DENY checks).

---

## AuthorizationPolicy

AuthorizationPolicy is the RBAC mechanism for Istio. It controls which workloads can communicate with each other and under what conditions. At the Envoy level, AuthorizationPolicy translates to the `envoy.filters.http.rbac` and `envoy.filters.network.rbac` filters.

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: <name>
  namespace: <namespace>       # applies to workloads in this namespace
spec:
  selector:                    # optional: target specific workloads
    matchLabels:
      app: my-service
  action: ALLOW | DENY | CUSTOM   # default: ALLOW
  provider:                    # only for action: CUSTOM
    name: my-ext-authz
  rules:
  - from:                      # source conditions (AND with 'to' and 'when')
    - source:
        principals: [...]      # SPIFFE identity
        namespaces: [...]
        ipBlocks: [...]
    to:                        # destination conditions
    - operation:
        methods: [...]
        paths: [...]
        ports: [...]
    when:                      # additional conditions
    - key: request.headers[x-custom-token]
      values: ["valid-token"]
```

### Example: Deny-First Pattern (Recommended)

The deny-first pattern provides a deny-by-default posture:

```yaml
# 1. Deny all traffic by default (mesh-wide in istio-system)
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: deny-all
  namespace: istio-system      # mesh-wide scope
spec:
  {}                           # empty spec with no rules = deny everything

---
# 2. Allow specific traffic
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-frontend-to-api
  namespace: backend
spec:
  selector:
    matchLabels:
      app: api-server
  action: ALLOW
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/frontend/sa/webapp"]
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/api/*"]
```

> **Note:** An empty `spec: {}` with no `rules` means "match all traffic but have no allow rules." Since ALLOW policies exist (with zero matching rules), all traffic is denied. This is the standard deny-by-default pattern.

### Example: Source-Based, Path-Based, and Header-Based Rules

```yaml
# Allow only requests from the "monitoring" namespace to /metrics
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-metrics-scrape
  namespace: my-app
spec:
  selector:
    matchLabels:
      app: my-service
  action: ALLOW
  rules:
  - from:
    - source:
        namespaces: ["monitoring"]
    to:
    - operation:
        paths: ["/metrics", "/stats/prometheus"]
        methods: ["GET"]

---
# Deny requests with a specific header (e.g., block internal testing header in prod)
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: deny-test-header
  namespace: production
spec:
  action: DENY
  rules:
  - when:
    - key: request.headers[x-test-request]
      values: ["true"]
```

### Example: JWT-Claim-Based Authorization

```yaml
# Only allow requests with a valid JWT that has role=admin
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: require-admin-role
  namespace: admin-portal
spec:
  selector:
    matchLabels:
      app: admin-dashboard
  action: ALLOW
  rules:
  - from:
    - source:
        requestPrincipals: ["https://auth.example.com/*"]  # issuer must match
    when:
    - key: request.auth.claims[role]
      values: ["admin"]
    to:
    - operation:
        methods: ["GET", "POST", "PUT", "DELETE"]
```

The `request.auth.claims[...]` fields are populated by the `RequestAuthentication` resource's JWT validation (covered below). Without a corresponding `RequestAuthentication`, no JWT validation occurs and these claim-based rules never match.

---

## RequestAuthentication (JWT Validation)

RequestAuthentication configures Envoy to validate JWT tokens on incoming requests. It maps to the `envoy.filters.http.jwt_authn` filter in Envoy.

```yaml
apiVersion: security.istio.io/v1
kind: RequestAuthentication
metadata:
  name: jwt-auth
  namespace: my-app
spec:
  selector:
    matchLabels:
      app: api-server
  jwtRules:
  - issuer: "https://auth.example.com"
    jwksUri: "https://auth.example.com/.well-known/jwks.json"
    audiences:                                 # optional: restrict accepted audiences
    - "api.example.com"
    forwardOriginalToken: true                 # pass validated JWT to upstream app
    fromHeaders:                               # where to find the token
    - name: Authorization
      prefix: "Bearer "
    fromParams:                                # also check query param
    - "access_token"
    outputPayloadToHeader: "x-jwt-payload"     # optional: forward decoded payload
```

How JWT validation works at the Envoy filter level:

```
  Request arrives with Authorization: Bearer <token>
         │
         ▼
  jwt_authn filter extracts token from header/param
         │
         ▼
  Fetch JWKS from issuer's jwksUri
  (cached in Envoy, refreshed periodically)
         │
         ▼
  Validate JWT:
  - Signature verification (RS256, ES256, etc.)
  - Expiry check (exp claim)
  - Issuer match (iss claim)
  - Audience match (aud claim, if configured)
         │
         ├── Invalid → 401 Unauthorized
         │
         └── Valid → Extract claims to Envoy filter metadata
                     (available to downstream filters like RBAC)
```

**Key behavior**: If a request has **no JWT token at all**, `RequestAuthentication` does **not reject it**. It only rejects requests with **invalid** tokens. To require a token, you must pair it with an `AuthorizationPolicy` that demands specific JWT claims (e.g., `requestPrincipals` must be non-empty).

This two-resource pattern is intentional -- it separates authentication (is the token valid?) from authorization (is this identity allowed?).

### Integration with External Identity Providers

RequestAuthentication works with any OIDC-compliant provider that publishes a JWKS endpoint:

| Provider | jwksUri Example |
|----------|----------------|
| Auth0 | `https://YOUR_DOMAIN.auth0.com/.well-known/jwks.json` |
| Keycloak | `https://keycloak.example.com/realms/myrealm/protocol/openid-connect/certs` |
| Google | `https://www.googleapis.com/oauth2/v3/certs` |
| Azure AD | `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys` |
| Okta | `https://YOUR_DOMAIN.okta.com/oauth2/default/v1/keys` |

---

## External Authorization (ext_authz)

For authorization logic too complex for static RBAC rules (e.g., checking a database, evaluating OPA policies, calling a custom decision service), Istio supports delegating authorization to an external service via the `ext_authz` Envoy filter.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    EXT_AUTHZ FLOW                                        │
│                                                                          │
│  Request arrives at Envoy                                                │
│         │                                                                │
│         ▼                                                                │
│  ext_authz filter activated                                              │
│  (before RBAC filter in the chain)                                       │
│         │                                                                │
│         │  gRPC call (or HTTP call) to external service:                 │
│         │  - sends: source IP, headers, path, method,                    │
│         │    SNI, peer cert, request body (if configured)                │
│         ▼                                                                │
│  ┌───────────────────────────────────────┐                              │
│  │  External Authz Service               │                              │
│  │  (e.g., OPA, custom Go/Python svc)    │                              │
│  │                                        │                              │
│  │  Evaluates policy:                     │                              │
│  │  - Query OPA Rego policies             │                              │
│  │  - Check database / Redis              │                              │
│  │  - Multi-tenant authorization          │                              │
│  │  - Rate limiting with custom logic     │                              │
│  │                                        │                              │
│  │  Returns:                              │                              │
│  │  - OK (200) → request continues        │                              │
│  │  - Denied (403) → request rejected     │                              │
│  │  - Can add/remove headers              │                              │
│  └──────────────────┬────────────────────┘                              │
│                     │                                                    │
│                     ▼                                                    │
│  Envoy receives decision                                                │
│  ├── ALLOW → proceed to RBAC → ALLOW evaluation → route to upstream     │
│  └── DENY  → return 403 to client immediately                          │
└─────────────────────────────────────────────────────────────────────────┘
```

Configuring ext_authz in Istio:

```yaml
# 1. Register the ext_authz provider in MeshConfig
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
  meshConfig:
    extensionProviders:
    - name: "opa-authz"
      envoyExtAuthzGrpc:
        service: "opa.opa-system.svc.cluster.local"
        port: 9191
        # optional: include request body in authz check
        includeRequestBodyInCheck:
          maxRequestBytes: 4096
          allowPartialMessage: true

---
# 2. AuthorizationPolicy with CUSTOM action
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: opa-authz
  namespace: my-app
spec:
  selector:
    matchLabels:
      app: api-server
  action: CUSTOM
  provider:
    name: opa-authz                # references the meshConfig provider
  rules:
  - to:
    - operation:
        paths: ["/api/*"]          # only trigger ext_authz for /api/ paths
```

The ext_authz service must implement either the Envoy `envoy.service.auth.v3.Authorization` gRPC interface or a simple HTTP check interface (Envoy sends the request headers as-is to the HTTP endpoint).

---

## See also

- [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]] -- control plane, xDS, sidecar injection, iptables, request lifecycle
- [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]] -- Envoy filter chain (RBAC, jwt_authn filters)
- [[notes/Networking/istio-traffic-management|Istio Traffic Management]] -- VirtualService, DestinationRule, Gateway API
- [[notes/Networking/istio-observability-extensibility|Istio Observability & Extensibility]] -- metrics, tracing, WasmPlugin, EnvoyFilter
- [[notes/Networking/tls-1.3-handshake|TLS 1.3 Handshake]] -- mTLS in Istio uses TLS under the hood
- [[notes/AuthNZ/OIDC_Oauth|OIDC & OAuth]] -- JWT validation and OIDC fundamentals for RequestAuthentication
- [Istio Security Concepts (mTLS, SPIFFE)](https://istio.io/latest/docs/concepts/security/)
- [Istio AuthorizationPolicy Reference](https://istio.io/latest/docs/reference/config/security/authorization-policy/)
- [Istio RequestAuthentication Reference](https://istio.io/latest/docs/reference/config/security/request_authentication/)
- [Istio External Authorization](https://istio.io/latest/docs/tasks/security/authorization/authz-custom/)
- [SPIFFE Standard](https://spiffe.io/)

---

## Interview Prep

### Q: How does mTLS work in Istio? How are certificates managed?

**A:** Istio uses SPIFFE X.509 certificates for mutual TLS. The flow:

1. When a pod starts, `pilot-agent` in the `istio-proxy` container reads the pod's projected Kubernetes service account token.
2. `pilot-agent` generates a private key locally and creates a CSR (Certificate Signing Request) with the SPIFFE ID `spiffe://cluster.local/ns/<namespace>/sa/<service-account>`.
3. It sends the CSR + SA token to istiod over gRPC (port 15012).
4. istiod validates the SA token via the Kubernetes TokenReview API, then signs the CSR using its CA. The resulting certificate has a short TTL (default 24 hours).
5. `pilot-agent` serves the certificate and private key to Envoy over a local Unix domain socket using the SDS (Secret Discovery Service) API.
6. Envoy uses the cert for both inbound (server-side mTLS) and outbound (client-side mTLS) connections.
7. `pilot-agent` monitors expiration and rotates the cert before it expires -- no restart needed, SDS hot-swaps it.

The private key never leaves the pod. istiod only sees the CSR (public key + identity request), not the private key. PeerAuthentication policies control whether mTLS is STRICT (required), PERMISSIVE (accept both), or DISABLE.

---

### Q: What is the evaluation order of AuthorizationPolicy actions? What happens if you have CUSTOM, DENY, and ALLOW policies?

**A:** The evaluation order is strictly: **CUSTOM -> DENY -> ALLOW**.

```
  Request arrives
       │
       ▼
  CUSTOM policies evaluated ───► Any deny? ──► 403 (stop)
       │ (ext_authz call)              │
       │                               No
       ▼                               │
  DENY policies evaluated ────► Any match? ──► 403 (stop)
       │                               │
       │                               No
       ▼                               │
  ALLOW policies exist?                │
       │                               │
       ├── No ALLOW policies ─────────► ALLOW (implicit allow-all)
       │
       └── ALLOW policies exist ──► Any match? ──► ALLOW
                                        │
                                        No match ──► 403 (deny)
```

Critical nuances:

- If **no AuthorizationPolicy exists** at all for a workload, all traffic is allowed (implicit allow).
- If an ALLOW policy exists with **zero matching rules** (empty `spec: {}`), all traffic is denied. This is the standard deny-by-default pattern.
- DENY always wins over ALLOW. Even if an ALLOW rule matches, a matching DENY rule takes precedence.
- CUSTOM is evaluated first. If the ext_authz service denies, neither DENY nor ALLOW policies are consulted.

---

### Q: RequestAuthentication allows requests with no JWT token. Why? How do you require a token?

**A:** This is a deliberate design choice. `RequestAuthentication` only validates tokens that **are present**. If a request has no token, it passes through `RequestAuthentication` without error. If a request has an **invalid** token, it is rejected with 401.

The rationale is separation of concerns: authentication (is this token valid?) is separate from authorization (is this caller allowed?). To require a token, pair `RequestAuthentication` with an `AuthorizationPolicy`:

```yaml
# 1. Validate tokens if present
apiVersion: security.istio.io/v1
kind: RequestAuthentication
metadata:
  name: require-jwt
spec:
  jwtRules:
  - issuer: "https://auth.example.com"
    jwksUri: "https://auth.example.com/.well-known/jwks.json"

---
# 2. Require a valid principal (which only exists if a valid JWT was provided)
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: require-auth
spec:
  action: ALLOW
  rules:
  - from:
    - source:
        requestPrincipals: ["*"]   # at least one principal must exist
```

Without the AuthorizationPolicy, unauthenticated (no-token) requests pass through freely.

---

### Q: What is ext_authz? When would you use it over AuthorizationPolicy?

**A:** `ext_authz` (external authorization) delegates the authorization decision to an external service via gRPC or HTTP. Envoy sends request metadata (headers, path, source identity) to the external service and waits for an allow/deny response.

Use ext_authz when:
- Authorization logic requires database lookups, external API calls, or complex policy evaluation (e.g., OPA Rego policies)
- You need to implement multi-tenant authorization where policies vary per tenant
- You need to add custom response headers or transform the request based on authorization decisions
- Static RBAC rules in AuthorizationPolicy are insufficient

In Istio, ext_authz is triggered via `AuthorizationPolicy` with `action: CUSTOM`. The external service is registered as an `extensionProvider` in MeshConfig. The ext_authz filter executes **before** the RBAC filter in the Envoy chain, so CUSTOM decisions take priority over DENY and ALLOW policies.
