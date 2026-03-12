---
title: "TLS 1.3 Handshake: Key Exchange, Authentication, and Certificate Chain of Trust"
---

## Overview

TLS 1.3 (RFC 8446, August 2018) is a complete redesign of the TLS handshake. It eliminates legacy cipher suites, removes RSA key transport, mandates forward secrecy, and completes the handshake in a single round trip (1-RTT). This note covers the full handshake flow at wire level, the cryptographic mechanisms behind key exchange and authentication, the certificate chain of trust, and the common misconceptions about what certificates actually do.

For the complete end-to-end HTTPS flow including TCP, TLS, and HTTP body framing, see [[notes/Networking/https-tcp-tls-flow-content-length-vs-chunked-vs-http2|End-to-End HTTPS Flow]].

For TLS termination at proxies and load balancers, see [[notes/Networking/proxies-and-tls-termination|Proxies & TLS Termination]].

---

## What Changed from TLS 1.2 to TLS 1.3

| Aspect | TLS 1.2 | TLS 1.3 (RFC 8446) |
|---|---|---|
| Round trips | 2-RTT | 1-RTT (0-RTT optional) |
| Key exchange | RSA key transport or (EC)DHE | **(EC)DHE only** -- RSA key transport removed |
| Forward secrecy | Optional (only with (EC)DHE) | **Mandatory** (always ephemeral keys) |
| Server certificate | Sent in plaintext | **Encrypted** with handshake keys |
| Cipher suites | 37+ (many insecure) | **5 AEAD-only** cipher suites |
| ChangeCipherSpec | Real protocol message | Removed (compatibility stub only) |
| Renegotiation | Supported | **Removed** |
| Static RSA | Supported (no PFS) | **Removed** |
| Compression | Supported | **Removed** (CRIME attack) |

> **Note:** The removal of RSA key transport is one of the most important changes. In TLS 1.2 with RSA, the client encrypted a "pre-master secret" with the server's public key from the certificate. If the server's private key was later compromised, all past sessions could be decrypted. TLS 1.3 eliminates this entirely.

---

## The Full 1-RTT Handshake Flow

```
Client                                                    Server
  |                                                          |
  |  -------- ClientHello -------------------------------->  |
  |    - client_random (32 bytes)                            |
  |    - cipher_suites                                       |
  |    - key_share (client's ECDHE public key)               |  PLAINTEXT
  |    - supported_versions: TLS 1.3                         |
  |    - signature_algorithms                                |
  |    - SNI (server_name)                                   |
  |                                                          |
  |  <------- ServerHello --------------------------------   |
  |    - server_random (32 bytes)                            |  PLAINTEXT
  |    - selected cipher_suite                               |
  |    - key_share (server's ECDHE public key)               |
  |                                                          |
  |  ~~~~~ Both sides compute handshake keys ~~~~~           |
  |  (ECDHE shared secret + HKDF key schedule)               |
  |                                                          |
  |  <------- {EncryptedExtensions} ----------------------   |
  |    - ALPN result, etc.                                   |
  |                                                          |
  |  <------- {Certificate} ------------------------------   |
  |    - server X.509 certificate chain                      |  ENCRYPTED
  |                                                          |  (handshake
  |  <------- {CertificateVerify} ------------------------   |   traffic
  |    - digital signature over handshake transcript         |   keys)
  |                                                          |
  |  <------- {Finished} ---------------------------------   |
  |    - HMAC over handshake transcript                      |
  |                                                          |
  |  -------- {Finished} -------------------------------->   |
  |    - HMAC over handshake transcript                      |  ENCRYPTED
  |                                                          |
  |  ~~~~~ Both sides derive application traffic keys ~~~~~  |
  |                                                          |
  |  <======= Application Data (e.g. HTTP) ===============>  |
```

Key observation: only **ClientHello** and **ServerHello** are in plaintext. Everything after ServerHello (from EncryptedExtensions onward) is encrypted with handshake traffic keys. This is a major improvement over TLS 1.2, where the server's certificate was visible to any passive eavesdropper.

---

## ClientHello: What the Client Sends (Wire-Level)

The ClientHello is a TLS Handshake message wrapped in a TLS Record:

```
TLS Record Header (5 bytes):
  ContentType:  0x16 (Handshake)
  Version:      0x0301 (TLS 1.0 -- for middlebox compatibility)
  Length:        variable

Handshake Header (4 bytes):
  HandshakeType: 0x01 (ClientHello)
  Length:         3 bytes

ClientHello Body:
  legacy_version:    0x0303 (TLS 1.2 -- NOT the actual version negotiated)
  random:            32 bytes of cryptographic random
  legacy_session_id: 32 bytes (for middlebox compatibility, not used by TLS 1.3)
  cipher_suites:     list of supported AEAD cipher suites
  legacy_compression_methods: [0x00] (null only)
  extensions:        (this is where the real TLS 1.3 negotiation happens)
```

### Critical Extensions

| Extension | RFC 8446 Section | Purpose |
|---|---|---|
| `supported_versions` | 4.2.1 | **Actual version negotiation**. Client lists `0x0304` (TLS 1.3). This overrides `legacy_version`. |
| `key_share` | 4.2.8 | Client's ephemeral ECDHE public key (e.g., 32 bytes for x25519) |
| `supported_groups` | 4.2.7 | Named groups client supports: `x25519`, `secp256r1`, `secp384r1` |
| `signature_algorithms` | 4.2.3 | What signature schemes client can verify: `ecdsa_secp256r1_sha256`, `rsa_pss_rsae_sha256`, etc. |
| `server_name` (SNI) | RFC 6066 | Hostname the client wants (e.g., `files.example.com`). Sent in plaintext. |
| `psk_key_exchange_modes` | 4.2.9 | For session resumption / 0-RTT |
| `alpn` | RFC 7301 | Application-Layer Protocol Negotiation: `h2`, `http/1.1` |

> **Note:** The `legacy_version` field is set to `0x0303` (TLS 1.2) and the TLS Record version is `0x0301` (TLS 1.0). Both are frozen for middlebox compatibility. The real version is negotiated exclusively through the `supported_versions` extension. This is defined in RFC 8446 Section 4.1.2.

---

## ServerHello: What the Server Responds

```
ServerHello Body:
  legacy_version:    0x0303 (frozen at TLS 1.2)
  random:            32 bytes of server random
  legacy_session_id: echo of client's session_id
  cipher_suite:      selected suite (e.g., TLS_AES_256_GCM_SHA384 = 0x1302)
  extensions:
    supported_versions: 0x0304 (TLS 1.3)
    key_share:          server's ephemeral ECDHE public key (32 bytes for x25519)
```

After the ServerHello, both client and server have each other's ECDHE public keys. They independently compute the shared secret using their own private key + the peer's public key. From this point, all further messages are encrypted.

### TLS 1.3 Cipher Suites

TLS 1.3 defines only 5 cipher suites (RFC 8446 Section B.4). The cipher suite name in TLS 1.3 specifies only AEAD + hash -- the key exchange is always (EC)DHE, negotiated via extensions:

| Code | Name | AEAD | Hash |
|---|---|---|---|
| `0x1301` | TLS_AES_128_GCM_SHA256 | AES-128-GCM | SHA-256 |
| `0x1302` | TLS_AES_256_GCM_SHA384 | AES-256-GCM | SHA-384 |
| `0x1303` | TLS_CHACHA20_POLY1305_SHA256 | ChaCha20-Poly1305 | SHA-256 |
| `0x1304` | TLS_AES_128_CCM_SHA256 | AES-128-CCM | SHA-256 |
| `0x1305` | TLS_AES_128_CCM_8_SHA256 | AES-128-CCM (8-byte tag) | SHA-256 |

---

## Key Exchange: How Session Keys Are Derived

This is where the most common misconception lives. **The server's certificate public key is NOT used to encrypt session keys or data.** Session keys are derived entirely from an ephemeral Diffie-Hellman exchange.

### The Ephemeral Diffie-Hellman Exchange (ECDHE)

```
  Client                                          Server
    |                                                |
    |  Generate ephemeral key pair:                  |
    |    privC, pubC = x25519_keygen()               |
    |                                                |
    |  --- ClientHello (key_share: pubC) --------->  |
    |                                                |
    |                        Generate ephemeral key pair:
    |                          privS, pubS = x25519_keygen()
    |                                                |
    |  <-- ServerHello (key_share: pubS) ----------  |
    |                                                |
    |  shared_secret = x25519(privC, pubS)           |
    |                        shared_secret = x25519(privS, pubC)
    |                                                |
    |  Both arrive at the SAME shared_secret         |
    |  (this is the Diffie-Hellman invariant)        |
```

