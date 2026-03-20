---
title: "Summary: OAuth Implementation in SFD"
---

> **Full notes:** [[notes/AuthNZ/OAUTH_IMPLEMENTATION|OAuth Implementation in SFD - Complete Documentation -->]]

## Key Concepts

### Overview

SFD implements OAuth 2.0 Dynamic Client Registration (DCR) to enable secure authentication for MCP clients like Cursor IDE. It acts as an OAuth **proxy** between MCP clients and GitHub -- clients authenticate users and obtain GitHub access tokens without the real GitHub OAuth App credentials ever being exposed. The implementation follows RFC 7591 (DCR), RFC 6749 (Authorization Code), RFC 7636 (PKCE), and RFC 9728 (Protected Resource Metadata).

### Architecture Components

Four components make up the system:

| Component | File | Role |
|-----------|------|------|
| **OAuth Handler** | `internal/handler/mcp/oauth.go` | All OAuth HTTP endpoints (register, login, callback, token, metadata) |
| **OAuth Store** | `internal/app/sfd/domain/oauth/service.go` | Generates, stores, and validates proxy tokens in Datastore |
| **GitHub Token Interceptor** | `internal/interceptor/mcp.go` | Validates GitHub access tokens on every MCP request |
| **Server Setup** | `cmd/server/server.go` | Wires endpoints and interceptors, configures base URL per environment |

External dependencies: GitHub OAuth API (user authorization + token exchange), Google Cloud Datastore (proxy token storage, kind `MCPOAuthToken`), and GitHub API (per-request token validation).

### Phase 1: Client Registration (DCR)

When a client like Cursor first connects, it `POST`s to `/mcp/oauth/register` with its redirect URIs. The server validates each URI against an allowlist (schemes: `cursor://`, `vscode://`, `vscode-insiders://`, plus localhost variants), generates a 32-byte cryptographically secure random token (base64url-encoded), stores it in Datastore, and returns a `201 Created` with the GitHub OAuth App's `client_id` and the proxy token as `client_secret`. The real GitHub secret is never exposed -- the proxy token limits blast radius if compromised.

### Phase 2: OAuth Discovery

The client fetches two `.well-known` endpoints. `GET /.well-known/oauth-protected-resource` returns the resource URL and authorization server location. `GET /.well-known/oauth-authorization-server` returns all endpoint URLs (`authorization_endpoint`, `token_endpoint`, `registration_endpoint`), supported response types (`code`), grant types (`authorization_code`), and PKCE methods (`S256`). Base URL is environment-dependent: `https://sfd.{env}.citadelapps.com` (prod, dev, laboratory).

### Phase 3: Authorization Request

The client generates PKCE values (`code_verifier`, `code_challenge = SHA256(code_verifier)`), a random `state` for CSRF protection, and redirects the user to `GET /mcp/oauth/login`. The server validates the redirect URI, encodes it into the state parameter as `clientState|redirectURI`, and issues a `302` redirect to GitHub's `/login/oauth/authorize` with the client ID, scopes (`user`, `repo`), PKCE challenge, and combined state. The user sees GitHub's authorization page and clicks "Authorize."

### Phase 4: Authorization Callback

GitHub redirects to `GET /mcp/oauth/callback?code=...&state=...`. The server parses the state (splits on last `|` to extract client state and redirect URI), validates the redirect URI again, and renders an HTML success page with a JavaScript redirect: `window.location.href = "cursor://oauth/callback?code=...&state=..."`. The URL is JSON-encoded before insertion to prevent XSS. The browser executes the redirect, and Cursor's custom URI scheme handler receives the authorization code.

### Phase 5: Token Exchange

The client `POST`s to `/mcp/oauth/token` with the authorization code, proxy token as `client_secret`, and PKCE `code_verifier`. The server validates the proxy token against Datastore -- if invalid, returns `401` with `invalid_client`. If valid, the server uses the **real** GitHub secret (from server config) to call GitHub's token endpoint with the code and verifier. GitHub validates PKCE (`SHA256(code_verifier) == code_challenge`) and returns the access token. The server forwards the GitHub access token to the client. The client stores it locally -- the server never persists GitHub tokens.

### Phase 6: Authenticated MCP Requests

All subsequent `POST /mcp` requests include `Authorization: Bearer <github_access_token>` (or legacy `x-sfd-github-token` header). The `GitHubTokenInterceptor` extracts the token, validates it via GitHub API (`GET /applications/{client_id}/token`), and either passes the request through (adding the token to context) or returns `401` with a `WWW-Authenticate` header pointing to the resource metadata endpoint. GET requests bypass authentication (metadata endpoints are public).

### Security Features

Seven security layers protect the implementation:

1. **Redirect URI Allowlist** -- validated at registration, login, and callback. Only trusted schemes and localhost patterns are accepted.
2. **Proxy Token System** -- each registration gets a unique token stored in Datastore. The real GitHub secret stays server-side. If a proxy token leaks, the attacker can only register more clients.
3. **PKCE (RFC 7636)** -- `S256` method. Challenge sent during authorization, verifier sent during exchange. GitHub performs the actual validation.
4. **CSRF Protection** -- `state` parameter (random 32-byte base64url-encoded) ties the authorization request to the callback. Redirect URI is encoded into the state.
5. **Per-Request Token Validation** -- every MCP request (non-GET) is validated against GitHub's API. Tokens are never blindly trusted.
6. **Secure Token Generation** -- 32 bytes from `crypto/rand`, base64url-encoded.
7. **XSS Protection** -- callback URL is JSON-encoded before insertion into HTML/JavaScript.

