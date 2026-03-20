---
title: "Summary: MCP OAuth 2.1"
---

> **Full notes:** [[notes/AuthNZ/mcp-oauth|MCP OAuth 2.1 -->]]

## Key Concepts

### Overview

OAuth 2.1 flow for MCP (Model Context Protocol) servers where the MCP server acts as an OAuth Authorization Server from the client's perspective but internally delegates actual authentication to GitHub. The flow has four phases: discovery, user authorization, token exchange, and authenticated requests.

### Phase 1: Discovery

The client first tries to initialize by sending `POST /mcp` and receives a `401 Unauthorized` with a `WWW-Authenticate` header pointing to `/.well-known/oauth-protected-resource`. The client follows this chain: fetches resource metadata (learns where to authorize), fetches `/.well-known/oauth-authorization-server` (gets all endpoint URLs including authorization, token, and registration endpoints), then dynamically registers itself via `POST /mcp/oauth/register` (receives a `client_id` and `client_secret`). At this point, the client shows a "Connect" button to the user.

```
POST /mcp --> 401 + WWW-Authenticate
GET /.well-known/oauth-protected-resource --> { resource, authorization_servers }
GET /.well-known/oauth-authorization-server --> { endpoints... }
POST /mcp/oauth/register --> { client_id, client_secret, redirect_uris }
```

### Phase 2: User Authorization

The client opens a browser to `/mcp/oauth/login` with a PKCE `code_challenge`. The MCP server redirects (307) to GitHub's `/login/oauth/authorize` with the client ID. The user sees GitHub's authorization page and approves. GitHub redirects back to the MCP server's callback endpoint (`/mcp/oauth/callback`) with an auth code. The server renders an HTML success page that auto-redirects to the client's custom URI scheme (e.g., `cursor://oauth/callback?code=ABC`). The client's URL scheme handler receives the authorization code.

### Phase 3: Token Exchange

The client sends `POST /mcp/oauth/token` with the authorization code and PKCE `code_verifier`. The MCP server exchanges the code with GitHub for a real access token (`ghu_...`) using GitHub's token endpoint. The GitHub token is passed directly back to the client. Note: in this implementation, the MCP server accepts but does not itself validate the PKCE verifier -- it forwards to GitHub for validation.

### Phase 4: Authenticated Requests

Every subsequent MCP request includes `Authorization: Bearer ghu_...`. The MCP server validates the token with GitHub's API before processing each request. If the token is invalid or expired, the server returns a 401.

### Server Implementation

The server registers HTTP handlers for all six endpoints plus the MCP endpoint itself. The `GitHubTokenInterceptor` serves dual duty: it generates the 401 + `WWW-Authenticate` response during discovery (Phase 1) and validates Bearer tokens on authenticated requests (Phase 4).

```go
// Discovery endpoints
mux.HandleFunc("/.well-known/oauth-protected-resource", ...)
mux.HandleFunc("/.well-known/oauth-authorization-server", ...)
mux.HandleFunc("/mcp/oauth/register", ...)
// Authorization endpoints
mux.HandleFunc("/mcp/oauth/login", ...)
mux.HandleFunc("/mcp/oauth/callback", ...)
mux.HandleFunc("/mcp/oauth/token", ...)
// MCP with auth interceptor
mux.Handle("/mcp", mcpServer.WithInterceptors(handler, interceptor))
```

### DCR Problem

Dynamic Client Registration is the main complexity driver in MCP OAuth. Implementing DCR means building a **full Authorization Server** -- state management, PKCE handling, token exchange, and all associated security concerns. One bug in any of this means credential leakage.

**Three options considered (all problematic):**

| Approach | Problem |
|----------|---------|
| Plaintext client ID/secret in local config | Secrets sitting on developer machines |
| DCR + full AS proxy (for GitHub/Google) | Huge security surface area |
| CIMD + AS proxy | Same AS complexity, different discovery |