The shared secret is **identical** on both sides because of the mathematical property of elliptic curve Diffie-Hellman: `x25519(privC, pubS) == x25519(privS, pubC)`. An eavesdropper who sees `pubC` and `pubS` on the wire cannot compute the shared secret without one of the private keys.

### From Shared Secret to Traffic Keys (HKDF Key Schedule)

The shared secret alone is not used directly. TLS 1.3 uses HKDF (HMAC-based Key Derivation Function, RFC 5869) to derive all keys through a structured key schedule:

```
                      0 (no PSK)
                        |
                        v
            HKDF-Extract = Early Secret
                        |
                        v
                  Derive-Secret(., "derived", "")
                        |
                        v
  (EC)DHE shared secret +
                        |
                        v
            HKDF-Extract = Handshake Secret -------+------+
                        |                          |      |
                        v                          v      v
            Derive-Secret(., "derived", "")    client_   server_
                        |                     handshake  handshake
                        v                     traffic    traffic
               0 (no input) +                 secret     secret
                        |
                        v
            HKDF-Extract = Master Secret --------+------+
                                                 |      |
                                                 v      v
                                            client_    server_
                                            app        app
                                            traffic    traffic
                                            secret     secret
```

The handshake transcript (hash of all messages so far) is mixed in at each `Derive-Secret` step. This binds the keys to the specific handshake that occurred -- if any message was tampered with, the derived keys would differ between client and server, and the Finished messages would fail verification.

**Three distinct sets of keys are derived:**

1. **Handshake traffic keys** -- encrypt EncryptedExtensions, Certificate, CertificateVerify, Finished
2. **Application traffic keys** -- encrypt all application data after the handshake
3. **Resumption keys** -- for future session resumption (NewSessionTicket)

---

## The Certificate: Authentication, Not Encryption

### What the Server's Certificate Contains

The server sends an X.509 certificate chain inside the encrypted `{Certificate}` message. A typical certificate contains:

```
Certificate (X.509 v3):
  Subject:          CN=files.example.com
  Issuer:           CN=Let's Encrypt Authority X3
  Validity:
    Not Before:     2026-01-01 00:00:00 UTC
    Not After:      2026-04-01 00:00:00 UTC
  Subject Public Key Info:
    Algorithm:      ECDSA (secp256r1)   <-- or RSA
    Public Key:     04:ab:cd:ef:...     <-- this is the authentication key
  Extensions:
    Subject Alt Names: files.example.com, *.example.com
    Key Usage:         Digital Signature
    Basic Constraints: CA:FALSE
  Signature:
    Algorithm:      sha256WithRSAEncryption (signed by issuer's key)
    Value:          3a:4b:5c:...
```

### What the Certificate Public Key is Actually Used For

The public key in the certificate has **one job**: verifying the `CertificateVerify` signature to prove the server holds the corresponding private key.

```
  +-----------------------------------------------------------------+
  |                  COMMON MISCONCEPTION                            |
  |                                                                 |
  |  WRONG: "The client encrypts data with the server's public     |
  |          key from the certificate"                              |
  |                                                                 |
  |  RIGHT: The certificate's public key is used ONLY for           |
  |         authentication (verifying CertificateVerify).           |
  |         Session keys come from ECDHE, not from the cert.        |
  |                                                                 |
  |  In TLS 1.2 with RSA key transport (now removed), the cert     |
  |  key WAS used to encrypt the pre-master secret. TLS 1.3        |
  |  eliminated this entirely.                                      |
  +-----------------------------------------------------------------+
```

### CertificateVerify: Proof of Private Key Possession

After sending the Certificate, the server sends a `CertificateVerify` message:

```
CertificateVerify:
  Algorithm:  ecdsa_secp256r1_sha256  (or rsa_pss_rsae_sha256)
  Signature:  SIGN(server_private_key, transcript_hash)
```

The transcript hash covers every handshake message up to this point (ClientHello, ServerHello, EncryptedExtensions, Certificate). The client verifies this signature using the public key from the certificate.

This proves two things:
1. The server possesses the private key corresponding to the certificate's public key
2. No one has tampered with any handshake message (because the transcript hash is signed)

---

## Certificate Chain of Trust

The server does not send just its own certificate -- it sends a **chain** that links to a trusted root CA.

