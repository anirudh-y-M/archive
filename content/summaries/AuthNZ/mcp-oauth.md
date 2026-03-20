---
title: "Summary: MCP OAuth 2.1"
---

> **Full notes:** [[notes/AuthNZ/mcp-oauth|MCP OAuth 2.1 -->]]

## Key Concepts

**What it is:** OAuth 2.1 flow for MCP (Model Context Protocol) servers. The MCP server acts as an OAuth Authorization Server from the client's perspective but delegates actual authentication to GitHub.

**Four phases:**

1. **Discovery** -- Client hits `/mcp`, gets 401 with a pointer to `/.well-known/oauth-protected-resource`. Follows the chain to discover all OAuth endpoints, then dynamically registers itself.
2. **User Authorization** -- Client opens browser to `/mcp/oauth/login` with a PKCE code challenge. MCP server redirects to GitHub. User authorizes. GitHub redirects back to MCP server callback, which renders a success page that auto-redirects to the client's custom URI scheme (`cursor://`, `vscode://`).
3. **Token Exchange** -- Client sends auth code + code verifier to `/mcp/oauth/token`. MCP server exchanges the code with GitHub for a real access token and passes it back.
4. **Authenticated Requests** -- Client sends `Authorization: Bearer ghu_...` on every MCP request. Server validates the token with GitHub before processing.

**DCR Problem** -- Dynamic Client Registration is the main complexity driver. Implementing DCR means building a full Authorization Server (state management, PKCE handling, token exchange). Key issues:
- **Redirect URI problem**: Cursor uses static `cursor://` URIs, but Claude Code/VS Code use `localhost:<random-port>` -- can't pre-register ~60k port patterns with GitHub.
- **Phishing risk**: Anyone can call the DCR endpoint and get tokens. Mitigation: allowlist known client URI schemes.
- **Spec direction**: DCR has been dropped from the latest MCP spec (2025-06-18) in favor of CIMD (Client Identity Metadata Documents).

## Quick Reference

```
Phase 1 - Discovery:
  POST /mcp --> 401 + WWW-Authenticate
  GET /.well-known/oauth-protected-resource
  GET /.well-known/oauth-authorization-server
  POST /mcp/oauth/register (DCR)

Phase 2 - Authorization:
  GET /mcp/oauth/login?code_challenge=...
    --> 307 to GitHub
    --> GitHub callback to /mcp/oauth/callback
    --> HTML auto-redirect to cursor://...?code=ABC

Phase 3 - Token Exchange:
  POST /mcp/oauth/token (code + code_verifier)
    --> Server exchanges with GitHub
    --> Returns { access_token: "ghu_..." }

Phase 4 - Use:
  POST /mcp + Authorization: Bearer ghu_...
    --> Server validates token with GitHub
    --> Processes MCP request
```

**DCR alternatives considered:**

| Approach | Problem |
|----------|---------|
| Plaintext client ID/secret in config | Secrets on developer machines |
| DCR + full AS proxy | Massive security surface area |
| CIMD + AS proxy | Same AS complexity, different discovery |

## Key Takeaways

- The MCP server is an OAuth **proxy** -- it looks like an AS to clients but delegates everything to GitHub.
- Discovery starts with a 401 response containing a `WWW-Authenticate` header that points to the resource metadata endpoint -- this bootstraps the entire flow.
- DCR is the hardest part of MCP OAuth -- it forces you to build a full Authorization Server. The spec is moving away from DCR toward CIMD.
- The redirect URI problem (random localhost ports) is why the server must proxy GitHub's OAuth -- GitHub can't register thousands of port patterns.
- PKCE code verifier is forwarded to GitHub for validation -- the MCP server itself does not perform the PKCE check in this implementation.
