---
title: "GitHub Actions Token Anatomy: OAuth vs OIDC & the 401 Trap"
---

## Two Categories of Tokens

Tokens fall into two structural categories: **opaque** and **structured**.

**Opaque tokens** are random high-entropy strings. There is no data inside — the issuer's database is the only thing that knows what the token means. Validation requires a "phone home" to the issuer. GitHub tokens (`ghp_` for PATs, `ghs_` for installation tokens) are opaque. Think of them as physical keys — you can't tell what door they open by looking at the metal.

**Structured tokens** are data containers. A JWT (JSON Web Token) is the most common structured format. It's three Base64-encoded segments separated by dots: `Header.Payload.Signature`. Anyone with the token string can decode the payload and read its claims. Validation can happen offline by checking the cryptographic signature against the issuer's public keys.

| Property | Opaque Token | Structured Token (JWT) |
| --- | --- | --- |
| Format | Random string | Base64-encoded JSON, 3 dot-separated parts |
| Readability | None | Decode the payload to see claims |
| Validation | Must call the issuer's API | Can verify offline via signature |
| Size | Small | Large (embedded data) |
| Used for | API authorization | Identity federation / OIDC |

---

## JWT Anatomy

A JWT has three parts:

**Header** — metadata about the token: algorithm (`RS256`) and type (`JWT`).

**Payload (Claims)** — the actual data. In a GitHub Actions OIDC token:

```json
{
  "sub": "repo:octocat/hello-world:ref:refs/heads/main",
  "aud": "https://github.com/octocat",
  "repository": "octocat/hello-world",
  "repository_owner": "octocat",
  "run_id": "123456789",
  "workflow": "My CI Workflow",
  "iss": "https://token.actions.githubusercontent.com",
  "iat": 1709500000,
  "exp": 1709500600
}
```

Standard claims: `iss` (issuer — who created it), `sub` (subject — who it's about), `aud` (audience — who it's for), `exp` (expiration), `iat` (issued at).

**Signature** — cryptographic hash proving the payload hasn't been tampered with.

The payload is **not encrypted**. It's only Base64 encoded. Anyone with the token string can read the repository name, branch, workflow, and other metadata.

To decode a JWT in the terminal:

```bash
echo $ID_TOKEN | cut -d'.' -f2 | base64 --decode | jq
```

---

## `GITHUB_TOKEN` vs OIDC Token

These are the two tokens available in a GitHub Actions workflow. They serve completely different purposes.

### `GITHUB_TOKEN`

An **Installation Access Token** — opaque, OAuth-style. Automatically provided by GitHub in every workflow run. Used to **do things** on GitHub: create PRs, read repos, push code. Sent as:

```http
Authorization: Bearer ghs_aBcDeFgHiJkLmNoP...
```

### OIDC Token

A **JWT** issued by `https://token.actions.githubusercontent.com`. Used to **prove identity** to external services (AWS, GCP, Azure, Vault). Does not grant any permissions to the GitHub API. Requires explicit workflow permission:

```yaml
permissions:
  id-token: write   # required to request the JWT
  contents: read
```

The OIDC token says "I am the runner for the main branch of octocat/hello-world." The `GITHUB_TOKEN` says "I have permission to write to this repository." These are fundamentally different assertions.

---

## The 401 Trap: Context Mismatch

| Token Type | Destination | Result |
| --- | --- | --- |
| `GITHUB_TOKEN` (opaque) | `api.github.com` | Success |
| OIDC JWT (structured) | `api.github.com` | **401 Unauthorized** |
| OIDC JWT (structured) | AWS / GCP / Vault | Success (identity exchange) |

GitHub's API expects an opaque permission token. When it receives a JWT, the string doesn't match any known token prefix (`ghs_`, `ghp_`). The API rejects it immediately — 401.

---

## Token vs User-Agent Independence

The `Authorization` header and `User-Agent` header are completely independent. Switching from OIDC to PAT to `GITHUB_TOKEN` changes the value of `Authorization` but has zero effect on `User-Agent`. If your tool is written in Go, the server sees `Go-http-client/2.0` regardless of which token you use. The token is your ID card; the User-Agent is the vehicle you're driving.

---

## The Empty Token Trap

The most common silent failure in GitHub Actions:

1. Workflow is missing `permissions: id-token: write`.
2. The token request silently returns an empty value.
3. The downstream tool sends an empty `Authorization` header.
4. GitHub returns **401 Unauthorized**.

Debug with:

```bash
echo "Token length: ${#MY_TOKEN}"
```

---

## Fixing the 401

**If calling the GitHub API:** use `GITHUB_TOKEN`, not OIDC.

```yaml
steps:
  - run: ./my-go-tool
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**If calling AWS/GCP/Vault:** use the OIDC token exchange flow.

```yaml
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789:role/my-role
      aws-region: us-east-1
```

Quick troubleshooting:

| Check | Fix |
| --- | --- |
| Permissions | Ensure `id-token: write` is in the workflow |
| Token populated | `echo "Token length: ${#MY_TOKEN}"` |
| Issuer URL | Tool must expect `https://token.actions.githubusercontent.com` |
| Audience | `aud` claim must match what the receiver expects |
| Header format | Must be `Authorization: Bearer <TOKEN>` — not missing "Bearer" |