```
                    +---------------------------+
                    |    ROOT CA CERTIFICATE     |
                    |  (Pre-installed on client) |
                    |  e.g., "ISRG Root X1"      |
                    |  Self-signed               |
                    +-------------+-------------+
                                  |
                     Signs with   |  Root CA
                     root key     |  private key
                                  v
                    +---------------------------+
                    |  INTERMEDIATE CA CERT      |
                    |  Issuer: ISRG Root X1      |
                    |  Subject: Let's Encrypt R3 |
                    |  Signed by root CA         |
                    +-------------+-------------+
                                  |
                     Signs with   |  Intermediate CA
                     intermediate |  private key
                     key          v
                    +---------------------------+
                    |  SITE CERTIFICATE (LEAF)   |
                    |  Issuer: Let's Encrypt R3  |
                    |  Subject: files.example.com|
                    |  Signed by intermediate CA |
                    +---------------------------+
```

### How the Client Validates the Chain

```
Step 1: Server sends [Leaf Cert] + [Intermediate Cert]
        (Root cert is NOT sent -- client already has it)

Step 2: Client verifies Leaf Cert
        - Extract signature from leaf cert
        - Verify signature using Intermediate CA's public key
        - Check: subject matches requested hostname (SNI)?
        - Check: current date within Not Before / Not After?
        - Check: Key Usage includes Digital Signature?
        - Check: revocation status (OCSP stapling / CRL)?

Step 3: Client verifies Intermediate Cert
        - Extract signature from intermediate cert
        - Verify signature using Root CA's public key (from trust store)
        - Check: Basic Constraints CA:TRUE?
        - Check: validity period?

Step 4: Root CA is already in the OS/browser trust store
        - Trust anchor found → chain is valid
```

### Where Root CAs Live (Trust Stores)

| Platform | Trust Store Location |
|---|---|
| macOS | System Keychain + `/System/Library/Security/Certificates.bundle` |
| Linux (Debian) | `/etc/ssl/certs/ca-certificates.crt` |
| Linux (RHEL) | `/etc/pki/tls/certs/ca-bundle.crt` |
| Windows | Certificate Manager (`certmgr.msc`) |
| Firefox | Ships its own (Mozilla NSS, independent of OS) |
| Go programs | Use OS trust store by default, or `crypto/x509.SystemCertPool()` |
| Node.js | Uses OpenSSL's compiled-in CA bundle, or `NODE_EXTRA_CA_CERTS` env var |

---

## The Finished Messages: Handshake Integrity

Both sides send a `Finished` message containing an HMAC over the entire handshake transcript:

```
Finished:
  verify_data = HMAC(finished_key, Hash(handshake_messages))
```

The server's Finished verifies that the server derived the same handshake keys (proving the ECDHE exchange succeeded and no messages were tampered with). The client's Finished does the same in the opposite direction.

After both Finished messages are exchanged, both sides derive **application traffic keys** from the Master Secret and begin encrypting application data (HTTP requests, etc.).

### 0.5-RTT Data

TLS 1.3 allows the server to send application data immediately after its Finished message, before receiving the client's Finished. This is called **0.5-RTT data**. The server is confident enough because:
- It has verified the ECDHE exchange (it computed the shared secret)
- It has integrity over the handshake via its own Finished

The client can process 0.5-RTT data as soon as it verifies the server's Finished. This shaves latency for the first server response.

---

## Perfect Forward Secrecy (PFS)

PFS means that compromising a server's long-term private key does not compromise past session keys.

```
  Session 1:  privC1 + pubS1 → shared_secret_1 → traffic_keys_1
  Session 2:  privC2 + pubS2 → shared_secret_2 → traffic_keys_2
  Session 3:  privC3 + pubS3 → shared_secret_3 → traffic_keys_3
                        ↑
                  All ephemeral.
              Discarded after each session.

  If server's LONG-TERM private key (from the certificate) is
  compromised:

    - Attacker can impersonate the server in FUTURE connections
    - Attacker CANNOT decrypt past sessions
    - Past session keys were derived from ephemeral ECDHE keys
      that no longer exist
```

This is why TLS 1.3 removed RSA key transport. In TLS 1.2 with RSA, the pre-master secret was encrypted with the server's certificate public key. Compromising that key let an attacker decrypt every past session they had recorded. With mandatory ECDHE in TLS 1.3, this attack is impossible.

