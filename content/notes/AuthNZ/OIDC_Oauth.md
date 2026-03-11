---
title: OAuth vs OIDC vs Workload Identity Federation
---

# 1️⃣ What is the core difference between OAuth 2.0 and OIDC?

### Q: Are OAuth and OIDC competing protocols?

No.

> **OIDC (OpenID Connect) is built on top of OAuth 2.0.**

* **OAuth 2.0 = Authorization framework**
* **OIDC = Authentication layer on top of OAuth**

---

### Q: What does OAuth solve?

OAuth answers:

> “Can this client access this resource?”

It is about delegated authorization.

Example:

> Can Spotify access my Google Drive?

OAuth returns:

* Access Token
* (Optional) Refresh Token

It does **NOT** standardize identity authentication.

---

### Q: What does OIDC solve?

OIDC answers:

> “Who is the user?”

It adds:

* ID Token (JWT)
* Standard identity claims
* Strict validation rules
* Discovery mechanism

Used for:

* Login
* SSO
* Identity verification

---

# 2️⃣ What is the execution difference between OAuth and OIDC?

---

## OAuth Authorization Code Flow

1. User redirected to Authorization Server
2. User authenticates
3. Client receives Authorization Code
4. Client exchanges code for:

   * Access Token
   * (Optional) Refresh Token

Result:

* Client can access APIs
* No standard identity proof

---

## OIDC Authorization Code Flow

Same flow, but returns:

* Access Token
* **ID Token (JWT)**
* (Optional) Refresh Token

The key addition:

> OIDC always returns an ID Token.

---

# 3️⃣ What is the difference between Access Token and ID Token?

| Property            | Access Token    | ID Token           |
| ------------------- | --------------- | ------------------ |
| Purpose             | Authorization   | Authentication     |
| Audience            | Resource Server | Client Application |
| Format              | Opaque or JWT   | Always JWT         |
| Standardized claims | No              | Yes                |
| Meant for login     | No              | Yes                |

---

# 4️⃣ Doesn’t OAuth Access Token also contain claims like `aud` and `exp`?

Yes — **sometimes**.

If the access token is a JWT, it may contain:

```json
{
  "iss": "https://auth.example.com",
  "sub": "user123",
  "aud": "api.example.com",
  "exp": 1700000000,
  "scope": "read write"
}
```

However:

* OAuth does NOT require JWT
* Access tokens may be opaque strings
* Claim structure is not standardized
* Clients should not treat access tokens as identity proof

---

# 5️⃣ Why can’t the client use Access Token for login?

Because:

* Access token audience = Resource Server
* Client is not the intended audience
* Token format not guaranteed
* No standardized validation rules for identity

OIDC solves this by introducing ID Token.

---

# 6️⃣ What must be validated in OIDC?

Client must validate ID Token:

* Signature
* `iss` (issuer)
* `aud` (audience)
* `exp` (expiry)
* `nonce` (anti-replay)

OAuth does not mandate such identity validation.

---

# 7️⃣ What activates OIDC mode?

The `openid` scope.

Example:

```text
scope=openid profile email
```

Without `openid`, it's just OAuth.

---

# 8️⃣ Does Resource Server use ID Token in OIDC?

No.

Correct model:

* **ID Token → Client**
* **Access Token → Resource Server**

Resource server ignores ID token.

---

### Example

Client receives:

* ID Token
* Access Token

Client:

* Validates ID Token
* Extracts user identity
* Creates session

Client calls API:

```http
GET /api/data
Authorization: Bearer ACCESS_TOKEN
```

Resource Server:

* Validates Access Token
* Checks scope
* Returns response

ID Token is never sent to API.

---

# 9️⃣ What is Workload Identity Federation (WIF)?

Example scenario:

GitHub → Google Cloud

Flow:

1. GitHub issues OIDC ID Token
2. Token sent to Google STS
3. Google verifies token
4. Google issues GCP access token

This is:

> OIDC + OAuth 2.0 Token Exchange (RFC 8693)

---

# 🔟 Can we send that OIDC token to another service to get tokens?

Yes — **if that service:**

* Trusts the issuer
* Validates signature
* Validates audience
* Implements token exchange
* Has federation configured

Otherwise, no.

Trust relationship is required.

---

