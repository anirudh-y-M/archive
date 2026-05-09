---
title: "Summary: HTTP Sessions, Cookies & Cookie Security"
---

> **Full notes:** [[notes/AuthNZ/http-sessions-cookies-security|HTTP Sessions, Cookies & Cookie Security -->]]

## Key Concepts

### Why Sessions Exist

HTTP is stateless — every request is independent. Web apps need state ("logged in", "admin", "cart"). Solution: server creates a **session** (server-side state) tied to a unique **session ID**; the client only holds the ID, presents it on every request. Coat-check ticket model. Standardized by **RFC 6265** (HTTP State Management Mechanism).

### Session ID Lifecycle

1. User POSTs `/login` → server validates creds (bcrypt/argon2 compare).
2. Server generates session ID via **CSPRNG** (`os.urandom`, `crypto.randomBytes`, `crypto/rand`). Never `Math.random()`/`rand()` — predictable from observed outputs.
3. Server stores `session_id → {user_id, role, created_at, ...}` in a session store with TTL.
4. Server sends `Set-Cookie: __Host-sid=...; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`.
5. Browser auto-attaches the cookie on every same-origin request.
6. Server looks up the ID and identifies the user.
7. Termination: TTL expiry, explicit logout (`Max-Age=0` + delete server-side), or revocation (delete the key in Redis — instant).

OWASP requires **≥128 bits** of entropy. At 128 bits, brute-forcing at 10⁹ guesses/s takes ~10²² years.

### Session Storage Backends

| Backend | Properties | Trade-offs |
|---|---|---|
| In-memory (process) | Fastest | Lost on restart; not shared across instances |
| Relational DB | Persistent, queryable | Disk I/O on every request |
| Redis / Memcached | Fast, native TTL, shared across instances | Extra infra; data loss without RDB/AOF persistence |
| Signed cookies (state in cookie) | Stateless, no server store | 4 KB cap; cannot revoke without blacklist |

Production default: Redis. Instant revocation (`DEL session:...`) is a major advantage over JWTs.

### Cookies — The Transport Mechanism

RFC 6265 / 6265bis. Max ~4 KB. `Set-Cookie` (server→client), `Cookie` header (client→server). Browser sending rules: domain match, path prefix, `Secure`, `SameSite`, expiry. **Omitting `Domain` is more restrictive** (exact origin only) — that's why `__Host-` requires no `Domain`.

### Cookie Security Attributes (Defense in Depth)

