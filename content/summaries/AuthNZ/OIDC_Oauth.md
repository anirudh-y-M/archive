---
title: "Summary: SSO, SAML, OAuth 2.0, OIDC, JWT & Workload Identity Federation"
---

> **Full notes:** [[notes/AuthNZ/OIDC_Oauth|SSO, SAML, OAuth 2.0, OIDC, JWT & Workload Identity Federation -->]]

## Key Concepts

### Single Sign-On (SSO)

SSO is the user experience of signing in once and accessing multiple applications without re-authenticating. It is not a protocol itself -- it is implemented via federation protocols (SAML or OIDC). It requires an Identity Provider (IdP) that authenticates users, multiple applications that trust the IdP, and a federation protocol to communicate authentication state between them.

### SAML (Security Assertion Markup Language)

SAML is an XML-based federation protocol designed for browser-based enterprise SSO. It predates OAuth/OIDC and remains dominant in enterprise SaaS (Salesforce, Workday, ServiceNow). The two roles are **Identity Provider (IdP)** (e.g., Okta, Azure AD) and **Service Provider (SP)** (the application).

**SP-Initiated Flow:** User visits the SP, SP redirects to IdP with a `SAMLRequest`, user authenticates (password/MFA), IdP generates a signed XML `Assertion` containing the user's `NameID`, conditions (time validity, audience), `AuthnStatement`, and optional `AttributeStatement`. The IdP returns the `SAMLResponse` via auto-submitting HTML form to the SP's Assertion Consumer Service (ACS) URL. The SP validates the XML signature, checks conditions, and creates a session.

**Gotchas:** Clock skew between IdP/SP causes `NotBefore`/`NotOnOrAfter` failures. IdP signing certificates expire and SP must be updated before rotation. SPs should track assertion IDs to prevent replay attacks. XML signature wrapping attacks can modify XML structure while keeping the signature valid over the original subtree.

### JWT (JSON Web Token)

JWT (RFC 7519) is three Base64url-encoded segments separated by dots: `Header.Payload.Signature`. The header contains the algorithm (`RS256`) and optional `kid` (Key ID) for selecting the correct public key from the JWKS endpoint. The payload contains claims (`iss`, `sub`, `aud`, `exp`, `iat`, etc.). The signature is a cryptographic proof of integrity -- for RS256, the IdP signs with its private key and anyone can verify with the public key.

The payload is **encoded, not encrypted** -- anyone holding the token can read all claims. Never store secrets in JWT payloads. Decode with: `echo $TOKEN | cut -d'.' -f2 | base64 --decode | jq`.

### OAuth 2.0

OAuth 2.0 (RFC 6749) is an **authorization** framework for delegated access. It answers: "can this client access this resource on behalf of this user?" The four roles are Resource Owner (user), Client (application), Authorization Server (issues tokens), and Resource Server (API).

```
Resource Owner --authorizes--> Client --access token--> Resource Server
                               ^
                               | issues tokens
                        Authorization Server
```

**Authorization Code Flow with PKCE (RFC 7636):** The client generates a random `code_verifier`, derives `code_challenge = SHA256(code_verifier)`, redirects the user to `/authorize` with the challenge, receives an auth code after user consent, and exchanges the code + verifier at `/token`. The server validates `SHA256(code_verifier) == code_challenge`. PKCE was originally for public clients (mobile/SPA) but is now recommended for all clients per OAuth 2.1.

**Token types:** Access tokens (opaque or JWT, short-lived, sent to APIs) and refresh tokens (opaque, long-lived, used to obtain new access tokens). OAuth does **not** standardize identity -- an access token says "this client may access these resources" but does not reliably tell you who the user is.

### OIDC (OpenID Connect)

OIDC (OpenID Connect Core 1.0) is an **authentication** layer built on top of OAuth 2.0. It answers: "who is the user that just authenticated?" It adds an ID Token (always a JWT), standardized identity claims, discovery endpoints, JWKS for signature verification, a UserInfo endpoint, and nonce-based replay protection.

**Activating OIDC:** The presence of `scope=openid` in the authorization request triggers OIDC mode. Without it, the server performs a plain OAuth flow with no ID token.

```
scope=openid             --> ID token only
scope=openid profile     --> ID token + name, picture
scope=openid email       --> ID token + email, email_verified
scope=openid profile email --> all of the above
```

**Access Token vs ID Token:**

| Property | Access Token | ID Token |
|----------|-------------|----------|
| Purpose | Authorization (API access) | Authentication (identity proof) |
| Audience | Resource Server (API) | Client Application |
| Format | Opaque or JWT | **Always** JWT |
| Sent to APIs? | Yes | **Never** |
| Used for login? | No | Yes |

The ID token is consumed **only by the client** to establish a session. It must never be sent to a resource server.

**ID Token Validation (OIDC Core 3.1.3.7):** The client must verify the signature against the issuer's JWKS, check `iss` matches expected issuer, check `aud` contains the client's `client_id`, verify `exp` is not past, confirm `iat` is reasonably recent, and validate `nonce` matches what was sent in the authorization request.

