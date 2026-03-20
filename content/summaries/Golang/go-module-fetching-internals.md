---
title: "Summary: Go Module Fetching Internals"
---

> **Full notes:** [[notes/Golang/go-module-fetching-internals|Go Module Fetching Internals →]]

## Key Concepts

### Two-Path Fetching Model

Go has two completely independent network paths for fetching modules. The **proxy path** (default) uses Go's internal `net/http` client to download `.zip`/`.mod` files from `proxy.golang.org` -- the `git` binary is never involved. The **VCS/Git path** is triggered when `GOPROXY=direct`, `GOPRIVATE` matches the module, or the proxy returns 404/410 -- Go shells out to the system `git` binary, which has its own HTTP client, auth, and proxy settings. These two paths have different User-Agents, different auth mechanisms, and different proxy behavior, which is the root cause of most debugging confusion.

### The Discovery Phase

Before Go uses Git to clone anything, it performs a discovery handshake: `GET https://github.com/user/repo?go-get=1`. This is always done by Go's internal `net/http` client (never the `git` binary), and it parses the HTML response for a `<meta name="go-import">` tag that tells Go the VCS type and repo URL. The User-Agent for this request is always `Go-http-client/2.0` and cannot be changed by any configuration.

### Why `git config http.userAgent` Only Partially Works

The `git config http.userAgent` setting only affects requests made by the `git` binary (VCS fetch phase: `git-upload-pack`, `git ls-remote`). It has zero effect on proxy downloads or Discovery requests, since those use Go's internal HTTP client. This creates mixed User-Agents in logs.

| Request Type | HTTP Client | Respects `git config`? |
|---|---|---|
| Proxy download | Go `net/http` | No |
| Discovery (`?go-get=1`) | Go `net/http` | No |
| Private repo fetch | `git` binary | Yes |
| `GOPROXY=off` | `git` binary | Yes |

### GOPRIVATE vs GOPROXY=direct

`GOPRIVATE` only affects matching modules and skips both the proxy and the checksum database (`sum.golang.org`), keeping private module names completely off public infrastructure. `GOPROXY=direct` skips the proxy for ALL modules but still sends module names to `sum.golang.org` for checksum verification -- this leaks private repo names to a public Google-run transparency log. Always use `GOPRIVATE` for private modules, not just `GOPROXY=direct`.

| Setting | Scope | Skips Proxy | Skips Checksum DB |
|---|---|---|---|
| `GOPRIVATE=github.com/*` | Matching only | Yes | Yes |
| `GOPROXY=direct` | All modules | Yes | No (leaks names!) |

### The Unchangeable Discovery Header

There is no environment variable or config to change the `Go-http-client/2.0` User-Agent on Discovery requests. It is compiled into Go's `net/http` default transport. Workarounds: header-rewriting proxy (mitmproxy/Nginx), recompiling Go from source, or pre-populating `GOMODCACHE`. GitHub does NOT block based on this User-Agent, so if you see a 401, the User-Agent is irrelevant -- focus on credentials.

### Authenticating `go get` for Private Repos

