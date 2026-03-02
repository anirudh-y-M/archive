---
title: MCP OAuth 2.1
---

How OAuth 2.1 works in the context of MCP (Model Context Protocol) servers — specifically the flow where a client like Cursor authenticates with an MCP server that delegates auth to GitHub.

## Overview

The MCP OAuth flow has four phases: discovery, user authorization, token exchange, and authenticated requests. The MCP server acts as an OAuth authorization server from the client's perspective, but internally delegates to GitHub as the actual identity provider.

## Phase 1: Discovery

The client discovers the server's OAuth configuration through well-known endpoints.

```
Client                          MCP Server
  │                                │
  │  POST /mcp (initialize)        │
  │──────────────────────────────►│
  │                                │
  │  401 Unauthorized              │
  │  WWW-Authenticate:             │
  │    resource_metadata=          │
  │    ".../.well-known/           │
  │     oauth-protected-resource"  │
  │◄──────────────────────────────│
  │                                │
  │  GET /.well-known/             │
  │    oauth-protected-resource    │
  │──────────────────────────────►│
  │                                │
  │  { "resource": "/mcp",         │
  │    "authorization_servers":    │
  │    [...] }                     │
  │◄──────────────────────────────│
  │                                │
  │  GET /.well-known/             │
  │    oauth-authorization-server  │
  │──────────────────────────────►│
  │                                │
  │  { "authorization_endpoint",   │
  │    "token_endpoint",           │
  │    "registration_endpoint" }   │
  │◄──────────────────────────────│
  │                                │
  │  POST /mcp/oauth/register      │
  │──────────────────────────────►│
  │                                │
  │  { "client_id",                │
  │    "client_secret",            │
  │    "redirect_uris" }           │
  │◄──────────────────────────────│
  │                                │
  │  [Shows "Connect" button]      │
```

1. Client tries to initialize — gets a `401` with a pointer to the resource metadata endpoint.
2. Client fetches `/.well-known/oauth-protected-resource` to learn where to authorize.
3. Client fetches `/.well-known/oauth-authorization-server` to get endpoint URLs.
4. Client dynamically registers itself via the registration endpoint.

## Phase 2: User Authorization

The client opens a browser for the user to authorize via GitHub.

```
Client          Browser           MCP Server          GitHub
  │                │                  │                  │
  │  Open browser  │                  │                  │
  │  /mcp/oauth/   │                  │                  │
  │  login?code_   │                  │                  │
  │  challenge=... │                  │                  │
  │──────────────►│                  │                  │
  │                │                  │                  │
  │                │  GET /mcp/oauth/ │                  │
  │                │  login?code_     │                  │
  │                │  challenge=...   │                  │
  │                │────────────────►│                  │
  │                │                  │                  │
  │                │  307 → GitHub    │                  │
  │                │◄────────────────│                  │
  │                │                  │                  │
  │                │  GET /login/oauth/authorize         │
  │                │  ?client_id=...                     │
  │                │────────────────────────────────────►│
  │                │                  │                  │
  │                │        [User authorizes app]        │
  │                │                  │                  │
  │                │  302 redirect with auth code        │
  │                │◄────────────────────────────────────│
  │                │                  │                  │
  │                │  GET /mcp/oauth/ │                  │
  │                │  callback?       │                  │
  │                │  code=ABC        │                  │
  │                │────────────────►│                  │
  │                │                  │                  │
  │                │  200 Success     │                  │
  │                │  (auto-redirect  │                  │
  │                │   to cursor://   │                  │
  │                │   ?code=ABC)     │                  │
  │                │◄────────────────│                  │
  │                │                  │                  │
  │  cursor://...  │                  │                  │
  │  ?code=ABC     │                  │                  │
  │◄──────────────│                  │                  │
```

1. Client opens the login URL with a PKCE `code_challenge`.
2. MCP server redirects to GitHub's OAuth authorize page.
3. User authorizes the app on GitHub.
4. GitHub redirects back to the MCP server's callback with an auth code.
5. MCP server returns a success page that auto-redirects to the client's custom URI scheme (e.g. `cursor://`).

## Phase 3: Token Exchange

The client exchanges the auth code for an access token.

```
Client                MCP Server              GitHub
  │                      │                      │
  │  POST /mcp/oauth/    │                      │
  │  token               │                      │
  │  code=ABC            │                      │
  │  code_verifier=...   │                      │
  │────────────────────►│                      │
  │                      │                      │
  │                      │  POST /login/oauth/  │
  │                      │  access_token        │
  │                      │  code=ABC            │
  │                      │────────────────────►│
  │                      │                      │
  │                      │  { "access_token":   │
  │                      │    "ghu_..." }       │
  │                      │◄────────────────────│
  │                      │                      │
  │  { "access_token":   │                      │
  │    "ghu_...",         │                      │
  │    "token_type":     │                      │
  │    "bearer" }        │                      │
  │◄────────────────────│                      │
```

