---
title: "Summary: OAuth Implementation in SFD"
---

> **Full notes:** [[notes/AuthNZ/OAUTH_IMPLEMENTATION|OAuth Implementation in SFD - Complete Documentation -->]]

## Key Concepts

**What it is:** SFD implements an OAuth 2.0 proxy between MCP clients (Cursor, VS Code) and GitHub. The server never exposes real GitHub OAuth credentials to clients -- instead it issues "proxy tokens" during Dynamic Client Registration and uses the real secret internally during token exchange.

**Why it exists:** Multiple MCP clients need GitHub access tokens. Rather than each client storing GitHub app credentials (leak risk), SFD acts as a middleman: clients register dynamically, users authorize via GitHub, and SFD brokers the token exchange.

**Core flow in plain English:**
1. Client registers --> gets a proxy token (not the real GitHub secret)
2. Client discovers OAuth endpoints via `.well-known` URLs
3. Client redirects user to GitHub (via SFD) for authorization
4. GitHub calls back to SFD with an auth code
5. SFD renders a success page that auto-redirects to the client (e.g. `cursor://`)
6. Client exchanges auth code + proxy token for a real GitHub access token
7. Client uses the GitHub token on all subsequent MCP requests

## Quick Reference

```
Client           SFD Server           GitHub
  |                  |                   |
  |  Register (DCR)  |                   |
  |----------------->| gen proxy token   |
  |<-----------------| store in DS       |
  |                  |                   |
  |  /login + PKCE   |                   |
  |----------------->|  302 --> GitHub   |
  |                  |------------------>|
  |                  |  callback + code  |
  |                  |<------------------|
  |  cursor://code   |                   |
  |<-----------------|                   |
  |                  |                   |
  |  /token + proxy  |                   |
  |  + code_verifier |  exchange code    |
  |----------------->|------------------>|
  |  access_token    |  access_token     |
  |<-----------------|<------------------|
  |                  |                   |
  |  POST /mcp       |  validate token   |
  |  Bearer token    |------------------>|
  |----------------->|  OK               |
  |  MCP response    |<------------------|
  |<-----------------|                   |
```

**Key endpoints:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/.well-known/oauth-protected-resource` | GET | Resource metadata (RFC 9728) |
| `/.well-known/oauth-authorization-server` | GET | Server metadata (RFC 8414) |
| `/mcp/oauth/register` | POST | Dynamic Client Registration (RFC 7591) |
| `/mcp/oauth/login` | GET | Start auth flow, redirect to GitHub |
| `/mcp/oauth/callback` | GET | GitHub callback, redirect to client |
| `/mcp/oauth/token` | POST | Exchange code for access token |
| `/mcp` | POST | MCP endpoint (requires Bearer token) |

**Security layers:** Redirect URI allowlist, proxy token system, PKCE (S256), CSRF via state parameter, per-request token validation via GitHub API, XSS protection in callback HTML.

**Token storage:** Proxy tokens in Google Cloud Datastore (`MCPOAuthToken` kind). GitHub access tokens stored client-side only (server is stateless).

## Key Takeaways

- The `client_secret` returned during registration is a **proxy token**, not the real GitHub secret -- if it leaks, the blast radius is limited to client registration, not GitHub credential access.
- PKCE is forwarded to GitHub (not validated by SFD) -- GitHub performs the actual `SHA256(code_verifier) == code_challenge` check.
- The state parameter encodes the redirect URI as `clientState|redirectURI` so the server can remember where to send the user after GitHub's callback.
- Every MCP request (except GETs) triggers a live token validation call to `GET /applications/{client_id}/token` on GitHub's API -- tokens are never trusted without verification.
- Standards: RFC 7591 (DCR), RFC 7636 (PKCE), RFC 6749 (OAuth 2.0), RFC 9728 (Protected Resource Metadata).
