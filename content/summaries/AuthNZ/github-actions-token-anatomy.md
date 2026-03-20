---
title: "Summary: GitHub Actions Token Anatomy - OAuth vs OIDC & the 401 Trap"
---

> **Full notes:** [[notes/AuthNZ/github-actions-token-anatomy|GitHub Actions Token Anatomy: OAuth vs OIDC & the 401 Trap -->]]

## Key Concepts

**Two token categories:** Opaque tokens (random strings, validation requires calling the issuer) vs Structured tokens / JWTs (self-contained, verifiable offline via signature).

**`GITHUB_TOKEN`** -- An opaque Installation Access Token (`ghs_...`), auto-injected into every workflow. Used to interact with the GitHub API (create PRs, push code). Not issued via an OAuth flow -- it is automatically scoped to the triggering repository.

**OIDC Token** -- A JWT from `https://token.actions.githubusercontent.com`. Used to prove identity to external services (AWS, GCP, Vault). Has **zero permissions** on the GitHub API. Must be explicitly requested with `permissions: id-token: write`.

**The 401 Trap** -- Sending an OIDC JWT to `api.github.com` returns 401. GitHub's API expects opaque tokens with known prefixes (`ghs_`, `ghp_`). It does not attempt JWT verification because the REST API is not an OIDC relying party. The OIDC token asserts identity, not permission.

**The Empty Token Trap** -- Missing `permissions: id-token: write` causes the OIDC token request to silently return an empty string. The downstream request sends `Authorization: Bearer ` (empty) and gets 401.

## Quick Reference

| Token | Type | Prefix | Use For | Don't Use For |
|-------|------|--------|---------|---------------|
| `GITHUB_TOKEN` | Opaque | `ghs_` | GitHub API calls | External cloud auth |
| OIDC Token | JWT | `eyJ...` | Cloud provider auth (AWS/GCP/Vault) | GitHub API calls |

**Token mismatch cheat sheet:**

```
GITHUB_TOKEN  --> api.github.com  --> OK
OIDC JWT      --> api.github.com  --> 401 (wrong token type)
OIDC JWT      --> AWS/GCP/Vault   --> OK  (identity exchange)
```

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
- The most common silent failure: missing `permissions: id-token: write` causes an empty OIDC token, leading to a 401 with no obvious error message.
- `Authorization` and `User-Agent` headers are independent -- switching tokens does not change the User-Agent.
- `GITHUB_TOKEN` is not technically an OAuth token -- it is an Installation Access Token auto-generated for each workflow run.
- You cannot read the contents of a `GITHUB_TOKEN` (opaque), but you can decode an OIDC JWT with `echo $TOKEN | cut -d'.' -f2 | base64 --decode | jq`.
