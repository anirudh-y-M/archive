---
title: "Go Module Fetching Internals: Two-Path Logic, User-Agent & Mitmproxy Debugging"
---

## The Two-Path Fetching Model

The Go toolchain has two distinct transport modes when fetching modules. Understanding this split is critical for debugging 401 errors, controlling User-Agent headers, and tracing network traffic.

**The Proxy Path (default):** `go get` → `proxy.golang.org` → downloads `.zip`/`.mod` files. The `go` binary itself makes HTTP requests using its internal `net/http` client. User-Agent is hardcoded to `Go-http-client/1.1` or `Go-http-client/2.0`. Controlled by the `GOPROXY` environment variable.

**The VCS/Git Path (fallback or private):** `go get` → `git clone` → GitHub. The `go` binary shells out to the system `git` binary. User-Agent follows `git config http.userAgent`. Triggered when `GOPROXY=direct`, `GOPRIVATE` is set for the module, or the proxy returns 404/410.

---

## The Discovery Phase

Before Go decides whether to use Git, SVN, or Mercurial, it performs a discovery handshake. The `go` binary makes a direct HTTP request:

```
GET https://github.com/user/repo?go-get=1
```

It reads the HTML response for a `<meta>` tag:

```html
<meta name="go-import" content="github.com/user/repo git https://github.com/user/repo.git">
```

Only after parsing this tag does Go invoke the system `git` binary. The discovery request is **always** made by `cmd/go` using `net/http` — it never shells out to Git, never checks `git config`. The `Go-http-client/2.0` User-Agent is unavoidable for this request.

---

## Why `git config http.userAgent` Only Partially Works

Setting `git config --global http.userAgent "MyCustomIdentity/1.0"` only changes the User-Agent for requests handled by the `git` binary — the VCS fetch phase (`git-upload-pack`, `git ls-remote`).

| Request Type | Uses Go `net/http` | Uses `git` binary | Respects `git config`? |
| --- | --- | --- | --- |
| Proxy download | Yes | No | No |
| Discovery (`?go-get=1`) | Yes | No | No |
| Private repo fetch | No | Yes | Yes |
| `GOPROXY=off` | No | Yes | Yes |

---

## `GOPRIVATE` and `GOPROXY=direct`

### `GOPRIVATE`

A comma-separated list of glob patterns. Matching modules skip the proxy (`proxy.golang.org`) **and** the checksum database (`sum.golang.org`), and are fetched directly via VCS.

```bash
export GOPRIVATE="github.com/your-org/*"
```

This is the standard approach for private repositories — `proxy.golang.org` doesn't have your credentials and can't fetch them.

### `GOPROXY=direct`

The aggressive option — bypasses the proxy for **all** modules:

```bash
export GOPROXY=direct
```

The default is `https://proxy.golang.org,direct` (try proxy first, fall back to direct). Setting `direct` means every module fetch talks to the VCS directly.

### The Critical Difference

| Setting | Scope | Checksum Database |
| --- | --- | --- |
| `GOPRIVATE=github.com/*` | Only matching modules | Skipped (private names stay private) |
| `GOPROXY=direct` | All modules | **Still used** unless `GOSUMDB=off` |

**Security warning:** `GOPROXY=direct` without `GOPRIVATE` still sends module names and versions to `sum.golang.org` — leaking private repo names to a public Google-run transparency log. Always pair `GOPROXY=direct` with `GONOSUMDB` or `GOPRIVATE` for private modules.

---

## The Unchangeable Discovery Header

There is no official environment variable or configuration to change the `Go-http-client/2.0` User-Agent for the Discovery phase. It's compiled into Go's `net/http` default transport. The only workarounds are high-effort:

| Method | How | Difficulty |
| --- | --- | --- |
| Header rewriting proxy | mitmproxy or Nginx intercepts and rewrites the header | Medium |
| Recompile Go | Modify `src/net/http/request.go`, rebuild toolchain | Very high |
| Pre-computed cache | Copy `GOMODCACHE` to avoid Discovery entirely | High |

GitHub does **not** block requests based on `Go-http-client/2.0`. If you're seeing a 401, the User-Agent is irrelevant — focus on credentials.

---

## Authenticating `go get` for Private Repos

The Go toolchain does not automatically pick up `GITHUB_TOKEN`. Credentials must be explicitly provided.

### `.netrc` (Recommended)

