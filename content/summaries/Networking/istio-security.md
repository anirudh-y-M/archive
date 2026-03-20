---
title: "Summary: Istio Security - mTLS, SPIFFE, AuthorizationPolicy, JWT, ext_authz"
---

> **Full notes:** [[notes/Networking/istio-security|Istio Security -->]]

## Key Concepts

### mTLS in Istio

Istio provides automatic mutual TLS between all meshed workloads. Every sidecar gets a short-lived X.509 certificate (default 24h TTL) with a SPIFFE identity embedded in the SAN field.

### SPIFFE Identity

Every workload receives a SPIFFE identity based on its K8s service account: `spiffe://<trust-domain>/ns/<namespace>/sa/<service-account>` (e.g., `spiffe://cluster.local/ns/default/sa/reviews`). This is the basis for all identity-based authorization in the mesh.

### Certificate Issuance Flow

Pod starts -> pilot-agent reads projected K8s SA token (`/var/run/secrets/tokens/istio-token`) -> generates private key + CSR locally (CSR includes SPIFFE ID) -> sends CSR + SA token to istiod (gRPC, port 15012) -> istiod validates token via K8s TokenReview API -> signs CSR as CA (short TTL) -> returns signed cert -> pilot-agent serves cert + key to Envoy via SDS over local Unix domain socket -> Envoy uses cert for inbound (server mTLS) and outbound (client mTLS) -> pilot-agent auto-rotates before expiry (SDS hot-swap, no restart). **The private key never leaves the pod** -- istiod only sees the CSR.

### mTLS Handshake Between Services

Envoy A sends TLS ClientHello (ALPN: istio-peer-exchange, h2) -> Envoy B responds with ServerHello + its SPIFFE cert -> Envoy A sends its SPIFFE cert -> both verify: cert signed by mesh CA, SPIFFE identity matches expected SA, cert not expired -> encrypted application data flows.

### PeerAuthentication Policy

Controls mTLS mode at mesh, namespace, or workload scope (with port-level overrides):

| Mode | Behavior |
|------|----------|
| STRICT | Only mTLS accepted, plaintext rejected |
| PERMISSIVE | Accept both mTLS and plaintext (auto-detect). For migration. |
| DISABLE | mTLS disabled. Not recommended. |
| UNSET | Inherit from parent scope (workload -> namespace -> mesh) |

Mesh-wide: PeerAuthentication in `istio-system` namespace. Namespace: in target namespace. Workload: with `selector.matchLabels`. Port-level: via `portLevelMtls` field.

### Security Evaluation Flow

Every inbound request passes through security checks in this strict order:

```
1. mTLS Handshake (PeerAuthentication)
   -> Validate peer cert, extract SPIFFE ID
2. JWT Validation (RequestAuthentication)
   -> Validate token if present, extract claims
   -> Missing token? Allowed (unless AuthzPolicy requires claims)
3. AuthorizationPolicy (RBAC)
   -> CUSTOM (ext_authz) -- deny? -> 403, stop
   -> DENY rules -- any match? -> 403, stop
   -> ALLOW rules -- any match? -> allow
      no ALLOW policies exist? -> implicit allow
      ALLOW exists, no match? -> 403, deny
```

The order CUSTOM -> DENY -> ALLOW is strict and critical. DENY always beats ALLOW. No AuthorizationPolicy at all = implicit allow-all.

### AuthorizationPolicy

RBAC for the mesh. Maps to Envoy's `envoy.filters.http.rbac` and `envoy.filters.network.rbac` filters. Match on source (SPIFFE principals, namespaces, IP blocks), destination (methods, paths, ports), and conditions (`when` rules for headers, JWT claims).

**Deny-by-default pattern**: An empty `spec: {}` with no rules means "ALLOW policy exists with zero matching rules" -- all traffic denied. Then add specific ALLOW policies for permitted traffic.

Examples covered: source-based + path-based rules (allow monitoring namespace to `/metrics`), header-based DENY rules (block requests with specific test header), JWT-claim-based rules (require `role=admin` from JWT claims -- needs corresponding RequestAuthentication).

### RequestAuthentication (JWT Validation)

Configures Envoy's `jwt_authn` filter. Specifies: issuer, JWKS URI, optional audiences, token locations (headers with prefix, query params), and whether to forward token/payload to upstream.