Go does not auto-detect `GITHUB_TOKEN`. You must explicitly provide credentials. `.netrc` is the recommended approach because it covers both the Discovery phase (Go's `net/http` reads it) and the Git fetch phase (Git also reads `.netrc`). Alternative: `git config url.insteadOf` with an embedded token (only covers the Git phase). In CI, always write `~/.netrc` with `machine github.com login x-access-token password $TOKEN`.

### Debugging with mitmproxy

Set up mitmproxy on port 8080, install its CA cert (Go is strict about TLS), and set `http_proxy`/`https_proxy`. Public modules show traffic to `proxy.golang.org` with `Go-http-client/2.0`. Private modules show two phases: Discovery (`?go-get=1`) with `Go-http-client/2.0`, then Git requests (`git-upload-pack`) with your custom User-Agent.

### Why Private Repo Traffic Disappears from mitmproxy

Three causes: (1) Git is using SSH instead of HTTPS due to an `insteadOf` rule -- mitmproxy only intercepts HTTP/HTTPS. (2) Git is not using the proxy -- it may ignore shell `https_proxy`; set `git config http.proxy` explicitly. (3) Git is silently rejecting the mitmproxy CA certificate -- configure `git config http.sslcainfo` to point to mitmproxy's CA PEM.

### The 405 CONNECT Error

A `405 CONNECT` means the proxy is refusing the HTTPS tunnel request. Almost always caused by pointing `https_proxy` to mitmproxy's **web UI port** (8081) instead of its **proxy listener port** (8080). The web UI doesn't understand `CONNECT` and returns 405.

### The Bulletproof CI Setup

Set `GOPROXY=direct`, `GOPRIVATE`, and `GONOSUMDB` for your org. Write `.netrc` with the token for auth. Optionally set a custom Git User-Agent for audit logs. Use `go get -x` to see exact commands Go executes for debugging.

## Quick Reference

```
go get github.com/foo/bar

  GOPROXY=proxy.golang.org (default)         GOPRIVATE or GOPROXY=direct
  ┌────────────────────────────┐              ┌─────────────────────────────────┐
  │ cmd/go internal HTTP client│              │ 1. Discovery (cmd/go HTTP)      │
  │ → proxy.golang.org         │              │    GET ?go-get=1                │
  │ → sum.golang.org (verify)  │              │    UA: Go-http-client/2.0       │
  │ UA: Go-http-client/2.0     │              │ 2. VCS fetch (git binary)       │
  │ Auth: none needed          │              │    git ls-remote / fetch         │
  └────────────────────────────┘              │    UA: git config http.userAgent │
                                              │    Auth: .netrc / SSH / cred hlpr│
                                              └─────────────────────────────────┘
```

**Control matrix:**

| Phase | Tool | User-Agent | Auth Source | Proxy Respect |
|---|---|---|---|---|
| Proxy download | `cmd/go` internal | `Go-http-client/2.0` | None needed | `https_proxy` |
| Discovery | `cmd/go` internal | `Go-http-client/2.0` | `.netrc` | `https_proxy` |
| VCS fetch | `git` binary | `git config` value | `.netrc` / SSH / credential helper | `git config http.proxy` |

**Debugging checklist:**

| Symptom | Likely Cause | Fix |
|---|---|---|
| Requests to `proxy.golang.org` | `GOPRIVATE` not set | Set `GOPRIVATE` |
| 401 on `?go-get=1` | Missing `.netrc` | Populate `~/.netrc` |
| 401 on `git-upload-pack` | Missing Git credentials | `.netrc` or `url.insteadOf` |
| Blank mitmproxy | Git using SSH or not proxied | Force HTTPS + `git config http.proxy` |
| 405 CONNECT | Wrong proxy port | Use port 8080, not 8081 |

**CI auth one-liner:**
```
echo "machine github.com login x-access-token password $TOKEN" > ~/.netrc && chmod 600 ~/.netrc
```

## Key Takeaways

- `go get` has two HTTP clients (Go internal + git binary) with different User-Agents, auth, and proxy behavior -- know which path you're on when debugging
- The Discovery phase (`?go-get=1`) always uses Go's internal client with an unchangeable `Go-http-client/2.0` User-Agent
- Always set `GOPRIVATE` for private repos, not just `GOPROXY=direct`, to avoid leaking repo names to `sum.golang.org`
- `.netrc` is the single auth method that covers both the Discovery phase and the Git fetch phase
- The `Go-http-client/2.0` User-Agent cannot cause 401s -- if you get a 401, focus on credentials
- Private repo traffic disappearing from mitmproxy is usually SSH `insteadOf` rules, missing `git config http.proxy`, or CA cert rejection
- `405 CONNECT` in mitmproxy almost always means you're pointing to the web UI port (8081) instead of the proxy port (8080)
- Use `go get -x` to see exactly which commands Go executes under the hood