| Attribute | Threat mitigated |
|---|---|
| `HttpOnly` | XSS-based cookie theft (JS can't read via `document.cookie`) |
| `Secure` | Network eavesdropping (only sent over HTTPS) |
| `SameSite` | CSRF (controls cross-site cookie sending) |
| `__Host-` / `__Secure-` | Subdomain cookie overwrite attacks |
| `Max-Age` / TTL | Limits exposure window of stolen sessions |
| Signing (HMAC) | Cookie tampering / privilege escalation |
| Rotation on login | Session fixation |

#### HttpOnly (RFC 6265 §5.2.6)

Browser excludes the cookie from `document.cookie`. Enforced at engine level (Blink/Gecko/WebKit). Stops XSS exfiltration of the raw value. Does **NOT** stop XSS itself — attacker's script can still issue authenticated requests via `fetch()` (cookie auto-attached), modify DOM, redirect, keylog.

#### Secure (RFC 6265 §5.2.5)

Cookie only sent over HTTPS. RFC explicitly warns: "An active network attacker can overwrite Secure cookies from an insecure channel" — hence the existence of `__Host-`/`__Secure-` prefixes.

#### SameSite (RFC 6265bis)

| Value | Behavior | CSRF |
|---|---|---|
| `Strict` | Never sent on cross-site requests | Full protection; breaks email-link UX |
| `Lax` | Sent on cross-site **top-level GET nav** only | Blocks CSRF POSTs; allows links |
| `None` | Always sent (requires `Secure`) | None |

`Lax` is the modern default (Chrome 2020, Firefox 2022). **`Lax` still allows GET-based CSRF** — never make state-changing operations GET (violates RFC 7231 anyway).

#### Cookie Prefixes (RFC 6265bis)

`__Host-` (strict): browser rejects unless `Secure`, no `Domain` (exact origin), `Path=/`, set from HTTPS. Blocks subdomain overwrites.
`__Secure-` (loose): requires `Secure` + HTTPS origin only. Use when cookie must span subdomains.

### Cookie Signing & Encryption

When session data lives **in** the cookie:
- **Signing (HMAC-SHA256)**: `data + "." + HMAC(secret, data)`. Prevents tampering; client can read.
- **Encryption (AES-256-GCM)**: client cannot read or tamper.

Framework defaults: Rails encrypts+signs (AES-256-GCM + HMAC). Flask signs only (HMAC-SHA1, no encryption). Express `cookie-session` signs by default; encryption opt-in.

### Session Fixation & Rotation

Attack: attacker pre-sets a known session ID on victim → victim logs in → server **upgrades the same ID** to authenticated → attacker uses the known ID.

Defense: **regenerate session ID on every privilege transition** — login, role escalation, sensitive actions. One-line fix in most frameworks (`session.regenerate()`, `gorilla/sessions` re-issue).

### Other Server-Side Defenses

- **IP/UA binding**: reject if `request.ip != session.bound_ip`. Trade-off: breaks for mobile/VPN users; usually logged-as-suspicious rather than hard-rejected.
- **CSRF tokens**: random per-session token in hidden form input; same-origin policy stops cross-site reads. Belt-and-suspenders with `SameSite=Lax`.
- **CSP**: `Content-Security-Policy: default-src 'self'; script-src 'self'` prevents inline-script XSS — the strongest XSS mitigation.
- **HSTS**: closes the first-request HTTP gap that `Secure` alone leaves; preload list pushes it to first-ever visit.

### What Cookies Cannot Solve

| Gap | Defense |
|---|---|
| XSS-based authenticated actions (cookie auto-attached) | Prevent XSS itself: CSP, output encoding, sanitization |
| Compromised server (store + signing keys) | Infra security, key rotation, IDS |
| Local/physical access to cookie jar | Full-disk encryption, OS controls |
| Browser bugs leaking HttpOnly | Keep browsers updated |
| MITM on first HTTP request before HSTS | HSTS preload, `includeSubDomains` |

## Quick Reference

### The Complete Auth Cookie

```
Set-Cookie: __Host-sid=Kj8mP2xR9vNqW7bT...; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600
             │         │                       │       │       │         │             │
             │         │                       │       │       │         │             └─ 1h TTL
             │         │                       │       │       │         └─ Cross-site POST blocked
             │         │                       │       │       └─ JS cannot read
             │         │                       │       └─ HTTPS only
             │         │                       └─ Whole site
             │         └─ ≥128-bit CSPRNG random
             └─ __Host-: no subdomain/domain override
```

### CSPRNG examples

```python
session_id = os.urandom(32).hex()       # 256 bits
```
```go
b := make([]byte, 32); crypto_rand.Read(b)
```
```javascript
crypto.randomBytes(32).toString('hex')
```

### SameSite=Lax cross-site behavior (from evil.com to bank.com)

| Request | Cookie sent? |
|---|---|
| `<a href=...>` (top-level GET nav) | YES |
| `<form method="GET">` | YES |
| `<form method="POST">` | NO ← CSRF blocked |
| `<img>`, `<iframe>`, `<script>fetch()` | NO |

### Sessions vs JWT

| | Server-Side Sessions | JWT (Stateless) |
|---|---|---|
| Storage | Server (Redis/DB) | Client (cookie/localStorage) |
| Revocation | Instant (delete key) | Hard (blacklist or short TTL + refresh) |
| Scalability | Shared session store | Any server validates with public key |
| Cookie size | ~32 bytes (ID only) | 500+ bytes |
| Sensitive data | Server-side (safe) | In token (must encrypt) |

## Key Takeaways

- Always generate session IDs via a CSPRNG (≥128 bits); never `Math.random()` or non-crypto PRNGs — observed outputs are predictable.
- The full security cookie is `__Host-name=...; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=N` — every flag covers a different attack vector; none alone is enough.
- `HttpOnly` blocks raw cookie theft via XSS, but the attacker's script can still issue authenticated requests because the browser auto-attaches the cookie. The real XSS defense is CSP + output encoding.
- `SameSite=Lax` is the modern default and blocks POST-based CSRF, but only POST. State-changing endpoints must never use GET.
- `__Host-` prefix beats plain `Secure; HttpOnly` because it forbids subdomains from overwriting the cookie via `Domain=parent.example.com` injection.
- Always **regenerate the session ID after authentication** to defeat session fixation.
- Server-side sessions in Redis give instant revocation (delete the key); JWTs do not without an extra blacklist that defeats their stateless benefit.
- `Secure` alone leaves a first-HTTP-request window — pair with HSTS (and ideally HSTS preload) to close it.
- Cookie attributes are damage-limitation; the single most important defense remains preventing XSS at the application layer.
