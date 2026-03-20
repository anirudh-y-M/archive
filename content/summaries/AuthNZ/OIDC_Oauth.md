---
title: "Summary: SSO, SAML, OAuth 2.0, OIDC, JWT & Workload Identity Federation"
---

> **Full notes:** [[notes/AuthNZ/OIDC_Oauth|SSO, SAML, OAuth 2.0, OIDC, JWT & Workload Identity Federation -->]]

## Key Concepts

**SSO** -- Sign in once, access many apps. Implemented via federation protocols (SAML or OIDC). Requires an Identity Provider (IdP) and trusting applications.

**SAML** -- XML-based enterprise SSO protocol. IdP signs an XML `<Assertion>` containing user identity, conditions, and attributes. SP validates the signature and creates a session. Gotchas: clock skew, certificate rotation, XML signature wrapping attacks.

**JWT** -- Three Base64url-encoded segments: `Header.Payload.Signature`. Payload is encoded, **not encrypted** -- anyone can read it. Signature verified via issuer's JWKS public keys. The `kid` in the header selects the right key.

**OAuth 2.0** -- Authorization framework for delegated access. Answers: "can this client access this resource on behalf of this user?" Issues access tokens (opaque or JWT) and refresh tokens. Does **not** standardize identity.

**OIDC** -- Authentication layer on top of OAuth. Answers: "who is the user?" Triggered by `scope=openid`. Adds an ID Token (always JWT), standardized claims, discovery, and UserInfo endpoint.

**Workload Identity Federation (WIF)** -- Lets external workloads (GitHub Actions, AWS) authenticate to cloud providers without long-lived keys. External OIDC token is exchanged for a short-lived cloud access token via STS.

## Quick Reference

**OAuth vs OIDC at a glance:**

| | OAuth 2.0 | OIDC |
|---|-----------|------|
| Purpose | Authorization | Authentication |
| Core question | "Can this client access this resource?" | "Who is the user?" |
| Key token | Access Token | ID Token (JWT) |
| Trigger | Any scope except `openid` alone | `scope=openid` |

**Access Token vs ID Token:**

| | Access Token | ID Token |
|---|-------------|----------|
| Audience | Resource Server (API) | Client app |
| Format | Opaque or JWT | Always JWT |
| Sent to APIs? | Yes | **Never** |
| Used for login? | No | Yes |

**SAML vs OIDC:**

| | SAML | OIDC |
|---|------|------|
| Format | XML | JSON/JWT |
| Best for | Enterprise browser SSO | Modern apps, SPAs, mobile |
| API access | Not designed for it | Access tokens for APIs |

**WIF flow (GitHub Actions --> GCP):**

```
Runner --> mint OIDC JWT --> POST to Google STS
  --> Google verifies JWT (JWKS, iss, aud, exp)
  --> maps claims to attributes
  --> evaluates IAM bindings
  --> issues short-lived GCP access token
```

**WIF IAM binding types:**
- `principalSet://` -- matches a **group** (e.g., all workflows from a repo)
- `principal://` -- matches a **single identity** (e.g., specific repo + branch)

## Key Takeaways

- OIDC is **not** a competitor to OAuth -- it is a layer on top. Every OIDC flow is an OAuth flow with `scope=openid`.
- Use `sub` (not `email`) as the stable user identifier. For cross-issuer uniqueness: `(iss, sub)`.
- The ID token is for the **client only** -- never send it to APIs. The access token goes to APIs.
- PKCE (RFC 7636) prevents auth code interception. Originally for public clients, now recommended for all clients (OAuth 2.1).
- WIF eliminates long-lived service account keys by exchanging short-lived OIDC tokens for cloud access tokens -- no stored secrets.
