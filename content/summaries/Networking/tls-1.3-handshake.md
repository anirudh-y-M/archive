---
title: "Summary: TLS 1.3 Handshake"
---

> **Full notes:** [[notes/Networking/tls-1.3-handshake|TLS 1.3 Handshake: Key Exchange, Authentication, and Certificate Chain of Trust -->]]

## Key Concepts

### What Changed from TLS 1.2 to TLS 1.3

TLS 1.3 (RFC 8446) is a complete redesign. It reduces the handshake from 2-RTT to 1-RTT, mandates forward secrecy (ephemeral keys always), removes RSA key transport, encrypts the server certificate (was plaintext in 1.2), reduces cipher suites from 37+ to 5 AEAD-only suites, and removes renegotiation, compression (CRIME attack), and static RSA. The removal of RSA key transport is critical -- in TLS 1.2 with RSA, compromising the server's private key allowed decrypting all past recorded sessions.

| Aspect | TLS 1.2 | TLS 1.3 |
|---|---|---|
| Round trips | 2-RTT | 1-RTT (0-RTT optional) |
| Key exchange | RSA or (EC)DHE | ECDHE only |
| Forward secrecy | Optional | Mandatory |
| Certificate | Plaintext | Encrypted |
| Cipher suites | 37+ | 5 (AEAD only) |

### The Full 1-RTT Handshake Flow

Only ClientHello and ServerHello are plaintext. Everything after ServerHello is encrypted with handshake traffic keys.

```
ClientHello  ------->  (plaintext: random, ECDHE pub, cipher suites, SNI)
             <-------  ServerHello  (plaintext: random, ECDHE pub, selected suite)
  ~~~ compute shared secret, derive handshake keys ~~~
             <-------  {EncryptedExtensions}  (ALPN, etc.)
             <-------  {Certificate}          (X.509 chain)
             <-------  {CertificateVerify}    (signature over transcript)
             <-------  {Finished}             (HMAC over transcript)
Finished     ------->                         (HMAC over transcript)
  ~~~ derive application traffic keys ~~~
  <========= Application Data ==========>
```

### ClientHello Wire-Level Details

