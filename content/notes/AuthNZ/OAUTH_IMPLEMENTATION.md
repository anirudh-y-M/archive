---
title: OAuth Implementation in SFD - Complete Documentation
---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Components](#architecture-components)
3. [OAuth Flow - Step by Step](#oauth-flow---step-by-step)
4. [Security Features](#security-features)
5. [Token Storage](#token-storage)
6. [API Endpoints](#api-endpoints)
7. [Code Implementation Details](#code-implementation-details)
8. [Integration with Cursor](#integration-with-cursor)

---

## Overview

### Q: What is the OAuth implementation in SFD?

**A:** SFD implements OAuth 2.0 Dynamic Client Registration (DCR) protocol to enable secure authentication for MCP (Model Context Protocol) clients like Cursor IDE. It acts as an OAuth proxy between MCP clients and GitHub, allowing clients to authenticate users and obtain GitHub access tokens without exposing the real GitHub OAuth application credentials.

### Q: What protocol standards does it follow?

**A:**

- **OAuth 2.0 Dynamic Client Registration (RFC 7591)** - For client registration
- **OAuth 2.0 Authorization Code Flow (RFC 6749)** - For user authorization
- **PKCE (RFC 7636)** - For enhanced security (Proof Key for Code Exchange)
- **RFC 9728** - For OAuth 2.0 Protected Resource Metadata

### Q: What is the purpose of this OAuth implementation?

**A:** The implementation serves multiple purposes:

1. **Security**: Protects the real GitHub OAuth client secret by using proxy tokens
2. **Multi-client support**: Allows multiple MCP clients (Cursor, VS Code, etc.) to register dynamically
3. **User authentication**: Enables users to authenticate with GitHub and grant permissions
4. **Token management**: Validates and manages GitHub access tokens for MCP requests
5. **Standard compliance**: Follows MCP security best practices for OAuth integration

---

## Architecture Components

### Q: What are the main components of the OAuth implementation?

**A:** The OAuth implementation consists of four main components:

#### 1. OAuth Handler (`internal/handler/mcp/oauth.go`)

- **Purpose**: Handles all OAuth-related HTTP endpoints
- **Key Functions**:
  - `HandleRegister`: Implements OAuth 2.0 Dynamic Client Registration
  - `HandleLogin`: Initiates GitHub OAuth authorization flow
  - `HandleCallback`: Processes GitHub OAuth callback
  - `HandleToken`: Exchanges authorization code for access token
  - `HandleProtectedResourceMetadata`: Returns protected resource metadata
  - `HandleAuthorizationServerMetadata`: Returns OAuth server metadata

#### 2. OAuth Store (`internal/app/sfd/domain/oauth/service.go`)

- **Purpose**: Manages proxy tokens in Google Cloud Datastore
- **Key Functions**:
  - `Gen()`: Generates cryptographically secure random proxy tokens
  - `PutToken()`: Stores proxy tokens in Datastore
  - `Validate()`: Validates proxy tokens against Datastore

#### 3. GitHub Token Interceptor (`internal/interceptor/mcp.go`)

- **Purpose**: Validates GitHub access tokens on incoming MCP requests
- **Key Features**:
  - Supports both `Authorization: Bearer` and `x-sfd-github-token` headers
  - Validates tokens using GitHub API
  - Returns proper WWW-Authenticate headers for unauthenticated requests

#### 4. Server Setup (`cmd/server/server.go`)

- **Purpose**: Wires all OAuth endpoints and interceptors together
- **Configuration**: Sets up OAuth handler with GitHub App credentials and Datastore service

### Q: What external services does the OAuth implementation use?

**A:**

1. **GitHub OAuth API**: For user authorization and token exchange
2. **Google Cloud Datastore**: For storing proxy tokens (kind: `MCPOAuthToken`)
3. **GitHub API**: For validating access tokens on each request

---

## OAuth Flow - Step by Step

### Q: What is the complete OAuth flow from start to finish?

**A:** The OAuth flow consists of 6 phases:

---

### Phase 1: Client Registration (Dynamic Client Registration)

#### Q: How does client registration work?

**A:**

**Step 1.1: Client Registration Request**

- **When**: When Cursor first connects to the SFD MCP server
- **Endpoint**: `POST /mcp/oauth/register`
- **Request Body**:
  ```json
  {
    "redirect_uris": ["cursor://oauth/callback"]
  }
  ```
- **Client**: Cursor IDE

**Step 1.2: Server Processing**

- **Code Location**: `internal/handler/mcp/oauth.go::HandleRegister()`
- **Validation**:
  1. Validates all `redirect_uris` against allowlist:
     - Allowed schemes: `cursor://`, `vscode://`, `vscode-insiders://`
     - Allowed localhost: `http://localhost:*`, `http://127.0.0.1:*`, `http://::1:*`
  2. Rejects disallowed redirect URIs with `400 Bad Request`
- **Token Generation**:
  1. Generates 32-byte cryptographically secure random token
  2. Base64 URL-encodes the token
  3. Stores token in Google Cloud Datastore (kind: `MCPOAuthToken`)
- **Response**: `201 Created`
  ```json
  {
    "client_id": "<GitHub OAuth App Client ID>",
    "client_secret": "<proxy_token>",
    "redirect_uris": ["cursor://oauth/callback"],
    "grant_types": ["authorization_code"]
  }
  ```

**Step 1.3: Security Note**

- The `client_secret` returned is **NOT** the real GitHub OAuth App secret
- It's a proxy token that's unique to this client registration
- The real GitHub secret is never exposed to clients
- This prevents credential leakage if a client is compromised

---

### Phase 2: OAuth Discovery

#### Q: How does OAuth discovery work?

**A:** Cursor needs to discover OAuth endpoints and capabilities.

**Step 2.1: Protected Resource Metadata**

- **Endpoint**: `GET /.well-known/oauth-protected-resource`
- **Code Location**: `internal/handler/mcp/oauth.go::HandleProtectedResourceMetadata()`
- **Response**:
  ```json
  {
    "resource": "https://sfd.{env}.citadelapps.com/mcp",
    "authorization_servers": ["https://sfd.{env}.citadelapps.com"]
  }
  ```
- **Purpose**: Tells the client which resource needs protection and where to find the authorization server

**Step 2.2: Authorization Server Metadata**

- **Endpoint**: `GET /.well-known/oauth-authorization-server`
- **Code Location**: `internal/handler/mcp/oauth.go::HandleAuthorizationServerMetadata()`
- **Response**:
  ```json
  {
    "issuer": "https://sfd.{env}.citadelapps.com",
    "authorization_endpoint": "https://sfd.{env}.citadelapps.com/mcp/oauth/login",
    "token_endpoint": "https://sfd.{env}.citadelapps.com/mcp/oauth/token",
    "registration_endpoint": "https://sfd.{env}.citadelapps.com/mcp/oauth/register",
    "response_types_supported": ["code"],
    "grant_types_supported": ["authorization_code"],
    "code_challenge_methods_supported": ["S256"]
  }
  ```
- **Purpose**: Provides all OAuth endpoints and supported features (including PKCE)

**Step 2.3: Base URL Format**

- **Code Location**: `cmd/server/server.go::serverBaseURL`
- **Format**: `https://sfd.%s.citadelapps.com`
- **Examples**:
  - Production: `https://sfd.prod.citadelapps.com`
  - Development: `https://sfd.dev.citadelapps.com`
  - Laboratory: `https://sfd.laboratory.citadelapps.com`

---

### Phase 3: Authorization Request

#### Q: How does the authorization request work?

**A:**

**Step 3.1: PKCE Preparation (Client-side)**

- **What Cursor does**:
  1. Generates random `code_verifier` (43-128 characters, URL-safe)
  2. Computes `code_challenge = SHA256(code_verifier)` (base64url-encoded)
  3. Generates random `state` parameter for CSRF protection
  4. Prepares redirect URI: `cursor://oauth/callback`

**Step 3.2: Authorization Request**

- **Endpoint**: `GET /mcp/oauth/login`
- **Query Parameters**:
  - `redirect_uri`: `cursor://oauth/callback` (required)
  - `state`: CSRF protection token (optional, server generates if missing)
  - `code_challenge`: SHA256 hash of code_verifier (optional, for PKCE)
  - `code_challenge_method`: `S256` (optional, for PKCE)
- **Code Location**: `internal/handler/mcp/oauth.go::HandleLogin()`

**Step 3.3: Server Processing**

- **Validation**:
  1. Validates `redirect_uri` against allowlist
  2. Rejects if not allowed (returns `400 Bad Request`)
- **State Management**:
  1. Uses provided `state` or generates random 32-byte state
  2. Encodes redirect URI into state: `state = clientState + "|" + redirectURI`
  3. This allows server to remember redirect URI through GitHub redirect
- **PKCE Support**:
  1. Extracts `code_challenge` and `code_challenge_method` from query
  2. Forwards these parameters to GitHub OAuth endpoint
- **GitHub Redirect**:
  1. Builds GitHub authorization URL using `oauth2.Config.AuthCodeURL()`
  2. Includes: `client_id`, `redirect_uri`, `state`, `scope`, `code_challenge`, `code_challenge_method`
  3. Redirects user to: `https://github.com/login/oauth/authorize?...`
  4. Response: `302 Temporary Redirect`

**Step 3.4: User Authorization**

- User is redirected to GitHub
- GitHub shows authorization page requesting:
  - **Scopes**: `user`, `repo` (read user info and repository access)
- User clicks "Authorize" or "Cancel"

---

### Phase 4: Authorization Callback

#### Q: How does the callback handling work?

**A:**

**Step 4.1: GitHub Callback**

- **When**: After user authorizes on GitHub
- **GitHub Redirects To**: `https://sfd.{env}.citadelapps.com/mcp/oauth/callback?code=<auth_code>&state=<state>`
- **Parameters**:
  - `code`: Authorization code (short-lived, typically expires in 10 minutes)
  - `state`: The state parameter sent in Phase 3 (includes client state and redirect URI)

**Step 4.2: Server Processing**

- **Code Location**: `internal/handler/mcp/oauth.go::HandleCallback()`
- **State Parsing**:
  1. Extracts `code` and `state` from query parameters
  2. Parses state: `clientState|redirectURI` (redirect URI is after last `|`)
  3. If no `|` found, treats entire state as `clientState`
  4. Extracts `clientRedirectURI` from state
- **Redirect URI Resolution**:
  1. Uses `clientRedirectURI` from state if present
  2. Falls back to default: `cursor://oauth/callback` (from `pkgoauth.CursorRedirectURL`)
- **Validation**:
  1. Validates redirect URI against allowlist again
  2. Rejects if not allowed (returns `400 Bad Request`)
- **URL Construction**:
  1. Parses redirect URI
  2. Adds query parameters: `code` and `state` (client state only, not the encoded one)
  3. Builds final callback URL: `cursor://oauth/callback?code=<code>&state=<clientState>`

**Step 4.3: Response**

- **Content-Type**: `text/html`
- **Response Body**: HTML page with JavaScript redirect
  ```html
  <!doctype html>
  <meta charset="utf-8" />
  <title>Success: merctl</title>
  <style>
    ...
  </style>
  <body>
    <svg>...</svg>
    <!-- GitHub logo -->
    <div class="box">
      <h1>Successfully authenticated to SFD</h1>
      <p>Returning to Cursor...</p>
    </div>
    <script>
      window.location.href = "cursor://oauth/callback?code=...&state=...";
    </script>
  </body>
  ```
- **Code Location**: `internal/pkg/oauth/types.go::OAuthSuccessPage`
- **Security**: URL is JSON-encoded and sanitized to prevent XSS attacks

**Step 4.4: Client Handling**

- Browser executes JavaScript redirect
- `cursor://` URL scheme is handled by Cursor application
- Cursor receives authorization code and state

---

### Phase 5: Token Exchange

#### Q: How does token exchange work?

**A:**

**Step 5.1: Token Exchange Request**

- **When**: After Cursor receives authorization code
- **Endpoint**: `POST /mcp/oauth/token`
- **Content-Type**: `application/x-www-form-urlencoded`
- **Request Body**:
  ```
  client_id=<GitHub Client ID>
  client_secret=<proxy_token>
  code=<authorization_code>
  code_verifier=<original_code_verifier>
  grant_type=authorization_code
  ```
- **Code Location**: `internal/handler/mcp/oauth.go::HandleToken()`

**Step 5.2: Server Processing**

- **Method Validation**:
  1. Only accepts `POST` requests
  2. Returns `405 Method Not Allowed` for other methods
- **Proxy Token Validation**:
  1. Extracts `client_secret` from form data
  2. Validates proxy token against Datastore:
     - Calls `tokenStore.Validate(clientSecret)`
     - Checks if token exists in `MCPOAuthToken` kind
  3. If invalid: Returns `401 Unauthorized` with error `invalid_client`
  4. **Security**: This ensures only registered clients can exchange tokens
- **PKCE Verification**:
  1. Extracts `code_verifier` from form data if present
  2. Forwards to GitHub during token exchange
  3. GitHub validates: `SHA256(code_verifier) == code_challenge`
- **GitHub Token Exchange**:
  1. Uses real GitHub `client_secret` (from server config, never exposed)
  2. Calls `oauth2.Config.Exchange()` with:
     - Authorization code
     - Code verifier (for PKCE)
  3. GitHub returns access token and optional refresh token

**Step 5.3: Response**

- **Success Response**: `200 OK`
  ```json
  {
    "access_token": "<github_access_token>",
    "token_type": "bearer",
    "scope": "user repo"
  }
  ```
- **Error Responses**:
  - `401 Unauthorized`: Invalid proxy token
    ```json
    {
      "error": "invalid_client",
      "error_description": "invalid or missing client_secret"
    }
    ```
  - `400 Bad Request`: Invalid authorization code or PKCE verification failed
    ```json
    {
      "error": "invalid_grant",
      "error_description": "<error details>"
    }
    ```

**Step 5.4: Client Storage**

- Cursor stores the GitHub access token locally
- Token is used for all subsequent MCP requests
- Token never sent back to SFD server for storage

---

### Phase 6: Using MCP Server (Authenticated Requests)

#### Q: How are authenticated MCP requests handled?

**A:**

**Step 6.1: MCP Request**

- **Endpoint**: `POST /mcp`
- **Content-Type**: `application/json` (JSON-RPC 2.0)
- **Authentication**: One of two methods:
  1. **OAuth Bearer Token** (preferred):
     ```
     Authorization: Bearer <github_access_token>
     ```
  2. **Custom Header** (legacy support):
     ```
     x-sfd-github-token: <github_access_token>
     ```
- **Request Body**: JSON-RPC 2.0 format
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "create_repository",
      "arguments": {...}
    }
  }
  ```

**Step 6.2: Token Interceptor**

- **Code Location**: `internal/interceptor/mcp.go::NewGitHubTokenInterceptor()`
- **Processing**:
  1. **GET Requests**: Bypassed (no authentication required for metadata endpoints)
  2. **Token Extraction**:
     - First tries: `Authorization: Bearer <token>`
     - Falls back to: `x-sfd-github-token` header
  3. **Missing Token**:
     - Returns `401 Unauthorized`
     - Sets `WWW-Authenticate` header:
       ```
       WWW-Authenticate: Bearer realm="https://sfd.{env}.citadelapps.com", resource_metadata="https://sfd.{env}.citadelapps.com/.well-known/oauth-protected-resource"
       ```
     - Returns JSON-RPC error:
       ```json
       {
         "jsonrpc": "2.0",
         "id": <request_id>,
         "error": {
           "code": -32001,
           "message": "Authentication required"
         }
       }
       ```
  4. **Token Validation**:
     - Calls GitHub API: `GET /applications/{client_id}/token`
     - Validates token is valid and not revoked
     - Checks token belongs to the OAuth app
  5. **Validation Errors**:
     - `422 Unprocessable Entity`: Token validation failed or endpoint spammed
     - `401 Unauthorized`: Invalid or expired token
  6. **Success**:
     - Adds token to request context: `domaingithub.NewContextWithToken(ctx, token)`
     - Passes request to MCP handler

**Step 6.3: MCP Handler Processing**

- MCP server processes the request
- Tools can access GitHub token from context
- Workflows execute using the user's GitHub token
- Response returned to client

---

## Security Features

### Q: What security measures are implemented?

**A:** Multiple layers of security:

#### 1. Redirect URI Allowlist

- **Code Location**: `internal/handler/mcp/oauth.go::isAllowedRedirectURI()`
- **Allowed Schemes**:
  ```go
  AllowedRedirectSchemes = []string{
      "cursor",          // Cursor IDE
      "vscode",          // VS Code
      "vscode-insiders", // VS Code Insiders
  }
  ```
- **Allowed Localhost**:
  - `http://localhost:*`
  - `http://127.0.0.1:*`
  - `http://::1:*`
- **Purpose**: Prevents OAuth phishing attacks by only allowing trusted redirect URIs
- **Validation Points**:
  1. During client registration (`HandleRegister`)
  2. During login initiation (`HandleLogin`)
  3. During callback processing (`HandleCallback`)

#### 2. Proxy Token System

- **Purpose**: Protects real GitHub OAuth client secret
- **How it works**:
  1. Each client registration gets unique proxy token
  2. Proxy token stored in Datastore (kind: `MCPOAuthToken`)
  3. Real GitHub secret never exposed to clients
  4. Token exchange validates proxy token before using real secret
- **Code Location**:
  - Generation: `internal/app/sfd/domain/oauth/service.go::Gen()`
  - Storage: `internal/app/sfd/domain/oauth/service.go::PutToken()`
  - Validation: `internal/app/sfd/domain/oauth/service.go::Validate()`
- **Security Benefit**: If proxy token leaks, attacker can only register clients, not access real GitHub credentials

#### 3. PKCE (Proof Key for Code Exchange)

- **Standard**: RFC 7636
- **Purpose**: Prevents authorization code interception attacks
- **How it works**:
  1. Client generates random `code_verifier`
  2. Client computes `code_challenge = SHA256(code_verifier)`
  3. Client sends `code_challenge` to authorization server
  4. Server forwards to GitHub
  5. Client sends `code_verifier` during token exchange
  6. GitHub validates: `SHA256(code_verifier) == code_challenge`
- **Code Location**:
  - Forwarding: `internal/handler/mcp/oauth.go::HandleLogin()` (lines 164-168)
  - Verification: `internal/handler/mcp/oauth.go::HandleToken()` (lines 241-244)
- **Supported Method**: `S256` (SHA256)

#### 4. CSRF Protection

- **Mechanism**: State parameter
- **How it works**:
  1. Client generates random state (or server generates if missing)
  2. State includes redirect URI: `state = clientState + "|" + redirectURI`
  3. State sent to GitHub and returned in callback
  4. Server validates state matches expected value
- **Code Location**: `internal/handler/mcp/oauth.go::HandleLogin()` and `HandleCallback()`
- **Purpose**: Prevents cross-site request forgery attacks

#### 5. Token Validation on Every Request

- **Code Location**: `internal/interceptor/mcp.go::NewGitHubTokenInterceptor()`
- **Validation Method**: GitHub API `GET /applications/{client_id}/token`
- **What it checks**:
  1. Token exists and is valid
  2. Token belongs to the OAuth application
  3. Token hasn't been revoked
- **Frequency**: Every MCP request (except GET requests)
- **Purpose**: Ensures tokens are always valid and haven't been compromised

#### 6. Secure Token Generation

- **Code Location**: `internal/app/sfd/domain/oauth/service.go::Gen()`
- **Method**:
  - 32 bytes of cryptographically secure random data
  - Generated using `crypto/rand`
  - Base64 URL-encoded
- **Purpose**: Ensures proxy tokens are unpredictable and secure

#### 7. XSS Protection in Callback

- **Code Location**: `internal/handler/mcp/oauth.go::HandleCallback()` (lines 213-216)
- **Method**: JSON-encoding URL before inserting into HTML
- **Purpose**: Prevents XSS attacks via malicious redirect URIs

---

## Token Storage

### Q: How are tokens stored?

**A:**

#### Proxy Tokens (Server-side)

- **Storage**: Google Cloud Datastore
- **Kind**: `MCPOAuthToken`
- **Key**: Token value itself (used as entity key)
- **Entity Structure**:
  ```go
  type OAuthTokenEntity struct {
      Token string
  }
  ```
- **Code Location**: `internal/app/sfd/domain/datastore/schema.go`
- **Operations**:
  - **Put**: `internal/app/sfd/domain/datastore/service.go::PutMCPOAuthToken()`
  - **Get**: `internal/app/sfd/domain/datastore/service.go::GetMCPOAuthToken()`
- **Purpose**: Validate client registrations during token exchange
- **Lifetime**: Stored indefinitely (no expiration currently implemented)
- **Multi-pod Support**: Datastore allows multiple server pods to validate tokens

#### GitHub Access Tokens (Client-side)

- **Storage**: Local storage in Cursor application
- **Location**: Not stored on SFD server (stateless)
- **Usage**: Sent with each MCP request
- **Lifetime**: Determined by GitHub (typically no expiration for OAuth apps)
- **Security**: Client's responsibility to secure locally

### Q: What is the Datastore schema for OAuth tokens?

**A:**

```go
// From internal/app/sfd/domain/datastore/schema.go

// OAuthTokenEntity represents the schema of Datastore entity
// for kind: MCPOAuthToken - stores proxy tokens for MCP OAuth clients.
type OAuthTokenEntity struct {
    Token string
}
```

- **Kind Name**: `MCPOAuthToken` (constant: `KindMCPOAuthToken`)
- **Key Format**: `datastore.NameKey(KindMCPOAuthToken, token, nil)`
- **Key Type**: String key (token value itself)

---

## API Endpoints

### Q: What are all the OAuth-related endpoints?

**A:**

#### Discovery Endpoints

##### `GET /.well-known/oauth-protected-resource`

- **Purpose**: Returns protected resource metadata (RFC 9728)
- **Code**: `internal/handler/mcp/oauth.go::HandleProtectedResourceMetadata()`
- **Response**:
  ```json
  {
    "resource": "https://sfd.{env}.citadelapps.com/mcp",
    "authorization_servers": ["https://sfd.{env}.citadelapps.com"]
  }
  ```
- **Authentication**: None required

##### `GET /.well-known/oauth-authorization-server`

- **Purpose**: Returns OAuth authorization server metadata (RFC 8414)
- **Code**: `internal/handler/mcp/oauth.go::HandleAuthorizationServerMetadata()`
- **Response**:
  ```json
  {
    "issuer": "https://sfd.{env}.citadelapps.com",
    "authorization_endpoint": "https://sfd.{env}.citadelapps.com/mcp/oauth/login",
    "token_endpoint": "https://sfd.{env}.citadelapps.com/mcp/oauth/token",
    "registration_endpoint": "https://sfd.{env}.citadelapps.com/mcp/oauth/register",
    "response_types_supported": ["code"],
    "grant_types_supported": ["authorization_code"],
    "code_challenge_methods_supported": ["S256"]
  }
  ```
- **Authentication**: None required

#### Registration Endpoint

##### `POST /mcp/oauth/register`

- **Purpose**: OAuth 2.0 Dynamic Client Registration (RFC 7591)
- **Code**: `internal/handler/mcp/oauth.go::HandleRegister()`
- **Content-Type**: `application/json`
- **Request Body**:
  ```json
  {
    "redirect_uris": ["cursor://oauth/callback"]
  }
  ```
- **Response**: `201 Created`
  ```json
  {
    "client_id": "<GitHub Client ID>",
    "client_secret": "<proxy_token>",
    "redirect_uris": ["cursor://oauth/callback"],
    "grant_types": ["authorization_code"]
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Invalid request body or disallowed redirect URI
    ```json
    {
      "error": "invalid_redirect_uri",
      "error_description": "redirect_uri not allowed"
    }
    ```
  - `500 Internal Server Error`: Token generation or storage failure
- **Authentication**: None required

#### Authorization Endpoints

##### `GET /mcp/oauth/login`

- **Purpose**: Initiates OAuth authorization flow
- **Code**: `internal/handler/mcp/oauth.go::HandleLogin()`
- **Query Parameters**:
  - `redirect_uri` (required): Client redirect URI (must be allowlisted)
  - `state` (optional): CSRF protection token
  - `code_challenge` (optional): PKCE code challenge (base64url-encoded SHA256)
  - `code_challenge_method` (optional): PKCE method (typically `S256`)
- **Response**: `302 Temporary Redirect` to GitHub
- **Error Responses**:
  - `400 Bad Request`: Disallowed redirect URI
- **Authentication**: None required

##### `GET /mcp/oauth/callback`

- **Purpose**: Handles GitHub OAuth callback
- **Code**: `internal/handler/mcp/oauth.go::HandleCallback()`
- **Query Parameters** (from GitHub):
  - `code`: Authorization code
  - `state`: State parameter (includes client state and redirect URI)
- **Response**: `200 OK` with HTML page containing JavaScript redirect
- **Error Responses**:
  - `400 Bad Request`: Invalid redirect URI or malformed state
- **Authentication**: None required

##### `POST /mcp/oauth/token`

- **Purpose**: Exchanges authorization code for access token
- **Code**: `internal/handler/mcp/oauth.go::HandleToken()`
- **Content-Type**: `application/x-www-form-urlencoded`
- **Request Body**:
  ```
  client_id=<GitHub Client ID>
  client_secret=<proxy_token>
  code=<authorization_code>
  code_verifier=<code_verifier>  (optional, for PKCE)
  grant_type=authorization_code
  ```
- **Response**: `200 OK`
  ```json
  {
    "access_token": "<github_access_token>",
    "token_type": "bearer",
    "scope": "user repo"
  }
  ```
- **Error Responses**:
  - `401 Unauthorized`: Invalid proxy token
    ```json
    {
      "error": "invalid_client",
      "error_description": "invalid or missing client_secret"
    }
    ```
  - `400 Bad Request`: Invalid authorization code or PKCE verification failed
    ```json
    {
      "error": "invalid_grant",
      "error_description": "<error details>"
    }
    ```
  - `405 Method Not Allowed`: Non-POST request
- **Authentication**: Requires valid proxy token (not user authentication)

#### MCP Endpoint

##### `POST /mcp`

- **Purpose**: MCP server endpoint (JSON-RPC 2.0)
- **Code**: `internal/app/sfd/application/mcp/service.go`
- **Content-Type**: `application/json`
- **Authentication**: Required (Bearer token or `x-sfd-github-token` header)
- **Request**: JSON-RPC 2.0 format
- **Response**: JSON-RPC 2.0 format
- **Error Responses**:
  - `401 Unauthorized`: Missing or invalid token
    ```json
    {
      "jsonrpc": "2.0",
      "id": <request_id>,
      "error": {
        "code": -32001,
        "message": "Authentication required"
      }
    }
    ```
  - `422 Unprocessable Entity`: Token validation failed
  - `401 Unauthorized`: Invalid or expired token

---

## Code Implementation Details

### Q: What are the key constants and configurations?

**A:**

#### OAuth Scopes

```go
// From internal/handler/mcp/oauth.go
OAuthScopes = []string{"user", "repo"}
```

- **`user`**: Read user profile information
- **`repo`**: Full control of private repositories

#### Allowed Redirect Schemes

```go
// From internal/handler/mcp/oauth.go
AllowedRedirectSchemes = []string{
    "cursor",          // Cursor IDE
    "vscode",          // VS Code
    "vscode-insiders", // VS Code Insiders
}
```

#### Endpoint Constants

```go
// From internal/pkg/oauth/types.go
const (
    OAuthProtectedResourceEndpoint   = "/.well-known/oauth-protected-resource"
    OAuthAuthorizationServerEndpoint = "/.well-known/oauth-authorization-server"
    OAuthRegisterEndpoint            = "/mcp/oauth/register"
    OAuthLoginEndpoint               = "/mcp/oauth/login"
    OAuthCallbackEndpoint            = "/mcp/oauth/callback"
    OAuthTokenEndpoint               = "/mcp/oauth/token"

    CursorRedirectURL = "cursor://oauth/callback"
)
```

#### Server Configuration

```go
// From cmd/server/server.go
const (
    serverBaseURL = "https://sfd.%s.citadelapps.com"
    mcpEndpoint   = "/mcp"
)
```

### Q: How is the OAuth handler initialized?

**A:**

```go
// From cmd/server/server.go (lines 240-247)
oauthHandler := handleroauth.NewOAuthHandler(&handleroauth.Config{
    BaseURL:      baseURL,  // e.g., "https://sfd.dev.citadelapps.com"
    MCPEndpoint:  mcpEndpoint,  // "/mcp"
    ClientID:     app.GitHub.GitHubApp.ClientID,
    ClientSecret: app.GitHub.GitHubApp.ClientSecret,  // Real GitHub secret
    RedirectURL:  baseURL + pkgoauth.OAuthCallbackEndpoint,
    TokenStore:   domainoauth.NewOAuthStore(dsSvc),
})
```

### Q: How are endpoints registered?

**A:**

```go
// From cmd/server/server.go (lines 249-257)

// MCP OAuth metadata endpoints
mux.HandleFunc(pkgoauth.OAuthProtectedResourceEndpoint, oauthHandler.HandleProtectedResourceMetadata)
mux.HandleFunc(pkgoauth.OAuthAuthorizationServerEndpoint, oauthHandler.HandleAuthorizationServerMetadata)
mux.HandleFunc(pkgoauth.OAuthRegisterEndpoint, oauthHandler.HandleRegister)

// MCP User authorization endpoints
mux.HandleFunc(pkgoauth.OAuthLoginEndpoint, oauthHandler.HandleLogin)
mux.HandleFunc(pkgoauth.OAuthCallbackEndpoint, oauthHandler.HandleCallback)
mux.HandleFunc(pkgoauth.OAuthTokenEndpoint, oauthHandler.HandleToken)
```

### Q: How is the MCP endpoint protected?

**A:**

```go
// From cmd/server/server.go (lines 259-266)
mux.Handle(mcpEndpoint, mcpServer.WithInterceptors(
    mcpServer.Handler(),
    interceptor.NewGitHubTokenInterceptor(
        basicAuthClient,  // GitHub client for token validation
        app.GitHub.GitHubApp.ClientID,
        oauthHandler.GetWWWAuthenticateHeader(),  // WWW-Authenticate header value
    ),
))
```

### Q: What is the WWW-Authenticate header format?

**A:**

```go
// From internal/handler/mcp/oauth.go::GetWWWAuthenticateHeader()
func (h *OAuthHandler) GetWWWAuthenticateHeader() string {
    return fmt.Sprintf(
        `Bearer realm="%s", resource_metadata="%s/.well-known/oauth-protected-resource"`,
        h.baseURL,
        h.baseURL,
    )
}
```

- **Example**: `Bearer realm="https://sfd.dev.citadelapps.com", resource_metadata="https://sfd.dev.citadelapps.com/.well-known/oauth-protected-resource"`
- **Purpose**: Tells clients where to find OAuth metadata (RFC 9728)

### Q: How does proxy token validation work?

**A:**

```go
// From internal/handler/mcp/oauth.go::HandleToken() (lines 230-238)
clientSecret := r.FormValue("client_secret")
if clientSecret == "" || !h.tokenStore.Validate(clientSecret) {
    slog.Warn("OAuth: token exchange failed - invalid client_secret token")
    respond(w, http.StatusUnauthorized, map[string]string{
        "error":             "invalid_client",
        "error_description": "invalid or missing client_secret",
    })
    return
}
```

```go
// From internal/app/sfd/domain/oauth/service.go::Validate()
func (s *OAuthStore) Validate(token string) bool {
    e, err := s.dsService.GetMCPOAuthToken(context.Background(), &datastore.OAuthTokenEntity{Token: token})
    if err != nil {
        slog.Error("Failed to validate proxy token from datastore", slog.Any("error", err))
        return false
    }
    return e != nil
}
```

### Q: How does GitHub token validation work?

**A:**

```go
// From internal/interceptor/mcp.go::NewGitHubTokenInterceptor() (lines 53-63)
// Validate oauth token
_, res, err := basicAuthClient.Authorizations.Check(context.Background(), clientID, token)
if err != nil {
    if res != nil && res.StatusCode == http.StatusUnprocessableEntity {
        http.Error(w, "Token validation failed", http.StatusUnprocessableEntity)
    } else {
        w.Header().Set("WWW-Authenticate", wwwAuth)
        http.Error(w, fmt.Sprintf("Invalid token: %v", err), http.StatusUnauthorized)
    }
    return
}
```

### Q: How is state encoding/decoding handled?

**A:**

**Encoding (Login)**:

```go
// From internal/handler/mcp/oauth.go::HandleLogin() (lines 157-159)
if redirectURI != "" {
    state = state + "|" + redirectURI
}
```

**Decoding (Callback)**:

```go
// From internal/handler/mcp/oauth.go::HandleCallback() (lines 179-185)
var clientState, clientRedirectURI string
if idx := strings.LastIndex(state, "|"); idx > 0 {
    clientState = state[:idx]
    clientRedirectURI = state[idx+1:]
} else {
    clientState = state
}
```

### Q: How is random state generated?

**A:**

```go
// From internal/handler/mcp/oauth.go::randState()
func randState() string {
    b := make([]byte, 32)
    rand.Read(b)
    return base64.URLEncoding.EncodeToString(b)
}
```

### Q: How is the OAuth success page generated?

**A:**

```go
// From internal/handler/mcp/oauth.go::HandleCallback() (lines 213-219)
// JSON-encode the URL and sanitize for safe insertion into JavaScript string
jsonURL, _ := json.Marshal(parsedURL.String())
safeURL := string(jsonURL[1 : len(jsonURL)-1])  // Remove quotes

w.Header().Set("Content-Type", "text/html")
w.Write(fmt.Appendf(nil, pkgoauth.OAuthSuccessPage, safeURL))
```

---

## Integration with Cursor

### Q: How does Cursor integrate with this OAuth implementation?

**A:**

#### Initial Setup

1. **MCP Server Configuration**: Cursor is configured to connect to SFD MCP server
   - Server URL: `https://sfd.{env}.citadelapps.com/mcp`
   - Transport: HTTP/2 (h2c)

#### First Connection Flow

1. **Discovery**: Cursor fetches OAuth metadata endpoints
2. **Registration**: Cursor registers as OAuth client
3. **Authorization**: Cursor initiates OAuth flow
4. **Token Storage**: Cursor stores GitHub access token locally

#### Subsequent Requests

1. **Token Retrieval**: Cursor retrieves stored token
2. **Request**: Cursor sends MCP request with `Authorization: Bearer <token>`
3. **Validation**: Server validates token
4. **Processing**: Server processes request and returns response

### Q: What happens if the token expires or is revoked?

**A:**

1. **Token Validation Fails**: GitHub API returns error
2. **Server Response**: Returns `401 Unauthorized` with `WWW-Authenticate` header
3. **Cursor Behavior**: Should re-initiate OAuth flow
4. **User Experience**: User may need to re-authorize on GitHub

### Q: What MCP tools require authentication?

**A:** All MCP tools require GitHub token authentication:

- `create_repository`
- `delete_repository`
- `create_service`
- `update_service_ownership`
- `create_team`
- `delete_team`
- `create_pubsub_grpc_push`
- `create_mirrord_config`
- `merctl_setup`
- `generate_workflow`
- `watch_workflow`

### Q: How does Cursor handle the OAuth callback?

**A:**

1. **URL Scheme**: Cursor registers `cursor://` URL scheme handler
2. **Callback URL**: `cursor://oauth/callback?code=<code>&state=<state>`
3. **Processing**:
   - Cursor extracts `code` and `state`
   - Validates `state` matches expected value
   - Exchanges `code` for access token
   - Stores token securely
   - Continues with MCP operations

---

## Complete Flow Diagram

### Q: What does the complete OAuth flow look like?

**A:**

```
┌─────────┐                                    ┌─────────────┐                                    ┌────────┐
│ Cursor  │                                    │ SFD Server  │                                    │ GitHub │
└────┬────┘                                    └──────┬──────┘                                    └───┬────┘
     │                                                 │                                               │
     │ [1] POST /mcp/oauth/register                  │                                               │
     │────────────────────────────────────────────────>│                                               │
     │     {redirect_uris: ["cursor://oauth/callback"]}│                                               │
     │                                                 │                                               │
     │                                                 │ [Generate proxy token]                       │
     │                                                 │ [Store in Datastore]                         │
     │                                                 │                                               │
     │ [2] Response: {client_id, client_secret (proxy)}│                                               │
     │<────────────────────────────────────────────────│                                               │
     │                                                 │                                               │
     │ [3] GET /.well-known/oauth-authorization-server│                                               │
     │────────────────────────────────────────────────>│                                               │
     │                                                 │                                               │
     │ [4] Response: {endpoints, capabilities}         │                                               │
     │<────────────────────────────────────────────────│                                               │
     │                                                 │                                               │
     │ [5] Generate PKCE: code_verifier, code_challenge │                                               │
     │ [6] Generate state for CSRF protection         │                                               │
     │                                                 │                                               │
     │ [7] GET /mcp/oauth/login?redirect_uri=...&state=│                                               │
     │────────────────────────────────────────────────>│                                               │
     │     &code_challenge=...&code_challenge_method=  │                                               │
     │                                                 │                                               │
     │                                                 │ [Validate redirect_uri]                      │
     │                                                 │ [Encode redirect_uri into state]            │
     │                                                 │                                               │
     │                                                 │ [8] Redirect to GitHub                       │
     │                                                 │──────────────────────────────────────────────>│
     │                                                 │                                               │
     │                                                 │                                               │ [User authorizes]
     │                                                 │                                               │
     │                                                 │ [9] GET /mcp/oauth/callback?code=...&state=  │
     │                                                 │<──────────────────────────────────────────────│
     │                                                 │                                               │
     │                                                 │ [Parse state: clientState|redirectURI]      │
     │                                                 │ [Validate redirect_uri]                      │
     │                                                 │ [Build callback URL]                          │
     │                                                 │                                               │
     │ [10] HTML page with JavaScript redirect         │                                               │
     │<────────────────────────────────────────────────│                                               │
     │                                                 │                                               │
     │ [11] Execute: window.location.href =            │                                               │
     │      'cursor://oauth/callback?code=...&state=...'│                                               │
     │                                                 │                                               │
     │ [12] Handle cursor:// URL scheme                │                                               │
     │                                                 │                                               │
     │ [13] POST /mcp/oauth/token                      │                                               │
     │────────────────────────────────────────────────>│                                               │
     │     client_id=...                               │                                               │
     │     client_secret=<proxy_token>                 │                                               │
     │     code=...                                    │                                               │
     │     code_verifier=...                           │                                               │
     │                                                 │                                               │
     │                                                 │ [Validate proxy token]                      │
     │                                                 │                                               │
     │                                                 │ [14] Exchange code with GitHub              │
     │                                                 │──────────────────────────────────────────────>│
     │                                                 │                                               │
     │                                                 │ [15] Response: {access_token}                │
     │                                                 │<──────────────────────────────────────────────│
     │                                                 │                                               │
     │ [16] Response: {access_token, token_type, scope}│                                               │
     │<────────────────────────────────────────────────│                                               │
     │                                                 │                                               │
     │ [17] Store access_token locally                 │                                               │
     │                                                 │                                               │
     │ [18] POST /mcp                                  │                                               │
     │────────────────────────────────────────────────>│                                               │
     │     Authorization: Bearer <access_token>       │                                               │
     │                                                 │                                               │
     │                                                 │ [Extract token]                              │
     │                                                 │                                               │
     │                                                 │ [19] Validate token with GitHub             │
     │                                                 │──────────────────────────────────────────────>│
     │                                                 │                                               │
     │                                                 │ [20] Response: Token valid                   │
     │                                                 │<──────────────────────────────────────────────│
     │                                                 │                                               │
     │                                                 │ [Process MCP request]                       │
     │                                                 │                                               │
     │ [21] Response: MCP result                      │                                               │
     │<────────────────────────────────────────────────│                                               │
     │                                                 │                                               │
```

---

## Error Handling

### Q: What errors can occur and how are they handled?

**A:**

#### Registration Errors

- **Invalid Redirect URI**: `400 Bad Request` with `invalid_redirect_uri` error
- **Token Generation Failure**: `500 Internal Server Error`
- **Datastore Failure**: `500 Internal Server Error`

#### Authorization Errors

- **Disallowed Redirect URI**: `400 Bad Request`
- **Invalid State**: Handled gracefully (falls back to default redirect URI)

#### Token Exchange Errors

- **Invalid Proxy Token**: `401 Unauthorized` with `invalid_client` error
- **Invalid Authorization Code**: `400 Bad Request` with `invalid_grant` error
- **PKCE Verification Failed**: `400 Bad Request` with `invalid_grant` error
- **GitHub API Error**: `400 Bad Request` with error details

#### MCP Request Errors

- **Missing Token**: `401 Unauthorized` with JSON-RPC error and `WWW-Authenticate` header
- **Invalid Token**: `401 Unauthorized` or `422 Unprocessable Entity`
- **Expired Token**: `401 Unauthorized`

---

## Testing Considerations

### Q: How can this OAuth implementation be tested?

**A:**

#### Unit Tests

- Test token generation and validation
- Test redirect URI validation
- Test state encoding/decoding
- Test error handling

#### Integration Tests

- Test complete OAuth flow with mock GitHub
- Test Datastore token storage
- Test token validation with GitHub API

#### End-to-End Tests

- Test with actual Cursor client
- Test with different environments (dev, prod)
- Test error scenarios (expired tokens, revoked tokens)

---

## Configuration Requirements

### Q: What configuration is needed for OAuth to work?

**A:**

#### Environment Variables

- `GCP_PROJECT_ID`: Google Cloud project ID
- `ENV`: Environment name (laboratory/development/production)
- GitHub OAuth App credentials:
  - `GITHUB_APP_CLIENT_ID`: GitHub OAuth App client ID
  - `GITHUB_APP_CLIENT_SECRET`: GitHub OAuth App client secret
- Datastore configuration:
  - `DATASTORE_DATABASE_ID`: Datastore database ID

#### GitHub OAuth App Setup

- **Authorization callback URL**: `https://sfd.{env}.citadelapps.com/mcp/oauth/callback`
- **Scopes**: `user`, `repo`
- **Application type**: OAuth App (not GitHub App)

#### Datastore Setup

- **Kind**: `MCPOAuthToken`
- **Schema**: `{Token: string}`
- **Key**: Token value itself

---

## Summary

### Q: What are the key takeaways?

**A:**

1. **OAuth 2.0 DCR**: Implements full Dynamic Client Registration protocol
2. **Security**: Multiple layers including proxy tokens, PKCE, CSRF protection, and redirect URI validation
3. **Stateless**: GitHub access tokens stored client-side, not server-side
4. **Multi-client**: Supports multiple MCP clients (Cursor, VS Code, etc.)
5. **Standard Compliant**: Follows RFC 7591, RFC 7636, RFC 6749, and RFC 9728
6. **Production Ready**: Includes error handling, logging, and validation at every step
7. **Scalable**: Uses Datastore for multi-pod token validation support

---

## References

### Code Files

- `internal/handler/mcp/oauth.go`: Main OAuth handler implementation
- `internal/app/sfd/domain/oauth/service.go`: Token store implementation
- `internal/interceptor/mcp.go`: Token validation interceptor
- `internal/pkg/oauth/types.go`: OAuth constants and types
- `internal/app/sfd/domain/datastore/service.go`: Datastore operations
- `internal/app/sfd/domain/datastore/schema.go`: Datastore schema
- `cmd/server/server.go`: Server setup and endpoint registration

### Standards

- [RFC 7591 - OAuth 2.0 Dynamic Client Registration](https://tools.ietf.org/html/rfc7591)
- [RFC 7636 - Proof Key for Code Exchange (PKCE)](https://tools.ietf.org/html/rfc7636)
- [RFC 6749 - OAuth 2.0 Authorization Framework](https://tools.ietf.org/html/rfc6749)
- [RFC 9728 - OAuth 2.0 Protected Resource Metadata](https://tools.ietf.org/html/rfc9728)
- [MCP Security Tutorial](https://modelcontextprotocol.io/docs/tutorials/security/authorization)

---

_Document generated from codebase analysis. Last updated: 2026-02-02_