Validation steps: extract token from header/param -> fetch JWKS (cached, refreshed periodically) -> verify signature (RS256, ES256, etc.), expiry, issuer, audience -> valid: extract claims to filter metadata for RBAC -> invalid: 401.

**Key behavior**: If a request has **no JWT token at all**, RequestAuthentication does **NOT reject it**. It only rejects **invalid** tokens. To require a token, pair with an AuthorizationPolicy requiring `requestPrincipals: ["*"]`. This separation is intentional -- authentication (is the token valid?) vs authorization (is this identity allowed?).

Works with any OIDC-compliant provider with a JWKS endpoint: Auth0, Keycloak, Google, Azure AD, Okta.

### External Authorization (ext_authz)

For authorization logic too complex for static RBAC: database lookups, OPA policy evaluation, multi-tenant logic, custom decision services. Envoy's `ext_authz` filter calls an external gRPC or HTTP service with request metadata (source IP, headers, path, method, SNI, peer cert, optionally body). The service returns allow/deny and can add/remove headers.

Configuration: register provider in MeshConfig `extensionProviders` (service address, port, optional body inclusion) -> create AuthorizationPolicy with `action: CUSTOM` and `provider.name` referencing the registered provider. Can scope to specific paths.

The external service must implement `envoy.service.auth.v3.Authorization` gRPC interface or a simple HTTP check endpoint. ext_authz is evaluated **before** DENY and ALLOW policies (CUSTOM -> DENY -> ALLOW order).

## Quick Reference

```
Security Evaluation Order:
  Request --> mTLS handshake --> JWT validation --> AuthzPolicy
                                 (RequestAuthn)     |
                                                    +-- CUSTOM (ext_authz) --deny?--> 403
                                                    +-- DENY rules --match?--> 403
                                                    +-- ALLOW rules --match?--> allow
                                                       (no ALLOW policies = implicit allow)
                                                       (ALLOW exists, no match = 403)

Certificate Flow:
  pilot-agent generates key -> CSR to istiod -> istiod validates SA token
  via TokenReview -> signs cert (24h TTL) -> returns via SDS -> auto-rotation
  (private key never leaves pod)

mTLS Handshake:
  Envoy A --ClientHello--> Envoy B --ServerHello+Cert--> Envoy A --ClientCert-->
  Both verify: CA signature, SPIFFE identity, expiry
```

| PeerAuth Mode | Behavior |
|---------------|----------|
| STRICT | mTLS only, reject plaintext |
| PERMISSIVE | Accept both (auto-detect, for migration) |
| DISABLE | No mTLS (not recommended) |
| UNSET | Inherit from parent scope |

| AuthzPolicy Pattern | Effect |
|--------------------|--------|
| No policies at all | Implicit allow-all |
| Empty `spec: {}` ALLOW | Deny everything (zero matching rules) |
| DENY + ALLOW | DENY takes precedence over ALLOW |
| CUSTOM + DENY + ALLOW | Evaluated in strict order |

## Key Takeaways

- RequestAuthentication does NOT reject requests without a JWT -- it only rejects invalid ones. You must add an AuthorizationPolicy with `requestPrincipals: ["*"]` to require authentication. This two-resource pattern separates authentication from authorization.
- AuthorizationPolicy evaluation is strictly: CUSTOM -> DENY -> ALLOW. DENY always beats ALLOW. No policies at all = allow everything.
- An empty `spec: {}` AuthorizationPolicy is the standard deny-by-default pattern (ALLOW policy exists with zero matching rules = deny all).
- The private key never leaves the pod -- istiod only sees the CSR. Certificate rotation happens automatically via SDS without Envoy restart (default 24h TTL).
- ext_authz is evaluated BEFORE static RBAC rules (CUSTOM action). Use it for complex authorization: OPA policies, database lookups, multi-tenant logic.
- SPIFFE identities are derived from K8s service accounts. All identity-based authorization uses these identities (principals in AuthorizationPolicy).
- PeerAuthentication supports port-level overrides -- you can run STRICT on most ports but PERMISSIVE on a specific port for migration.
- RequestAuthentication works with any OIDC provider that publishes a JWKS endpoint (Auth0, Keycloak, Google, Azure AD, Okta).
