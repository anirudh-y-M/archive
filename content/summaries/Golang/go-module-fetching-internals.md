---
title: "Summary: Go Module Fetching Internals"
---

> **Full notes:** [[notes/Golang/go-module-fetching-internals|Go Module Fetching Internals →]]

## Key Concepts

**Two-path fetching model** -- `go get` uses two completely independent network paths depending on config. The **proxy path** (default) fetches `.zip`/`.mod` from `proxy.golang.org` using Go's internal HTTP client. The **VCS/Git path** shells out to the system `git` binary for private repos or when `GOPROXY=direct`.

**Discovery phase** -- Before cloning via Git, Go always sends `GET https://host/repo?go-get=1` using its own HTTP client to find a `<meta name="go-import">` tag. This request always has `Go-http-client/2.0` as User-Agent -- cannot be changed.

**User-Agent split** -- `git config http.userAgent` only affects the Git binary phase, not Discovery or proxy downloads. This is why custom User-Agents appear to "not work" for some requests.

**GOPRIVATE vs GOPROXY=direct** -- `GOPRIVATE` skips both proxy AND checksum DB for matching modules. `GOPROXY=direct` skips proxy for ALL modules but still sends names to `sum.golang.org` (leaks private repo names).

**Authentication** -- Go does not auto-detect `GITHUB_TOKEN`. Use `.netrc` (covers both Go client and Git) or `git config url.insteadOf` with a token.

## Quick Reference

```
go get github.com/foo/bar

  GOPROXY=proxy.golang.org (default)         GOPRIVATE or GOPROXY=direct
  ┌────────────────────────────┐              ┌────────────────────────────┐
  │ cmd/go internal HTTP client│              │ 1. Discovery (cmd/go HTTP) │
  │ → proxy.golang.org         │              │    GET ?go-get=1           │
  │ → sum.golang.org (verify)  │              │ 2. VCS fetch (git binary)  │
  │ UA: Go-http-client/2.0     │              │    git ls-remote / fetch   │
  │ Auth: none needed           │              │    UA: git config value    │
  └────────────────────────────┘              └────────────────────────────┘
```

| Setting | Scope | Skips Proxy | Skips Checksum DB |
|---|---|---|---|
| `GOPRIVATE=x/*` | Matching only | Yes | Yes |
| `GOPROXY=direct` | All modules | Yes | No (still leaks names!) |

**CI auth setup (one-liner):**
```
echo "machine github.com login x-access-token password $TOKEN" > ~/.netrc
```

## Key Takeaways

- `go get` has two HTTP clients (Go internal + git binary) with different User-Agents, auth, and proxy behavior -- know which path you're on when debugging
- Always set `GOPRIVATE` for private repos, not just `GOPROXY=direct`, to avoid leaking repo names to `sum.golang.org`
- `.netrc` is the single auth method that covers both the Discovery phase and the Git fetch phase
- The `Go-http-client/2.0` User-Agent on Discovery requests is hardcoded and cannot cause 401s -- if you get a 401, focus on credentials
- Use `go get -x` to see exactly which commands Go executes under the hood