The MCP server accepts the PKCE verifier (but doesn't validate it in this implementation) and exchanges the code with GitHub for a real access token. The GitHub token is passed directly back to the client.

## Phase 4: Authenticated Requests

The client uses the token for all subsequent MCP requests.

```
Client                MCP Server              GitHub
  │                      │                      │
  │  POST /mcp           │                      │
  │  (tools/list)        │                      │
  │  Authorization:      │                      │
  │  Bearer ghu_...      │                      │
  │────────────────────►│                      │
  │                      │  Validate token      │
  │                      │────────────────────►│
  │                      │  Token valid         │
  │                      │◄────────────────────│
  │  200 OK (tool list)  │                      │
  │◄────────────────────│                      │
```

Every request includes `Authorization: Bearer ghu_...`. The MCP server validates the token with GitHub before processing.

## Server Implementation

The MCP server registers these HTTP handlers:

```go
// Discovery endpoints
metadataHandler := handlermcp.NewMetadataHandler(baseURL, mcpEndpoint)
mux.HandleFunc(pkgoauth.OAuthProtectedResourceEndpoint, metadataHandler.HandleProtectedResourceMetadata)
mux.HandleFunc(pkgoauth.OAuthAuthorizationServerEndpoint, metadataHandler.HandleAuthorizationServerMetadata)
mux.HandleFunc(pkgoauth.OAuthRegisterEndpoint, oauthHandler.HandleRegister)

// User authorization endpoints
mux.HandleFunc(pkgoauth.OAuthLoginEndpoint, oauthHandler.HandleLogin)
mux.HandleFunc(pkgoauth.OAuthCallbackEndpoint, oauthHandler.HandleCallback)
mux.HandleFunc(pkgoauth.OAuthTokenEndpoint, oauthHandler.HandleToken)

// MCP endpoint with auth interceptor
mux.Handle(mcpEndpoint, mcpServer.WithInterceptors(
    mcpServer.Handler(),
    interceptor.NewGitHubTokenInterceptor(
        basicAuthClient,
        app.GitHub.GitHubApp.ClientID,
        metadataHandler.GetWWWAuthenticateHeader(),
    ),
))
```

The `GitHubTokenInterceptor` handles the 401 response with the `WWW-Authenticate` header (Phase 1) and validates Bearer tokens on subsequent requests (Phase 4).

---

## DCR Problem

Main blocker to implementing the full MCP OAuth spec is **Dynamic Client Registration (DCR)**.

### What DCR actually requires

DCR sounds simple — "hand out a client ID/secret on request." But adopting DCR means implementing a **full Authorization Server**: state management, `code_challenge`/PKCE handling, token exchange, and everything that comes with it. One bug in any of this = massive credential leakage. The core concern is avoiding building an AS from scratch.

### Three options considered (all problematic)

| Approach | Problem |
|----------|---------|
| Plaintext client ID/secret in local config | Secrets sitting on developer machines |
| DCR + full AS proxy (for GitHub/Google/etc.) | Huge security surface area |
| CIMD + AS proxy | Same AS complexity, different discovery |

### Redirect URI problem

MCP clients handle callbacks differently:
- **Cursor** — static app-scheme URI: `cursor://anysphere.cursor-deeplink/mcp/auth`
- **Claude Code, VS Code, Codex CLI** — `http://localhost:<random-port>/callback` where port is random (10000–65535)

GitHub's OAuth App needs registered callback URLs. With `localhost` random ports, you'd need ~60k redirect URI patterns registered — not feasible. If the MCP server proxies for GitHub, GitHub only sees one fixed callback URL (the server's own), and the server redirects to the client's local URI. That solves the GitHub side, but you still need a full AS to make it work.

### DCR phishing risk

A DCR endpoint can be used for phishing — an attacker registers through the same endpoint and gets tokens. Users can't tell the difference between a legit MCP auth prompt and an attacker's site using the same OAuth client.

Mitigation: **allowlist known clients** by redirect URI scheme:

```go
allowedClients := []Client{
    {Name: "Cursor",     RedirectURI: "cursor://oauth/callback",  Scheme: "cursor"},
    {Name: "VS Code",    RedirectURI: "vscode://oauth/callback",  Scheme: "vscode"},
    {Name: "Claude Code", RedirectURI: "claude://oauth/callback",  Scheme: "claude"},
}
```

This works for clients with static app-scheme URIs. But clients using `localhost` random ports can't be allowlisted this way — any process on the machine could claim that port.

### Where the spec is heading

DCR has been **dropped from the latest MCP spec** (2025-06-18). The replacement is **CIMD (Client Identity Metadata Documents)** — clients publish their own identity metadata, closer to the allowlist approach. Almost no MCP clients support CIMD yet though, so adoption is early.

---

## Endpoint Summary

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/oauth-protected-resource` | Resource metadata — tells client where to authorize |
| `/.well-known/oauth-authorization-server` | Server metadata — lists all OAuth endpoints |
| `/mcp/oauth/register` | Dynamic client registration |
| `/mcp/oauth/login` | Starts auth flow, redirects to GitHub |
| `/mcp/oauth/callback` | GitHub redirects back here with auth code |
| `/mcp/oauth/token` | Token exchange — code for access token |
| `/mcp` | The actual MCP endpoint (requires Bearer token) |