**Discovery:** OIDC providers publish configuration at `/.well-known/openid-configuration`, including the issuer, authorization/token/userinfo endpoints, JWKS URI, and supported scopes.

**Why not use OAuth `email` scope for identity?** OAuth scopes are provider-specific -- `scope=email` might return email from "some API" with no standard format. OIDC standardizes this with guaranteed `email` and `email_verified` claims. Additionally, email is not a stable identifier (it changes, may not be unique, may be unverified). Use `sub` as the stable unique ID, or `(iss, sub)` for cross-issuer uniqueness.

### Workload Identity Federation (WIF)

WIF allows external workloads (GitHub Actions, AWS, on-prem services) to authenticate to cloud providers **without long-lived service account keys**. It combines OIDC identity assertion with OAuth 2.0 Token Exchange (RFC 8693).

**The problem:** Before WIF, GitHub Actions stored a GCP service account key as a secret -- long-lived, can leak, hard to rotate. With WIF, the runner mints a short-lived OIDC JWT and exchanges it for a GCP access token via Google STS -- no stored secrets, tokens expire in minutes.

**GitHub Actions to GCP flow:** (1) Runner requests an OIDC token from GitHub's IdP (`token.actions.githubusercontent.com`). (2) Runner sends token exchange request to Google STS with the JWT as `subject_token`. (3) Google validates the JWT (fetches JWKS, checks `iss`/`aud`/`exp`). (4) Google maps JWT claims to attributes via configured mapping. (5) Google constructs a federated principal and evaluates IAM bindings. (6) If authorized, Google issues a short-lived access token.

**Claim-to-Attribute Mapping:** OIDC claims are mapped to Google attributes (`google.subject = assertion.sub`, `attribute.repository = assertion.repository`), which form a federated principal (`principal://iam.googleapis.com/projects/.../subject/repo:myorg/myrepo:ref:refs/heads/main`), which is evaluated against IAM policy bindings.

**Granular access control:**
- `principalSet://` -- matches a **group** of identities by attribute (e.g., all workflows from a repo, any branch)
- `principal://` -- matches a **single specific identity** by `sub` (e.g., specific repo + branch only)
- IAM conditions can add further restrictions (e.g., `attribute.ref == "refs/heads/main"`)

**Service Account Impersonation:** A common pattern where the federated identity gets `roles/iam.workloadIdentityUser` on a specific SA, exchanges for a short-lived SA token, and uses that for API calls. This adds an indirection layer -- SA permissions are managed independently of federation config.

**Why WIF is secure:** No long-lived secrets, audience restriction prevents cross-service replay, signature verified via JWKS (only configured issuers trusted), fine-grained IAM bindings, and federation must be explicitly configured (pool + provider + IAM binding).

## Quick Reference

**SAML vs OIDC:**

| Criterion | SAML | OIDC |
|-----------|------|------|
| Format | XML | JSON/JWT |
| Transport | Browser POST/Redirect | Browser Redirect + back-channel |
| Best for | Enterprise browser SSO | Modern apps, SPAs, mobile, APIs |
| API access | Not designed for it | Access tokens for APIs |
| Complexity | Higher (XML, certs, metadata) | Lower (JSON, JWKS) |

**OAuth vs OIDC:**

| | OAuth 2.0 | OIDC |
|---|-----------|------|
| Purpose | Authorization | Authentication |
| Core question | "Can this client access this resource?" | "Who is the user?" |
| Key token | Access Token | ID Token (JWT) |
| Trigger | Any scope except `openid` alone | `scope=openid` |

**WIF flow (GitHub Actions --> GCP):**

```
Runner --> mint OIDC JWT --> POST to Google STS
  --> Google verifies JWT (JWKS, iss, aud, exp)
  --> maps claims to attributes
  --> constructs federated principal
  --> evaluates IAM bindings
  --> issues short-lived GCP access token
```

**Token audience summary:**

| Token Type | Audience | Purpose |
|------------|----------|---------|
| ID Token | Client | Authentication |
| Access Token | Resource Server | Authorization |
| Federated OIDC Token | STS | Identity assertion for token exchange |

## Key Takeaways

- OIDC is **not** a competitor to OAuth -- it is a layer on top. Every OIDC flow is an OAuth flow with `scope=openid`.
- Use `sub` (not `email`) as the stable user identifier. For cross-issuer uniqueness: `(iss, sub)`.
- The ID token is for the **client only** -- never send it to APIs. The access token goes to APIs.
- PKCE (RFC 7636) prevents auth code interception -- originally for public clients, now recommended for all clients (OAuth 2.1).
- SAML gotchas include clock skew, certificate rotation, replay attacks, and XML signature wrapping attacks.
- JWT payloads are encoded, not encrypted -- anyone with the token can read all claims.
- WIF eliminates long-lived service account keys by exchanging short-lived OIDC tokens for cloud access tokens -- no stored secrets.
- `principalSet://` matches groups (any workflow from a repo), `principal://` matches a single identity (specific repo + branch).
- Service account impersonation adds an indirection layer for managing permissions independently of federation config.