---

## See also

- [[notes/AuthNZ/OIDC_Oauth|OAuth vs OIDC vs Workload Identity Federation]]
- [GitHub OIDC Documentation](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [JWT.io Debugger](https://jwt.io)
- [GitHub REST API: Authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)

---

## Interview Prep

### Q: What is the structural difference between an opaque token and a JWT?

**A:** An opaque token is a random string with no embedded data — validation requires calling back to the issuer's server. A JWT is a self-contained data structure with three Base64-encoded parts (Header, Payload, Signature) separated by dots. The payload contains claims like `iss`, `sub`, `aud`, `exp`. Validation can happen offline: you fetch the issuer's public keys (via the JWKS endpoint), verify the signature, and check the claims. The tradeoff is that JWTs are larger and their contents are readable by anyone (they're encoded, not encrypted), while opaque tokens reveal nothing to an interceptor without the issuer's database.

### Q: Walk through what happens when a GitHub Actions workflow sends an OIDC JWT to `api.github.com` instead of `GITHUB_TOKEN`.

**A:** The workflow requests an OIDC token from `https://token.actions.githubusercontent.com`. This returns a JWT like `eyJhbGciOiJSUzI1NiIs...`. The Go tool then sends an HTTP request to `api.github.com` with `Authorization: Bearer eyJhbGciOiJSUzI1NiIs...`.

GitHub's API gateway receives the request and inspects the Authorization header. It first checks the token prefix — valid GitHub tokens start with `ghs_` (installation), `ghp_` (PAT), `gho_` (OAuth), or `github_pat_` (fine-grained PAT). The JWT string doesn't match any prefix. The gateway attempts a database lookup — no match. It doesn't attempt JWT verification because the GitHub REST API is not an OIDC relying party — it doesn't trust tokens from its own OIDC provider for API access. The gateway returns `401 Unauthorized`.

The OIDC token was designed for a different audience entirely. Its `aud` claim points to an external service like `https://sts.googleapis.com`. The token asserts identity ("I am the runner for repo X on branch Y"), not permission ("I can write to repo X"). GitHub's API needs the latter.

The fix: use `GITHUB_TOKEN` (an opaque installation token that GitHub's database recognizes) for API calls, and OIDC JWT only for authenticating to external cloud providers via token exchange (e.g., `aws-actions/configure-aws-credentials`).

### Q: Why does the `User-Agent` header not change when you switch authentication tokens?

**A:** `Authorization` and `User-Agent` are independent HTTP headers serving different purposes. `Authorization` carries the credential — it changes when you switch tokens. `User-Agent` identifies the software making the request — it's set by the HTTP client library, not by the authentication mechanism. A Go program using `net/http` sends `Go-http-client/2.0` regardless of whether the Authorization header contains a PAT, a `GITHUB_TOKEN`, or an OIDC JWT. Changing the token is like changing your passport — the car you're driving (User-Agent) stays the same.

### Q: What is the most common cause of a silent 401 in GitHub Actions when OIDC is configured?

**A:** Missing `permissions: id-token: write` in the workflow YAML. Without this permission, the call to the GitHub OIDC provider to mint a JWT silently returns an empty string (no error thrown). The downstream step runs anyway and sends an HTTP request with `Authorization: Bearer ` (empty value). The API returns 401. The failure is silent because most tools don't validate that the token variable is non-empty before using it. The fix is twofold: add the permission, and defensively check `echo "Token length: ${#MY_TOKEN}"` in the workflow.

### Q: Is `GITHUB_TOKEN` an OAuth token or an OIDC token?

**A:** Neither, precisely. It's an **Installation Access Token** — a short-lived, automatically-scoped token that GitHub generates for the GitHub App installation associated with the repository. It behaves like an OAuth 2.0 Bearer token (opaque string, sent in the Authorization header, validated by GitHub's servers), but it's not issued via an OAuth flow (no redirect, no user consent). It's automatically injected into every workflow run with permissions scoped to the triggering repository. The OIDC token is entirely separate — it's a JWT issued by `https://token.actions.githubusercontent.com` and must be explicitly requested with `permissions: id-token: write`.

### Q: Can you read the contents of a `GITHUB_TOKEN`?

**A:** No. It's an opaque token — a random string prefixed with `ghs_`. There are no embedded claims, no payload to decode. To determine what permissions it has, you must call `https://api.github.com` with it and inspect the response headers (`X-OAuth-Scopes`) or make an introspection-style call. In contrast, an OIDC JWT can be decoded by anyone: `echo $TOKEN | cut -d'.' -f2 | base64 --decode | jq` reveals all claims including the repository, branch, actor, and workflow.

## See also

- [[notes/Git/user-agent|GitHub API User-Agent]] — Go-http-client UA string issues with GitHub API calls
- [[notes/Git/git-proactiveauth|Git proactiveAuth]] — avoiding 401s with credential helpers and proactiveAuth config
