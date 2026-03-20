---
title: "Summary: GitHub Actions Token Anatomy - OAuth vs OIDC & the 401 Trap"
---

> **Full notes:** [[notes/AuthNZ/github-actions-token-anatomy|GitHub Actions Token Anatomy: OAuth vs OIDC & the 401 Trap -->]]

## Key Concepts

### Two Categories of Tokens

Tokens fall into two structural categories. **Opaque tokens** are random high-entropy strings with no embedded data -- validation requires a "phone home" to the issuer's database. GitHub tokens (`ghp_` for PATs, `ghs_` for installation tokens) are opaque. **Structured tokens (JWTs)** are data containers with three Base64-encoded segments (`Header.Payload.Signature`) separated by dots. Anyone can decode the payload and read claims. Validation can happen offline by checking the cryptographic signature against the issuer's public keys (JWKS).

| Property | Opaque Token | Structured Token (JWT) |
|----------|-------------|------------------------|
| Format | Random string | Base64-encoded JSON, 3 dot-separated parts |
| Readability | None | Decode payload to see claims |
| Validation | Must call issuer's API | Can verify offline via signature |
| Size | Small | Large (embedded data) |
| Used for | API authorization | Identity federation / OIDC |

### JWT Anatomy

A JWT has three parts: **Header** (algorithm like `RS256`, type `JWT`), **Payload/Claims** (the actual data -- `iss`, `sub`, `aud`, `exp`, `iat`, plus custom claims like `repository`, `workflow`, `run_id`), and **Signature** (cryptographic proof the payload hasn't been tampered with). The payload is Base64-encoded, **not encrypted** -- anyone with the token string can read the repository name, branch, workflow, and other metadata. Decode with: `echo $ID_TOKEN | cut -d'.' -f2 | base64 --decode | jq`.

### `GITHUB_TOKEN` vs OIDC Token

These are the two tokens available in GitHub Actions workflows, serving completely different purposes.

**`GITHUB_TOKEN`** is an opaque Installation Access Token (`ghs_...`), automatically provided in every workflow run. It is used to **do things** on GitHub: create PRs, read repos, push code. It is sent as `Authorization: Bearer ghs_...`. It is not issued via an OAuth flow -- it is auto-generated and scoped to the triggering repository.

**OIDC Token** is a JWT issued by `https://token.actions.githubusercontent.com`. It is used to **prove identity** to external services (AWS, GCP, Azure, Vault). It grants zero permissions on the GitHub API. It must be explicitly requested with `permissions: id-token: write` in the workflow YAML. The OIDC token asserts identity ("I am the runner for repo X on branch Y"), while `GITHUB_TOKEN` asserts permission ("I can write to repo X").

### The 401 Trap: Context Mismatch

Sending an OIDC JWT to `api.github.com` returns **401 Unauthorized**. GitHub's API expects opaque tokens with known prefixes (`ghs_`, `ghp_`, `gho_`, `github_pat_`). The JWT string matches no prefix, the database lookup fails, and GitHub does not attempt JWT verification because the REST API is not an OIDC relying party. The token's `aud` claim points to an external service like `https://sts.googleapis.com` -- it was never intended for the GitHub API. The fix: use `GITHUB_TOKEN` for GitHub API calls, OIDC JWT only for external cloud provider authentication via token exchange.

| Token Type | Destination | Result |
|------------|-------------|--------|
| `GITHUB_TOKEN` (opaque) | `api.github.com` | Success |
| OIDC JWT (structured) | `api.github.com` | **401 Unauthorized** |
| OIDC JWT (structured) | AWS / GCP / Vault | Success (identity exchange) |

### Token vs User-Agent Independence

`Authorization` and `User-Agent` are completely independent HTTP headers. Switching tokens changes the `Authorization` value but has zero effect on `User-Agent`. A Go program using `net/http` sends `Go-http-client/2.0` regardless of whether it carries a PAT, `GITHUB_TOKEN`, or OIDC JWT. The token is your ID card; the User-Agent is the vehicle you're driving.

### The Empty Token Trap

The most common silent failure in GitHub Actions: (1) Workflow is missing `permissions: id-token: write`. (2) The OIDC token request silently returns an empty string (no error). (3) The downstream tool sends `Authorization: Bearer ` (empty value). (4) The API returns 401. Debug with `echo "Token length: ${#MY_TOKEN}"`. The failure is silent because most tools don't validate that the token variable is non-empty before using it.

### Fixing the 401

For **GitHub API calls**, use `GITHUB_TOKEN`:
```yaml
steps:
  - run: ./my-go-tool
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

For **AWS/GCP/Vault**, use the OIDC token exchange flow (e.g., `aws-actions/configure-aws-credentials`). Ensure `permissions: id-token: write` is set, verify the token is populated, confirm the `aud` claim matches the receiver's expectation, and check the header format includes "Bearer".

## Quick Reference

| Token | Type | Prefix | Use For | Don't Use For |
|-------|------|--------|---------|---------------|
| `GITHUB_TOKEN` | Opaque | `ghs_` | GitHub API calls | External cloud auth |
| OIDC Token | JWT | `eyJ...` | Cloud provider auth (AWS/GCP/Vault) | GitHub API calls |

**Troubleshooting 401s:**

| Check | How |
|-------|-----|
| Token populated? | `echo "Token length: ${#MY_TOKEN}"` |
| Permissions set? | `permissions: id-token: write` in YAML |
| Right token for right destination? | GitHub API = `GITHUB_TOKEN`, Cloud = OIDC |
| Audience correct? | `aud` must match receiver's expectation |
| Header format? | `Authorization: Bearer <TOKEN>` (not missing "Bearer") |

## Key Takeaways

- `GITHUB_TOKEN` and OIDC token serve **completely different purposes** -- one is for GitHub API access (permission), the other is for proving identity to external services.
- The 401 trap happens because GitHub's REST API expects opaque tokens with known prefixes -- it does not attempt JWT verification on OIDC tokens.
- The most common silent failure: missing `permissions: id-token: write` causes an empty OIDC token, leading to a 401 with no obvious error message.
- `Authorization` and `User-Agent` headers are independent -- switching tokens does not change the User-Agent.
- `GITHUB_TOKEN` is not technically an OAuth token -- it is an Installation Access Token auto-generated for each workflow run, scoped to the triggering repository.
- You cannot read the contents of a `GITHUB_TOKEN` (opaque), but you can decode an OIDC JWT with `echo $TOKEN | cut -d'.' -f2 | base64 --decode | jq`.
- An OIDC token asserts **identity** ("I am the runner for repo X on branch Y"), not **permission** ("I can write to repo X").
