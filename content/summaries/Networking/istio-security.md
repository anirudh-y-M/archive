---
title: "Summary: Istio Security - mTLS, SPIFFE, AuthorizationPolicy, JWT, ext_authz"
---

> **Full notes:** [[notes/Networking/istio-security|Istio Security -->]]

## Key Concepts

- **Automatic mTLS**: Every sidecar gets a short-lived X.509 certificate (default 24h TTL) with a SPIFFE identity: `spiffe://cluster.local/ns/<ns>/sa/<sa>`. pilot-agent generates the key locally, sends CSR to istiod, istiod validates via K8s TokenReview and signs. Certs delivered to Envoy via SDS over Unix domain socket. Private key never leaves the pod.

- **PeerAuthentication**: Controls mTLS mode. STRICT (reject plaintext), PERMISSIVE (accept both -- for migration), DISABLE, UNSET (inherit). Can be mesh-wide, namespace, or workload-scoped with port-level overrides.

- **Security evaluation order**: CUSTOM (ext_authz) -> DENY -> ALLOW. This order is strict and critical.

- **AuthorizationPolicy**: RBAC for the mesh. Match on source identity (SPIFFE), namespace, IP, HTTP method, path, headers, and JWT claims. Deny-by-default pattern: empty `spec: {}` with no rules denies everything.

- **RequestAuthentication**: Validates JWT tokens. Only rejects INVALID tokens -- requests with NO token pass through. Must pair with AuthorizationPolicy requiring `requestPrincipals: ["*"]` to enforce token requirement.

- **ext_authz**: Delegates authorization to an external gRPC/HTTP service (e.g., OPA). For complex logic beyond static RBAC rules. Configured via `action: CUSTOM` in AuthorizationPolicy.

## Quick Reference

```
Security Evaluation Order:
  Request ──> mTLS handshake ──> JWT validation ──> AuthzPolicy
                                  (RequestAuthn)     │
                                                     ├─ CUSTOM (ext_authz) ──deny?──> 403
                                                     ├─ DENY rules ──match?──> 403
                                                     └─ ALLOW rules ──match?──> allow
                                                        (no ALLOW policies = implicit allow)
                                                        (ALLOW exists, no match = 403)
```

| PeerAuth Mode | Behavior |
|---------------|----------|
| STRICT | mTLS only, reject plaintext |
| PERMISSIVE | Accept both (auto-detect) |
| DISABLE | No mTLS |
| UNSET | Inherit from parent scope |

**Certificate flow:** pilot-agent generates key -> CSR to istiod -> istiod validates SA token via TokenReview -> signs cert -> returns via SDS -> auto-rotation before expiry

## Key Takeaways

- RequestAuthentication does NOT reject requests without a JWT -- it only rejects invalid ones. You must add an AuthorizationPolicy with `requestPrincipals: ["*"]` to require authentication.
- AuthorizationPolicy evaluation: CUSTOM -> DENY -> ALLOW. DENY always beats ALLOW. No policies at all = allow everything.
- An empty `spec: {}` AuthorizationPolicy is the standard deny-by-default pattern (ALLOW policy exists with zero matching rules = deny all).
- The private key never leaves the pod -- istiod only sees the CSR. Cert rotation happens automatically via SDS without Envoy restart.
- ext_authz is evaluated BEFORE static RBAC rules -- use it for complex authorization (OPA, database lookups, multi-tenant logic).
