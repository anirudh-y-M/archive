---
title: SSO, SAML, OAuth 2.0, OIDC, JWT
---

## Q: What is a JWT token?
**A:** A **JWT (JSON Web Token)** is a compact, URL-safe string used to carry **claims** (data) that can be **verified** because it is **digitally signed**.

A JWT typically looks like:
`header.payload.signature`

- **Header:** metadata (e.g., signing algorithm like HS256/RS256)
- **Payload:** claims (e.g., user id, roles, expiry)
- **Signature:** ensures the token hasn’t been modified (integrity)

JWTs are commonly used for:
- **Authentication:** representing a logged-in user
- **Authorization:** carrying permissions/scopes/roles

**Important:** JWT payload is usually **not encrypted**, only encoded. Anyone holding it can decode and read the claims, so don’t store secrets inside it.

---

## Q: What is SSO?
**A:** **SSO (Single Sign-On)** is the user experience where someone signs in once and can access multiple apps without signing in again.

It typically involves:
- an **Identity Provider (IdP)** that authenticates the user
- multiple **apps/services** that trust the IdP

Protocols like **SAML** or **OIDC** are used to implement SSO.

---

## Q: What is SAML?
**A:** **SAML (Security Assertion Markup Language)** is an enterprise-focused standard for **authentication + SSO**. It is XML-based and commonly used for browser SSO into corporate apps.

Key roles:
- **IdP (Identity Provider):** authenticates the user (Okta, Azure AD, etc.)
- **SP (Service Provider):** the application (Salesforce, Workday, etc.)

What is exchanged:
- A **SAML Assertion** (XML) that includes who the user is, when/how they authenticated, and optional attributes (groups, email, etc.)
- Assertions are typically **signed** by the IdP.

Typical flow (SP-initiated):
1. User visits the app (SP)
2. SP redirects the browser to the IdP with a SAML request
3. IdP authenticates the user (password/MFA)
4. IdP posts a signed SAML response back to the SP
5. SP validates and creates a session

Strengths:
- Very common for enterprise SaaS SSO
- Good for browser-based apps

Weaknesses:
- XML complexity
- Less ideal for native/mobile/API patterns
- Setup can be finicky (certs, metadata, clock skew, attributes)

---

## Q: What is OAuth 2.0?
**A:** **OAuth 2.0** is an **authorization** framework for **delegated access**—letting an app access a user’s data in another system without the user sharing their password.

OAuth answers:
> “Can this app access that API, and with what permissions (scopes)?”

Key roles:
- **Resource Owner:** the user
- **Client:** the app requesting access
- **Authorization Server:** issues tokens
- **Resource Server:** hosts the API and protected data

Tokens:
- **Access Token:** sent to APIs to authorize requests (typically short-lived)
- **Refresh Token:** used to obtain new access tokens (longer-lived)

Common flow: **Authorization Code + PKCE**
1. App redirects user to the authorization server
2. User authenticates and consents
3. App receives an authorization code
4. App exchanges code for tokens
5. App calls API using access token

Important:
- OAuth by itself is not a “login protocol”
- OAuth does not standardize how to represent identity across providers

---

## Q: What is OIDC (OpenID Connect)?
**A:** **OIDC (OpenID Connect)** is an **authentication** layer built on top of OAuth 2.0. It standardizes how apps can verify a user’s identity and obtain profile info.

OIDC answers:
> “Who is the user that authenticated?”

Key additions on top of OAuth:
- `scope=openid` to indicate OIDC
- **ID Token (JWT):** a signed proof of authentication
- Standard claims (`sub`, `email`, `name`, etc.)
- Standard discovery endpoint and public signing keys (JWKS)
- Login security concepts like `nonce`

Typical OIDC login flow (Authorization Code + PKCE):
1. App redirects user to OIDC provider with `scope=openid ...`
2. User authenticates
3. App receives authorization code
4. App exchanges code for:
   - **ID Token** (authentication)
   - **Access Token** (API access, optional)
   - **Refresh Token** (optional)
5. App verifies ID token and creates a session

---

## Q: What is the difference between OAuth 2.0 and OIDC?
**A:** They look similar because OIDC is built on OAuth 2.0, but they solve different problems.

- **OAuth 2.0:** authorization  
  “This client has permission to call an API.”
- **OIDC:** authentication + identity  
  “This user authenticated; here’s cryptographic proof and identity claims.”

Main practical difference:
- OAuth’s primary output is an **access token** for APIs.
- OIDC adds an **ID token** that is meant for login and identity verification.

---

## Q: What is an OIDC Provider / IdP?
**A:** An **OIDC Provider (OP)** is the system that authenticates users and issues OIDC tokens.

In enterprise terms it’s commonly called an **IdP (Identity Provider)**.

An OIDC Provider typically:
- authenticates users (password, MFA, passkeys, etc.)
- issues **ID tokens** (and often access/refresh tokens)
- publishes metadata and public keys for verification (discovery + JWKS)

Examples:
- Okta, Azure AD/Entra ID, Google, Auth0, Keycloak, Cognito

Relationship in naming:
- OAuth name: **Authorization Server**
- OIDC name: **OpenID Provider / IdP**
Often the same system, but OIDC adds standardized identity output.

---

## Q: How is OIDC different from asking for email in OAuth 2.0 scopes?
**A:** In pure OAuth 2.0, scopes are just permission strings whose meaning depends on the provider. A scope like `email` is not universally standardized in OAuth-only mode.

OAuth-only:
- `scope=email` generally means “allow access to some API that can return email”
- The provider decides how you fetch it, where it appears, what it’s called, and whether it’s verified
- OAuth does not guarantee a standard identity model

OIDC:
- `scope=openid email profile` means:
  - this is an authentication request
  - you may receive standardized identity claims like `email` and `email_verified`
  - you get an **ID token** designed for login/identity proof
  - you may also use a standard `userinfo` endpoint

---

## Q: Why shouldn’t we rely on email as the user identifier?
**A:** Email is an attribute, not a stable identity key:
- Emails can change
- Emails may not be unique across providers/tenants
- Some providers may not return email for all users
- Some emails may be unverified

Best practice:
- Use OIDC’s `sub` (subject) claim as the stable unique identifier
- Often treat identity as `(iss, sub)` together to avoid collisions across issuers

---

## Q: What are best practices for “login with OIDC”?
**A:** Recommended:
- Use **Authorization Code flow + PKCE**
- Validate the **ID token**:
  - signature (via JWKS)
  - `iss` (issuer)
  - `aud` (your client_id)
  - `exp` (not expired)
  - `nonce` (when used)
- Create your own app session after verification
- Use `sub` as the user key; use `email` for display/contact and check `email_verified` if needed

---

## Q: When should we use SAML vs OIDC vs OAuth?
**A:** Common guidance:
- **SSO login (modern apps):** OIDC
- **Enterprise/legacy browser SSO:** SAML (still very common)
- **Delegated API access (“access my Google Drive”):** OAuth 2.0
- **Login + API access together:** OIDC (gives ID token + access token)