**Redirect URI problem:** MCP clients handle callbacks differently. Cursor uses a static app-scheme URI (`cursor://anysphere.cursor-deeplink/mcp/auth`). Claude Code, VS Code, and Codex CLI use `http://localhost:<random-port>/callback` where the port is random (10000-65535). GitHub's OAuth App needs registered callback URLs -- you can't register ~60k port patterns. The MCP server solves this by proxying: GitHub only sees the server's fixed callback URL, and the server redirects to the client's local URI.

**DCR phishing risk:** Anyone can call the DCR endpoint and get tokens. Users can't distinguish between a legitimate MCP auth prompt and an attacker's site using the same OAuth client. Mitigation: allowlist known clients by redirect URI scheme (`cursor://`, `vscode://`, `claude://`). This works for static app-scheme URIs but not for `localhost` random ports where any process could claim the port.

**Spec direction:** DCR has been **dropped from the latest MCP spec** (2025-06-18). The replacement is **CIMD (Client Identity Metadata Documents)** -- clients publish their own identity metadata, closer to an allowlist approach. Adoption is still early as almost no MCP clients support CIMD yet.

### Endpoint Summary

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/oauth-protected-resource` | Resource metadata -- tells client where to authorize |
| `/.well-known/oauth-authorization-server` | Server metadata -- lists all OAuth endpoints |
| `/mcp/oauth/register` | Dynamic client registration |
| `/mcp/oauth/login` | Starts auth flow, redirects to GitHub |
| `/mcp/oauth/callback` | GitHub redirects back here with auth code |
| `/mcp/oauth/token` | Token exchange -- code for access token |
| `/mcp` | The actual MCP endpoint (requires Bearer token) |

## Quick Reference

```
Phase 1 - Discovery:
  POST /mcp --> 401 + WWW-Authenticate
  GET /.well-known/oauth-protected-resource
  GET /.well-known/oauth-authorization-server
  POST /mcp/oauth/register (DCR)

Phase 2 - Authorization:
  GET /mcp/oauth/login?code_challenge=...
    --> 307 to GitHub /login/oauth/authorize
    --> User authorizes on GitHub
    --> GitHub callback to /mcp/oauth/callback?code=ABC
    --> HTML auto-redirect to cursor://...?code=ABC

Phase 3 - Token Exchange:
  POST /mcp/oauth/token (code + code_verifier)
    --> Server exchanges with GitHub (real secret)
    --> Returns { access_token: "ghu_..." }

Phase 4 - Authenticated Use:
  POST /mcp + Authorization: Bearer ghu_...
    --> Server validates token with GitHub API
    --> Processes MCP request
```

**DCR alternatives and their problems:**

| Approach | Problem |
|----------|---------|
| Plaintext client ID/secret in config | Secrets on developer machines |
| DCR + full AS proxy | Massive security surface area |
| CIMD + AS proxy | Same AS complexity, different discovery |

**Client redirect URI types:**

| Client | Redirect URI | Type |
|--------|-------------|------|
| Cursor | `cursor://anysphere.cursor-deeplink/mcp/auth` | Static app-scheme |
| Claude Code / VS Code / Codex CLI | `http://localhost:<random-port>/callback` | Dynamic localhost |

## Key Takeaways

- The MCP server is an OAuth **proxy** -- it looks like an AS to clients but delegates everything to GitHub.
- Discovery starts with a 401 response containing a `WWW-Authenticate` header that points to the resource metadata endpoint -- this bootstraps the entire flow.
- DCR is the hardest part of MCP OAuth -- it forces you to build a full Authorization Server with all the security complexity that entails.
- The redirect URI problem (random localhost ports vs static app-scheme URIs) is why the server must proxy GitHub's OAuth -- GitHub can't register thousands of port patterns.
- DCR has been dropped from the latest MCP spec (2025-06-18) in favor of CIMD (Client Identity Metadata Documents), though adoption is early.
- DCR phishing risk is mitigated by allowlisting known client URI schemes, but this doesn't work for localhost-based clients.
- PKCE code verifier is forwarded to GitHub for validation -- the MCP server itself does not perform the PKCE check in this implementation.
- The `GitHubTokenInterceptor` serves dual duty: generating the initial 401 for discovery and validating Bearer tokens on subsequent requests.