---

## Man-in-the-Middle (MITM) Prevention

The certificate chain prevents MITM attacks through a binding between identity and the ECDHE exchange:

```
  Without certificates (vulnerable to MITM):

  Client                  Attacker                Server
    |                        |                       |
    | -- pubC -->            |                       |
    |           pubC_fake -> | -- pubA_fake -------> |
    |                        | <-- pubS ------------ |
    | <-- pubA_fake -------- |                       |
    |                        |                       |
    | shared_1 = DH(privC, pubA_fake)                |
    |           shared_2 = DH(privA, pubS)           |
    |                                                |
    | Attacker decrypts with shared_1,               |
    | re-encrypts with shared_2                      |

  With certificates (MITM prevented):

  Client                  Attacker                Server
    |                        |                       |
    | -- pubC -->            |                       |
    |           pubC_fake -> | -- pubA_fake -------> |
    |                        | <-- pubS, Cert, ----  |
    |                        |     CertVerify        |
    | <-- pubA_fake, ???     |                       |
    |                        |                       |
    | Attacker cannot produce a valid CertificateVerify
    | because they don't have the server's private key
    | matching the certificate. Client rejects.
```

The `CertificateVerify` signs the **handshake transcript** including the `key_share` values. An attacker substituting their own key share would change the transcript hash, making the signature invalid. The attacker cannot forge a valid signature because they don't possess the server's certificate private key.

---

## 0-RTT Resumption (PSK)

TLS 1.3 supports 0-RTT resumption for repeat connections. After a successful handshake, the server can send a `NewSessionTicket` containing a Pre-Shared Key (PSK). On the next connection:

```
Client                                             Server
  |                                                   |
  |  -- ClientHello + key_share + psk + early_data -> |
  |     (application data sent immediately!)           |
  |                                                   |
  |  <-- ServerHello + {EncryptedExtensions} + ...     |
  |  <-- {Finished}                                    |
  |  -- {Finished} -------------------------------->   |
```