# 11️⃣ Why does Google accept GitHub OIDC tokens?

Because you configure:

* Workload Identity Pool
* OIDC Provider
* Trusted issuer
* Allowed audience
* Attribute mapping
* IAM bindings

Without configuration → token rejected.

---

# 12️⃣ What is inside GitHub OIDC token?

Example:

```json
{
  "iss": "https://token.actions.githubusercontent.com",
  "sub": "repo:myorg/myrepo:ref:refs/heads/main",
  "repository": "myorg/myrepo",
  "repository_owner": "myorg",
  "ref": "refs/heads/main",
  "actor": "john-dev",
  "aud": "https://sts.googleapis.com",
  "exp": 1700000000
}
```

Claims describe:

* Repository
* Branch
* Actor
* Workflow

---

# 13️⃣ How does Google map OIDC claims to IAM permissions?

This is the critical part.

Google does NOT directly convert claims into permissions.

Instead:

```
OIDC Claims
    ↓
Attribute Mapping
    ↓
Federated Principal
    ↓
IAM Policy Binding
    ↓
Access Token Issued
```

---

# 14️⃣ What is Attribute Mapping?

Example configuration:

```text
google.subject = assertion.sub
attribute.repository = assertion.repository
attribute.actor = assertion.actor
```

Mapping table:

| GitHub Claim | Google Attribute     |
| ------------ | -------------------- |
| sub          | google.subject       |
| repository   | attribute.repository |
| actor        | attribute.actor      |

---

# 15️⃣ What is the Federated Principal?

After mapping, Google constructs identity like:

```
principal://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/subject/repo:myorg/myrepo:ref:refs/heads/main
```

IAM understands this as an identity.

---

# 16️⃣ How are permissions assigned?

Example IAM binding:

```yaml
role: roles/storage.admin
members:
  - principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/attribute.repository/myorg/myrepo
```

Meaning:

> Any workflow where repository == myorg/myrepo
> gets storage.admin

More granular:

```yaml
principal://.../subject/repo:myorg/myrepo:ref:refs/heads/main
```

Only main branch allowed.

---

# 17️⃣ Can conditions be applied?

Yes.

Example:

```yaml
condition:
  expression: attribute.ref == "refs/heads/main"
```

This restricts permissions to main branch only.

---

# 18️⃣ How does Google issue final token?

After validation:

* Issuer verified
* Signature verified
* Audience verified
* Claims mapped
* IAM policy checked

If allowed:

Google issues:

* Access token
* Or Service Account impersonation token

---

# 19️⃣ What is Service Account Impersonation?

Instead of granting permissions directly to federated identity:

1. Federated identity allowed to impersonate SA
2. Google issues short-lived SA token
3. SA token used to call GCP APIs

This is more controlled and common.

---

# 20️⃣ Why is this secure?

Because:

* Tokens are short-lived
* Audience restricted
* Issuer validated
* Signature verified via JWKS
* No long-lived keys
* IAM policy enforced

---

# 21️⃣ Why is `aud` critical?

If GitHub token has:

```
aud = https://sts.googleapis.com
```

Only Google STS should accept it.

Another service expecting different audience must reject it.

This prevents replay across services.

---

# 22️⃣ Final Deep Architecture Summary

## OAuth

* Delegated authorization
* Access token for resource server
* No standardized identity proof

## OIDC

* Identity layer over OAuth
* Adds ID Token (JWT)
* Adds standardized claims
* Adds validation rules
* Adds discovery

## Workload Identity Federation

* OIDC identity assertion
* OAuth Token Exchange
* Trust relationship
* Claim-to-attribute mapping
* IAM policy enforcement
* Short-lived credentials

---

# 23️⃣ Core Concept That Ties Everything Together

| Token Type           | Audience        | Purpose                               |
| -------------------- | --------------- | ------------------------------------- |
| ID Token             | Client          | Authentication                        |
| Access Token         | Resource Server | Authorization                         |
| Federated OIDC Token | STS             | Identity assertion for token exchange |

---

If you want next, we can write:

* Full end-to-end GitHub → Google flow diagram
* Backend-only OIDC flow
* Deep dive into Token Exchange RFC 8693
* How replay attacks are prevented in WIF
* Comparison: Google vs AWS federation

Just tell me the direction 🚀