### Token Storage

**Proxy tokens (server-side):** Stored in Google Cloud Datastore, kind `MCPOAuthToken`. The token value itself serves as the entity key. No expiration is currently implemented. Datastore enables multi-pod validation.

**GitHub access tokens (client-side):** Stored locally in the client application (e.g., Cursor). The server is stateless -- tokens are never persisted server-side. Token lifetime is determined by GitHub (typically no expiration for OAuth apps).

```go
// Datastore entity structure
type OAuthTokenEntity struct {
    Token string
}
// Key: datastore.NameKey("MCPOAuthToken", token, nil)
```

### API Endpoints

| Endpoint | Method | Purpose | Auth Required |
|----------|--------|---------|---------------|
| `/.well-known/oauth-protected-resource` | GET | Resource metadata (RFC 9728) | No |
| `/.well-known/oauth-authorization-server` | GET | Server metadata (RFC 8414) | No |
| `/mcp/oauth/register` | POST | Dynamic Client Registration (RFC 7591) | No |
| `/mcp/oauth/login` | GET | Start auth flow, redirect to GitHub | No |
| `/mcp/oauth/callback` | GET | GitHub callback, redirect to client | No |
| `/mcp/oauth/token` | POST | Exchange code for access token | Proxy token |
| `/mcp` | POST | MCP endpoint (JSON-RPC 2.0) | Bearer token |

### Code Implementation Details

Key constants: scopes are `user` and `repo`. Allowed redirect schemes are `cursor`, `vscode`, `vscode-insiders`. Server base URL format is `https://sfd.%s.citadelapps.com`. The OAuth handler is initialized with the base URL, MCP endpoint, GitHub App credentials, redirect URL, and a token store backed by Datastore. The `WWW-Authenticate` header format is `Bearer realm="<baseURL>", resource_metadata="<baseURL>/.well-known/oauth-protected-resource"`.

State encoding: `state = clientState + "|" + redirectURI` during login. Decoding uses `strings.LastIndex(state, "|")` to split. Random state is 32 bytes from `crypto/rand`, base64url-encoded.

### Integration with Cursor

On first connection, Cursor discovers OAuth metadata, registers as a client, initiates the OAuth flow, and stores the GitHub token locally. On subsequent requests, Cursor sends the stored token as a Bearer token. If the token expires or is revoked, the server returns `401` with `WWW-Authenticate`, and Cursor re-initiates the flow. All MCP tools (create_repository, delete_repository, create_service, etc.) require authentication.

### Error Handling

| Phase | Error | Response |
|-------|-------|----------|
| Registration | Invalid redirect URI | `400` with `invalid_redirect_uri` |
| Registration | Token gen / Datastore failure | `500` |
| Authorization | Disallowed redirect URI | `400` |
| Token Exchange | Invalid proxy token | `401` with `invalid_client` |
| Token Exchange | Invalid auth code / PKCE fail | `400` with `invalid_grant` |
| MCP Request | Missing token | `401` + `WWW-Authenticate` + JSON-RPC error (-32001) |
| MCP Request | Invalid/expired token | `401` or `422` |

### Configuration Requirements

Environment variables: `GCP_PROJECT_ID`, `ENV` (laboratory/development/production), `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `DATASTORE_DATABASE_ID`. GitHub OAuth App must have its callback URL set to `https://sfd.{env}.citadelapps.com/mcp/oauth/callback` with scopes `user` and `repo`. The app must be an OAuth App, not a GitHub App.

## Quick Reference

```
Client           SFD Server           GitHub
  |                  |                   |
  |  Register (DCR)  |                   |
  |----------------->| gen proxy token   |
  |<-----------------| store in DS       |
  |                  |                   |
  |  Discovery       |                   |
  |  .well-known/*   |                   |
  |<---------------->|                   |
  |                  |                   |
  |  /login + PKCE   |                   |
  |----------------->|  302 --> GitHub   |
  |                  |------------------>|
  |                  |  callback + code  |
  |                  |<------------------|
  |  cursor://code   |                   |
  |  (JS redirect)   |                   |
  |<-----------------|                   |
  |                  |                   |
  |  /token + proxy  |                   |
  |  + code_verifier |  exchange code    |
  |----------------->|  (real secret)    |
  |  access_token    |------------------>|
  |<-----------------|  access_token     |
  |                  |<------------------|
  |                  |                   |
  |  POST /mcp       |  validate token   |
  |  Bearer token    |------------------>|
  |----------------->|  OK               |
  |  MCP response    |<------------------|
  |<-----------------|                   |
```

## Key Takeaways

- The `client_secret` returned during registration is a **proxy token**, not the real GitHub secret -- if it leaks, the blast radius is limited to client registration, not GitHub credential access.
- PKCE is forwarded to GitHub (not validated by SFD) -- GitHub performs the actual `SHA256(code_verifier) == code_challenge` check.
- The state parameter encodes the redirect URI as `clientState|redirectURI` so the server can remember where to send the user after GitHub's callback.
- Redirect URIs are validated **three times**: at registration, login, and callback.
- Every MCP request (except GETs) triggers a live token validation call to `GET /applications/{client_id}/token` on GitHub's API -- tokens are never trusted without verification.
- The server is stateless with respect to GitHub tokens -- only proxy tokens are stored server-side in Datastore.
- Standards: RFC 7591 (DCR), RFC 7636 (PKCE), RFC 6749 (OAuth 2.0), RFC 9728 (Protected Resource Metadata), RFC 8414 (Server Metadata).