> **Warning:** 0-RTT data is **not forward-secret** (it's encrypted under the PSK, not a fresh ECDHE) and is **replayable**. An attacker who captures the ClientHello + early data can replay it. Servers must ensure 0-RTT data is idempotent (e.g., safe for GET requests, dangerous for POST). RFC 8446 Section 8 discusses anti-replay mechanisms.

---

## PKCE is NOT Part of TLS

PKCE (Proof Key for Code Exchange, RFC 7636) is an OAuth 2.0 extension for preventing authorization code interception attacks. It operates at the **application layer** (HTTP) and has nothing to do with TLS. The confusion sometimes arises because both TLS and PKCE involve "keys" and "codes," but they exist at completely different layers:

| | TLS 1.3 | PKCE |
|---|---|---|
| Layer | Transport (between TCP and HTTP) | Application (OAuth 2.0) |
| Purpose | Encrypted channel + server authentication | Prevent auth code interception |
| Keys | Ephemeral ECDHE + certificate key pairs | `code_verifier` / `code_challenge` (random string + SHA-256) |
| Spec | RFC 8446 | RFC 7636 |

For OAuth and PKCE details, see [[notes/AuthNZ/OIDC_Oauth|OIDC & OAuth]].

---

## Inspecting a TLS 1.3 Handshake

### With OpenSSL

```bash
# Connect and show handshake details
openssl s_client -connect example.com:443 -tls1_3 -msg

# Show only the certificate chain
openssl s_client -connect example.com:443 -showcerts </dev/null 2>/dev/null | \
  openssl x509 -text -noout
```

### With curl

```bash
# Verbose output showing TLS handshake
curl -vvv https://example.com 2>&1 | grep -E '^\*'

# Output includes:
# * TLSv1.3 (OUT), TLS handshake, Client hello (1):
# * TLSv1.3 (IN), TLS handshake, Server hello (2):
# * TLSv1.3 (IN), TLS handshake, Encrypted Extensions (8):
# * TLSv1.3 (IN), TLS handshake, Certificate (11):
# * TLSv1.3 (IN), TLS handshake, CERT verify (15):
# * TLSv1.3 (IN), TLS handshake, Finished (20):
# * TLSv1.3 (OUT), TLS handshake, Finished (20):
# * SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
```

### With Wireshark

Apply the display filter `tls.handshake` to see handshake messages. In TLS 1.3, you will only see ClientHello and ServerHello in plaintext. Everything after ServerHello appears as `Application Data` (encrypted with handshake keys). To decrypt, you need the `SSLKEYLOGFILE`:

```bash
# Tell the client to dump per-session keys
export SSLKEYLOGFILE=/tmp/tls-keys.log
curl https://example.com

# In Wireshark: Preferences → Protocols → TLS → (Pre)-Master-Secret log filename
# Point to /tmp/tls-keys.log
```

---

## Wire-Level Handshake Diagram (Byte-Level Detail)

This is the full annotated handshake as it appears on the wire. Curly braces `{}` denote encrypted messages. For the diagram in the context of a complete HTTPS connection (including TCP and HTTP), see [[notes/Networking/https-tcp-tls-flow-content-length-vs-chunked-vs-http2|End-to-End HTTPS Flow]].

```
Client                                                       Server
  |                                                              |
  |---- ClientHello ------------------------------------------>  |
  |   TLS Record: ContentType=0x16 (Handshake)                  |
  |     Version: TLS 1.0 (0x0301) [middlebox compat]            |
  |     Handshake Type: ClientHello (0x01)                       |
  |     Fields:                                                  |
  |       legacy_version: TLS 1.2 (0x0303)                      |
  |       random: 32 bytes of client random                      |
  |       session_id: 32 bytes [middlebox compat]                |
  |       cipher_suites: [                                       |
  |         TLS_AES_256_GCM_SHA384 (0x1302)                     |
  |         TLS_AES_128_GCM_SHA256 (0x1301)                     |
  |         TLS_CHACHA20_POLY1305_SHA256 (0x1303)               |
  |       ]                                                      |
  |       extensions:                                            |
  |         supported_versions: [TLS 1.3 (0x0304)]              |
  |         key_share: x25519 public key (32 bytes)              |
  |         supported_groups: [x25519, secp256r1]                |
  |         signature_algorithms: [                              |
  |           ecdsa_secp256r1_sha256,                            |
  |           rsa_pss_rsae_sha256                                |
  |         ]                                                    |
  |         server_name: files.example.com (SNI)                 |
  |         alpn: [h2, http/1.1]                                 |
  |                                                              |
  |<--- ServerHello -------------------------------------------  |
  |   TLS Record: ContentType=0x16 (Handshake)                  |
  |     Handshake Type: ServerHello (0x02)                       |
  |     Fields:                                                  |
  |       legacy_version: TLS 1.2 (0x0303)                      |
  |       random: 32 bytes of server random                      |
  |       session_id: echo of client's session_id                |
  |       cipher_suite: TLS_AES_256_GCM_SHA384 (0x1302)         |
  |       extensions:                                            |
  |         supported_versions: TLS 1.3 (0x0304)                |
  |         key_share: x25519 server public key (32 bytes)       |
  |                                                              |
  |   [ChangeCipherSpec -- middlebox compat, ignored by TLS 1.3]|
  |                                                              |
  |   ~~~ All following messages encrypted with handshake keys ~~|
  |                                                              |
  |<--- {EncryptedExtensions} ---------------------------------  |
  |       alpn: h2                                               |
  |                                                              |
  |<--- {Certificate} ----------------------------------------  |
  |       server cert chain (files.example.com)                  |
  |       X.509 leaf cert + intermediate CA cert                 |
  |                                                              |
  |<--- {CertificateVerify} ----------------------------------  |
  |       signature over handshake transcript hash               |
  |       proves server holds the certificate's private key      |
  |                                                              |
  |<--- {Finished} -------------------------------------------  |
  |       HMAC over entire handshake transcript                  |
  |                                                              |
  |   --- Server can now send 0.5-RTT application data ---       |
  |                                                              |
  |---- {Finished} ------------------------------------------->  |
  |       HMAC over entire handshake transcript                  |
  |       (client proves it derived the same keys)               |
  |                                                              |
  |   === TLS 1.3 handshake complete: 1-RTT ===                 |
  |   === Both sides now have application traffic keys ===       |
```

---

## Related

- [[notes/Networking/https-tcp-tls-flow-content-length-vs-chunked-vs-http2|End-to-End HTTPS Flow: Content-Length vs Chunked vs HTTP/2]]
- [[notes/Networking/proxies-and-tls-termination|Proxies & TLS Termination]]
- [[notes/AuthNZ/self_signed_certificate|Understanding Self-Signed Certificates]]
- [[notes/AuthNZ/OIDC_Oauth|OIDC & OAuth (PKCE)]]
- [RFC 8446 -- The Transport Layer Security (TLS) Protocol Version 1.3](https://www.rfc-editor.org/rfc/rfc8446)
- [RFC 5869 -- HMAC-based Extract-and-Expand Key Derivation Function (HKDF)](https://www.rfc-editor.org/rfc/rfc5869)
- [RFC 7301 -- TLS ALPN Extension](https://www.rfc-editor.org/rfc/rfc7301)
- [RFC 6066 -- TLS Extensions (SNI)](https://www.rfc-editor.org/rfc/rfc6066)
- [x25519 -- RFC 7748](https://www.rfc-editor.org/rfc/rfc7748)

---

## Interview Prep

### Q: Walk through the entire TLS 1.3 handshake step by step. What happens in each message?

**A:** The TLS 1.3 handshake completes in 1-RTT with the following messages:

1. **ClientHello** (plaintext): Client sends its random, supported cipher suites, an ephemeral ECDHE public key (`key_share`), supported TLS versions (`supported_versions: 0x0304`), signature algorithms it can verify, and SNI.

2. **ServerHello** (plaintext): Server selects a cipher suite, sends its own ephemeral ECDHE public key in `key_share`, and confirms TLS 1.3 via `supported_versions`. Both sides now independently compute the ECDHE shared secret and derive handshake traffic keys using HKDF.

3. **EncryptedExtensions** (encrypted): Server sends non-cryptographic extensions like ALPN result. Encrypted because in TLS 1.2 these were plaintext and leaked information.

4. **Certificate** (encrypted): Server sends its X.509 certificate chain. Encrypted in TLS 1.3 (was plaintext in TLS 1.2), hiding the server's identity from passive eavesdroppers.

5. **CertificateVerify** (encrypted): Server signs the transcript hash of all handshake messages so far using the private key corresponding to the certificate's public key. This proves the server owns the certificate and that no messages were tampered with.

6. **Server Finished** (encrypted): HMAC over the handshake transcript using the finished key. Proves the server derived the correct handshake keys.

7. **Client Finished** (encrypted): Client sends its own HMAC, proving it derived the same keys. After this, both sides switch to application traffic keys.

---

### Q: How are session keys derived in TLS 1.3? Is the server's certificate public key used?

**A:** No. The certificate's public key is **never** used for key exchange in TLS 1.3. Session keys are derived entirely from an Ephemeral Diffie-Hellman exchange (ECDHE, typically x25519):

1. Client generates an ephemeral key pair and sends the public half in `key_share`
2. Server generates its own ephemeral key pair and sends the public half in `key_share`
3. Both sides compute `shared_secret = ECDHE(my_private, peer_public)`
4. The shared secret is fed into the HKDF key schedule along with handshake transcript hashes to derive handshake keys, then application keys

The certificate's public key is used **only** for authentication -- verifying the `CertificateVerify` signature to confirm the server is who it claims to be.

---

### Q: What is Perfect Forward Secrecy and how does TLS 1.3 guarantee it?

**A:** PFS means compromising a server's long-term private key (the certificate key) does not compromise past session keys. TLS 1.3 guarantees PFS because:

- Session keys are derived from **ephemeral** ECDHE key pairs generated fresh for each connection
- Ephemeral private keys are discarded after the handshake
- The long-term certificate key is only used for signing `CertificateVerify` (authentication), never for key transport
- An attacker with the certificate private key can impersonate the server in future connections but cannot retroactively decrypt recorded traffic

TLS 1.2 did NOT guarantee PFS -- if RSA key transport was used, the pre-master secret was encrypted directly with the certificate's public key, and compromising that key broke all past sessions.

---

### Q: Why is the server certificate encrypted in TLS 1.3 but was plaintext in TLS 1.2?

**A:** In TLS 1.2, the key exchange had to complete before encryption could begin, and the certificate was sent during the key exchange phase. In TLS 1.3, the client sends its ECDHE key share in the ClientHello and the server sends its in the ServerHello. After ServerHello, both sides can immediately derive handshake traffic keys and encrypt everything that follows -- including the Certificate. This hides the server's identity from passive eavesdroppers (though SNI in the ClientHello still leaks the hostname; Encrypted Client Hello / ECH, defined in a separate draft, addresses this).

---

### Q: How does the certificate chain of trust prevent MITM attacks?

**A:** The chain works as follows:

1. The server's leaf certificate is signed by an intermediate CA
2. The intermediate CA's certificate is signed by a root CA
3. The root CA is pre-installed in the client's trust store

An attacker performing MITM would need to substitute their own ECDHE public key. But then they cannot produce a valid `CertificateVerify` because they don't possess the private key matching a certificate that chains to a trusted root CA. The `CertificateVerify` signs the handshake transcript (which includes the key shares), so substituting a key share invalidates the signature. The client would detect the mismatch and abort.

---

### Q: What is the role of the `CertificateVerify` message specifically? Why isn't just sending the certificate enough?

**A:** The Certificate message contains a public document -- anyone can obtain a copy of a website's certificate. Simply presenting a certificate proves nothing about identity. The `CertificateVerify` message contains a signature over the handshake transcript hash, produced with the **private key** corresponding to the certificate's public key. This proves:

1. **Possession**: The server actually holds the private key (not just a copy of the public cert)
2. **Binding**: The signature covers the handshake transcript including key shares, so it's bound to this specific connection. Replaying a `CertificateVerify` from a different session would fail because the transcript hash would differ.

---

### Q: What checks does a client perform when validating a server's certificate?

**A:** The client performs these checks (in practice, libraries like OpenSSL, BoringSSL, or Go's `crypto/x509` do this):

1. **Signature verification**: Verify the leaf cert's signature using the issuer's (intermediate CA's) public key
2. **Chain building**: Walk up the chain, verifying each signature, until reaching a root CA in the trust store
3. **Hostname match**: The SNI hostname must match the certificate's Subject Common Name or a Subject Alternative Name (SAN)
4. **Validity period**: Current time must be within `notBefore` and `notAfter`
5. **Key usage**: The certificate must allow `digitalSignature`
6. **Revocation**: Check OCSP stapled response or CRL (Certificate Revocation List) if available
7. **Basic constraints**: Intermediate certs must have `CA:TRUE`; leaf certs must have `CA:FALSE`

---

### Q: Can you explain the difference between 1-RTT, 0.5-RTT data, and 0-RTT resumption?

**A:**

- **1-RTT**: The standard TLS 1.3 handshake. Client sends ClientHello, server responds with ServerHello through Finished, client sends Finished. One full round trip before application data flows in both directions.

- **0.5-RTT data**: The server can send application data (e.g., an HTTP response) immediately after its own Finished message, before receiving the client's Finished. This is safe because the server has already verified the ECDHE exchange. The client can process this data once it verifies the server's Finished.

- **0-RTT resumption**: On a repeat connection, the client uses a PSK from a previous session to encrypt early application data in the very first message (alongside ClientHello). The server can process it immediately. However, 0-RTT data is replayable (an attacker can resend the ClientHello + early data) and is not forward-secret (encrypted under PSK, not fresh ECDHE). Servers must treat 0-RTT data as potentially replayed and only accept idempotent operations.

---

### Q: Why are there version fields set to TLS 1.0 and TLS 1.2 in a TLS 1.3 handshake?

**A:** Middlebox compatibility. Deployed middleboxes (firewalls, load balancers, intrusion detection systems) inspect TLS headers and sometimes drop or interfere with connections that have unfamiliar version numbers. TLS 1.3 freezes the record layer version at `0x0301` (TLS 1.0) and the `legacy_version` field at `0x0303` (TLS 1.2). The actual version negotiation happens exclusively through the `supported_versions` extension. The `legacy_session_id` and `ChangeCipherSpec` message are also retained for the same reason -- to make TLS 1.3 connections look enough like TLS 1.2 to pass through broken middleboxes.

---

### Q: If SNI is sent in plaintext in ClientHello, can an eavesdropper see which website I'm connecting to?

**A:** Yes. The SNI extension in ClientHello is unencrypted in standard TLS 1.3. A passive eavesdropper (or ISP, corporate firewall, etc.) can see the hostname. This is one of the remaining privacy gaps. **Encrypted Client Hello (ECH)**, formerly called ESNI, is a draft extension that encrypts the ClientHello (including SNI) using a public key published in the server's DNS records. As of 2026, ECH support is growing but not yet universally deployed.