Wrapped in a TLS Record (ContentType: 0x16, Version: 0x0301 for middlebox compat). The `legacy_version` is frozen at 0x0303 (TLS 1.2) -- real version is negotiated via the `supported_versions` extension (0x0304 = TLS 1.3). Other critical extensions: `key_share` (client's ephemeral ECDHE public key), `supported_groups` (x25519, secp256r1, etc.), `signature_algorithms` (for verifying CertificateVerify), `server_name` (SNI, plaintext), `alpn` (h2, http/1.1), `psk_key_exchange_modes` (for resumption).

### ServerHello

Server selects a cipher suite, sends its ephemeral ECDHE public key in `key_share`, and confirms TLS 1.3 via `supported_versions: 0x0304`. After ServerHello, both sides have each other's ECDHE public keys and independently compute the shared secret.

### TLS 1.3 Cipher Suites

Only 5 suites, specifying AEAD + hash only (key exchange is always ECDHE via extensions):

| Code | Name | AEAD | Hash |
|---|---|---|---|
| 0x1301 | TLS_AES_128_GCM_SHA256 | AES-128-GCM | SHA-256 |
| 0x1302 | TLS_AES_256_GCM_SHA384 | AES-256-GCM | SHA-384 |
| 0x1303 | TLS_CHACHA20_POLY1305_SHA256 | ChaCha20-Poly1305 | SHA-256 |

### Key Exchange: ECDHE (Not the Certificate)

The server's certificate public key is NOT used to encrypt session keys or data. Session keys come entirely from an ephemeral Diffie-Hellman exchange. Both sides generate throwaway key pairs, exchange public halves in key_share, and compute identical shared secrets: `x25519(privC, pubS) == x25519(privS, pubC)`. An eavesdropper seeing both public keys cannot compute the shared secret.

### HKDF Key Schedule

The shared secret feeds into HKDF (RFC 5869) through a structured derivation: Early Secret (from PSK or 0) -> Handshake Secret (from ECDHE shared secret) -> Master Secret. At each step, the handshake transcript hash is mixed in, binding keys to the specific handshake. Three distinct key sets: handshake traffic keys (encrypt Certificate, CertificateVerify, Finished), application traffic keys (encrypt app data), and resumption keys (for NewSessionTicket).

### The Certificate: Authentication, Not Encryption

The certificate contains an X.509 chain with: Subject (CN), Issuer, validity period, Subject Public Key (ECDSA or RSA), Subject Alt Names, Key Usage, and the issuer's signature. The public key has ONE job: verifying the CertificateVerify signature. Common misconception: "client encrypts data with server's public key" -- this was true for TLS 1.2 RSA key transport but is completely wrong for TLS 1.3.

### CertificateVerify: Proof of Private Key Possession

The server signs the handshake transcript hash with its certificate private key. The client verifies using the certificate's public key. This proves: (1) the server possesses the matching private key, and (2) no handshake message was tampered with (because the transcript hash is signed).

### Certificate Chain of Trust

The server sends a chain: Leaf cert (signed by intermediate CA) -> Intermediate cert (signed by root CA). Root CA is NOT sent -- it's pre-installed in the client's trust store. Client validation checks: signature chain verification, hostname match (SAN/CN vs SNI), validity dates, key usage (`digitalSignature`), revocation (OCSP/CRL), basic constraints (CA:TRUE for intermediates, CA:FALSE for leaf).

| Platform | Trust Store Location |
|---|---|
| macOS | System Keychain |
| Linux (Debian) | `/etc/ssl/certs/ca-certificates.crt` |
| Firefox | Mozilla NSS (independent of OS) |
| Go programs | OS trust store / `crypto/x509.SystemCertPool()` |
| Node.js | OpenSSL CA bundle / `NODE_EXTRA_CA_CERTS` |

### Finished Messages: Handshake Integrity

Both sides send HMAC over the handshake transcript using the finished key. Proves both derived the same handshake keys and no messages were tampered with. After both Finished messages, both sides derive application traffic keys. The server can send **0.5-RTT data** (application data) immediately after its Finished, before receiving the client's Finished.

### Perfect Forward Secrecy (PFS)

Ephemeral ECDHE key pairs are generated fresh per session and discarded afterward. Compromising the server's long-term certificate key lets an attacker impersonate the server in future connections, but CANNOT decrypt past sessions because past session keys were derived from ephemeral keys that no longer exist.

### MITM Prevention

Without certificates, an attacker can substitute their own ECDHE key and decrypt/re-encrypt traffic. With certificates, the attacker cannot produce a valid CertificateVerify because they don't have the server's certificate private key. The CertificateVerify signs the handshake transcript including key_share values -- substituting a key share changes the transcript hash, making the signature invalid.

### 0-RTT Resumption (PSK)

After a successful handshake, the server sends a NewSessionTicket with a PSK. On the next connection, the client sends ClientHello + key_share + PSK + early application data in the first message. Warning: 0-RTT data is NOT forward-secret (encrypted under PSK, not fresh ECDHE) and IS replayable. Only for idempotent operations (GET, not POST).

### PKCE is NOT Part of TLS

PKCE (RFC 7636) is an OAuth 2.0 extension at the application layer. TLS operates at the transport layer. They have nothing in common despite both involving "keys" and "codes."

### Inspecting TLS 1.3 Handshakes

With `openssl s_client -connect ... -tls1_3 -msg`, `curl -vvv`, or Wireshark (filter: `tls.handshake`). In TLS 1.3, only ClientHello and ServerHello are visible in Wireshark; everything after appears as encrypted Application Data. Use `SSLKEYLOGFILE` to dump per-session keys for decryption.

### Version Field Compatibility

Record layer version is 0x0301 (TLS 1.0), `legacy_version` is 0x0303 (TLS 1.2) -- both frozen for middlebox compatibility. Real version is negotiated exclusively through `supported_versions` extension. `legacy_session_id` and ChangeCipherSpec are also retained for the same reason.

## Quick Reference

```
ClientHello  ------->  (plaintext: ECDHE pub, suites, SNI, supported_versions)
             <-------  ServerHello  (plaintext: ECDHE pub, selected suite)
  ~~~ ECDHE shared secret -> HKDF -> handshake keys ~~~
             <-------  {EncryptedExtensions}  (encrypted)
             <-------  {Certificate}          (encrypted -- was plaintext in 1.2!)
             <-------  {CertificateVerify}    (encrypted)
             <-------  {Finished}             (encrypted)
Finished     ------->                         (encrypted)
  ~~~ HKDF -> application traffic keys ~~~
  <========= Application Data ==========>
```

| Key Schedule Stage | Derives |
|---|---|
| Early Secret (PSK or 0) | Early traffic keys (0-RTT) |
| Handshake Secret (ECDHE) | Handshake traffic keys |
| Master Secret | Application traffic keys, resumption keys |

**Client validation:** signature chain -> hostname match (SAN/CN) -> validity dates -> key usage -> revocation (OCSP/CRL) -> basic constraints

**Version fields:** Record = 0x0301 (TLS 1.0), legacy_version = 0x0303 (TLS 1.2), real = `supported_versions: 0x0304` (TLS 1.3). All frozen for middlebox compat.

## Key Takeaways

- Session keys are from ECDHE, not the certificate. The certificate only authenticates (verifies CertificateVerify). This is the most commonly misunderstood aspect.
- TLS 1.3 mandates forward secrecy -- compromising the server's long-term key cannot decrypt past traffic because ephemeral ECDHE keys are discarded per session.
- Everything after ServerHello is encrypted (including the certificate), hiding server identity from passive eavesdroppers. TLS 1.2 sent certificates in plaintext.
- SNI in ClientHello is still plaintext -- an eavesdropper can see which hostname you're connecting to. ECH (Encrypted Client Hello) addresses this.
- 0-RTT is fast but replayable and not forward-secret. Only use for idempotent requests.
- Version fields (0x0301, 0x0303) are frozen for middlebox compatibility. Real negotiation is via `supported_versions` extension.
- CertificateVerify proves private key possession AND binds the signature to this specific handshake (prevents replay from other sessions).
- HKDF key schedule mixes in transcript hashes at each step, so any tampered message causes key derivation to diverge and Finished verification to fail.