Works for both the Discovery phase (Go's internal client) and the Git fetch:

```bash
echo "machine github.com login x-access-token password ${GITHUB_TOKEN}" > ~/.netrc
chmod 600 ~/.netrc
```

### Git credential rewrite

```bash
git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
```

### In GitHub Actions

```yaml
- name: Setup Authentication
  run: |
    echo "machine github.com login x-access-token password ${{ secrets.GITHUB_TOKEN }}" > ~/.netrc
    chmod 600 ~/.netrc

- name: Fetch Modules
  run: go mod download
```

---

## Debugging with mitmproxy

### Setup

```bash
brew install mitmproxy    # macOS
mitmweb                   # starts proxy on :8080, web UI on :8081
```

Configure environment:

```bash
export http_proxy=http://127.0.0.1:8080
export https_proxy=http://127.0.0.1:8080
```

Visit `mitm.it` while the proxy is active and install the CA certificate. Go is strict about TLS — without the cert, `go get` fails with `certificate signed by unknown authority`.

### Observing the Two-Path Split

**Public module (Proxy Path):**

```bash
go mod download github.com/google/uuid@latest
```

Mitmproxy shows requests to `proxy.golang.org`. User-Agent: `Go-http-client/2.0`. `git config` has no effect.

**Private module (VCS Path):**

```bash
git config --global http.userAgent "MyCustomIdentity/1.0"
export GOPRIVATE="github.com/your-org/*"
go clean -modcache
go get github.com/your-org/private-repo
```

Mitmproxy shows two phases: (1) Discovery `GET github.com/.../?go-get=1` with `Go-http-client/2.0`, then (2) Git requests `POST .../git-upload-pack` with `MyCustomIdentity/1.0`.

---

## Why Private Repo Traffic Disappears from mitmproxy

If public module traffic appears but private traffic is blank, three likely causes:

**Git is using SSH instead of HTTPS.** Mitmproxy only intercepts HTTP/HTTPS. Check for `insteadOf` rules:

```bash
git config --global --get url."git@github.com:".insteadOf
git config --global --unset url."git@github.com:".insteadOf   # remove to force HTTPS
```

**Git is not using the proxy.** The `git` binary may ignore your shell's `https_proxy`. Set it explicitly:

```bash
git config --global http.proxy http://127.0.0.1:8080
```

**Git is rejecting the CA certificate silently.** Git fails the TLS handshake without logging:

```bash
# Debug only — not for production
git config --global http.sslVerify false

# Proper fix
git config --global http.sslcainfo ~/.mitmproxy/mitmproxy-ca-cert.pem
```

---

## The `405 CONNECT` Error

```
405 CONNECT github.com:443 (127.0.0.1) 0.36ms
```

A 405 on `CONNECT` means the proxy is refusing to open an HTTPS tunnel. The most common cause: **pointing to the wrong port**. `mitmweb` serves the web UI at `:8081` and listens for proxy traffic at `:8080`. If `https_proxy` points to `8081`, the web server receives a `CONNECT` request it doesn't understand and returns 405.

| Cause | Fix |
| --- | --- |
| Port mismatch (pointing to web UI) | Use `http_proxy=http://127.0.0.1:8080` not `8081` |
| Proxy mode mismatch | Restart with `mitmweb -p 8080` or use `mitmdump -p 8080` |
| TLS interception failure | Install and trust the mitmproxy CA certificate |

---

## The Bulletproof CI Setup

```yaml
- name: Setup Go Private Module Auth
  run: |
    # Force direct fetching (skip proxy.golang.org)
    echo "GOPROXY=direct" >> $GITHUB_ENV
    echo "GONOSUMDB=github.com/your-org/*" >> $GITHUB_ENV
    echo "GOPRIVATE=github.com/your-org/*" >> $GITHUB_ENV

    # Credentials for both Discovery (Go client) and Clone (Git)
    echo "machine github.com login x-access-token password ${{ secrets.GITHUB_TOKEN }}" > ~/.netrc
    chmod 600 ~/.netrc

    # Optional: custom Git User-Agent for audit logs
    git config --global http.userAgent "GitHub-Actions-${{ github.repository }}"

- name: Download Modules
  run: go mod download
```

Use `go get -x` to see the exact commands Go executes under the hood for debugging.

---

## Debugging Checklist

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| Requests to `proxy.golang.org` | `GOPRIVATE` not set or `GOPROXY` not `direct` | Set `GOPRIVATE` or `GOPROXY=direct` |
| 401 on `?go-get=1` | Missing `.netrc` for Discovery phase | Populate `~/.netrc` |
| 401 on `git-upload-pack` | Missing Git credentials | Use `.netrc` or `url.insteadOf` with token |
| Blank mitmproxy | Git using SSH or not proxied | Force HTTPS + `git config http.proxy` |
| 405 CONNECT | Wrong proxy port | Point to proxy port (8080), not web UI (8081) |
| `Go-http-client/2.0` on Discovery | Normal — hardcoded | Cannot change without recompiling Go |

---

## Control Matrix

| Phase | Tool | User-Agent | Auth Source | Proxy Respect |
| --- | --- | --- | --- | --- |
| Proxy download | `cmd/go` internal | `Go-http-client/2.0` | None needed | High (`https_proxy`) |
| Discovery (`?go-get=1`) | `cmd/go` internal | `Go-http-client/2.0` | `.netrc` | High (`https_proxy`) |
| VCS fetch (`git-upload-pack`) | `git` binary | `git config http.userAgent` | `.netrc` / SSH / credential helper | Requires `git config http.proxy` |

---

## See also

- [[notes/Git/user-agent|GitHub API 401s - Go-http-client & OIDC]]
- [[notes/AuthNZ/github-actions-token-anatomy|GitHub Actions Token Anatomy: OAuth vs OIDC]]
- [[notes/Golang/golang-environment-variables|Go Environment Variables]]
- [[notes/proxies-and-tls-termination|Proxies & TLS Termination]]
- [Go Modules: Private Modules](https://go.dev/ref/mod#private-modules)
- [Mitmproxy Docs](https://docs.mitmproxy.org/stable/)

---

## Interview Prep

### Q: How does `go get` fetch a module end-to-end? Walk through every network request.

**A:** When you run `go get github.com/user/repo`, the Go toolchain goes through a multi-step process depending on configuration.

**Default path (via proxy):** The `go` binary sends an HTTPS request to `proxy.golang.org/github.com/user/repo/@v/list` using its internal `net/http` client. The User-Agent is `Go-http-client/2.0`. The proxy returns a list of available versions. Go picks the appropriate version and requests `proxy.golang.org/github.com/user/repo/@v/v1.2.3.info` (version metadata), then `v1.2.3.mod` (go.mod file), then `v1.2.3.zip` (source archive). After downloading, Go verifies the checksum against `sum.golang.org` — another HTTPS request to `sum.golang.org/lookup/github.com/user/repo@v1.2.3`. If the checksum matches, the module is cached in `$GOMODCACHE`. No Git involved at all.

**Direct/private path (via VCS):** If `GOPRIVATE` matches or `GOPROXY=direct`, Go skips the proxy. First, it sends a Discovery request: `GET https://github.com/user/repo?go-get=1` using its internal HTTP client (`Go-http-client/2.0`). This returns an HTML page with a `<meta name="go-import">` tag telling Go the VCS type (Git) and repository URL. Go then shells out to the system `git` binary. Git runs `git ls-remote -q origin` to list refs, then `git fetch` to download objects. The `git` binary makes its own HTTPS requests (`git-upload-pack` protocol) to `github.com`. These Git requests use the User-Agent from `git config http.userAgent` (or Git's default), authenticate via `.netrc` or Git credential helpers, and respect `git config http.proxy` (not the shell's `https_proxy`). Once Git has the objects, Go extracts the source and caches it.

The two paths have completely different User-Agent headers, authentication mechanisms, and proxy behavior — which is why debugging requires knowing which path you're on.

### Q: Why does `git config --global http.userAgent` not affect all `go get` traffic?

**A:** Because `go get` has two phases with two different HTTP clients. The Discovery phase (`?go-get=1`) is handled by Go's internal `net/http` library, which has a hardcoded default User-Agent of `Go-http-client/2.0`. It does not read `git config` at all — Git isn't involved yet. Only the VCS fetch phase (`git-upload-pack`, `git ls-remote`) uses the system `git` binary, which respects `git config http.userAgent`. So you end up with mixed User-Agents in your logs: `Go-http-client/2.0` for Discovery, your custom value for the actual clone/fetch.

### Q: What is the difference between `GOPRIVATE` and `GOPROXY=direct`?

**A:** `GOPROXY=direct` forces **all** modules to be fetched directly via VCS, bypassing `proxy.golang.org` entirely. `GOPRIVATE` only affects modules matching the glob patterns — those skip both the proxy and the checksum database (`sum.golang.org`). The critical security implication: using `GOPROXY=direct` without `GOPRIVATE` still sends module names to `sum.golang.org` for checksum verification, which leaks private repository names to a public transparency log. `GOPRIVATE` sets both `GONOPROXY` and `GONOSUMDB` implicitly, keeping private module names off the public internet.

### Q: You're seeing `405 CONNECT github.com:443` in mitmproxy logs. What went wrong?

**A:** The HTTP `CONNECT` method is how clients ask a proxy to open a TCP tunnel for HTTPS traffic. A 405 means "Method Not Allowed" — the server receiving the `CONNECT` request doesn't understand it. The most common cause: `https_proxy` is pointing to mitmproxy's **web UI port** (8081) instead of its **proxy listener port** (8080). The web UI is a regular HTTP server that serves the mitmproxy dashboard. When it receives a `CONNECT` request, it has no idea what to do and returns 405. Fix: set `https_proxy=http://127.0.0.1:8080` (the proxy port, not the UI port).

### Q: Why does mitmproxy show no traffic for private Go module downloads while public modules show fine?

**A:** Public modules go through `proxy.golang.org` via Go's internal HTTP client, which respects the `https_proxy` environment variable. Private modules bypass the proxy and use the system `git` binary. Three reasons Git traffic might not appear: (1) Git is configured with `url."git@github.com:".insteadOf` which rewrites HTTPS to SSH — mitmproxy can only intercept HTTP/HTTPS, not SSH (port 22). Remove the `insteadOf` rule to force HTTPS. (2) The `git` binary doesn't inherit the shell's `https_proxy` in all contexts — set `git config --global http.proxy http://127.0.0.1:8080` explicitly. (3) Git rejects mitmproxy's self-signed CA certificate silently and the TLS handshake fails before any traffic appears — configure `git config --global http.sslcainfo ~/.mitmproxy/mitmproxy-ca-cert.pem`.

### Q: How does the Go toolchain authenticate when fetching private modules? Walk through the credential lookup.

**A:** The Go toolchain uses two separate authentication paths for its two fetch phases.

**Discovery phase** (`GET https://github.com/org/repo?go-get=1`): Made by Go's internal `net/http` client. It reads credentials from `~/.netrc`. The `.netrc` entry must match: `machine github.com login x-access-token password <TOKEN>`. Go parses this file, finds the matching `machine` entry, and adds an `Authorization: Basic <base64(login:password)>` header to the request. If `.netrc` is missing or doesn't have a matching entry, this request goes out unauthenticated. For a private repo, GitHub returns 401 (or a redirect to login). Go treats this as "module not found" and gives up.

**VCS fetch phase** (`git ls-remote`, `git fetch`): The system `git` binary handles authentication independently. Git checks, in order: (1) `url.*.insteadOf` rewrites — if configured, may switch to SSH and use `~/.ssh/id_rsa`. (2) Credential helpers — `git config credential.helper` can return stored credentials. (3) `.netrc` — Git also reads `~/.netrc` as a fallback. (4) Interactive prompt — in CI, there's no TTY, so this fails silently.

The `GITHUB_TOKEN` in Actions is **not** automatically available to either path. You must explicitly map it: either to `.netrc` (`echo "machine github.com login x-access-token password $TOKEN" > ~/.netrc`) or via a Git URL rewrite (`git config --global url."https://x-access-token:$TOKEN@github.com/".insteadOf "https://github.com/"`). The `.netrc` approach is preferred because it covers both the Go client and Git in one configuration.

### Q: Can you change the `Go-http-client/2.0` User-Agent for the Go toolchain's Discovery requests?

**A:** No. There is no environment variable, `go env` setting, or configuration file that changes it. The default User-Agent is set in Go's `net/http` package (`defaultUserAgent` in `request.go`) and compiled into the `go` binary. The only options are: (1) Put a header-rewriting proxy between Go and the internet (mitmproxy with a Python addon or Nginx with `proxy_set_header`). (2) Recompile the Go toolchain from source after modifying `src/net/http/request.go`. (3) Pre-populate `$GOMODCACHE` so Go never needs to make Discovery requests. None of these are practical for most teams. The good news: GitHub does not rate-limit or block based on `Go-http-client/2.0`, so the header is cosmetic — it doesn't cause 401s or access issues.
