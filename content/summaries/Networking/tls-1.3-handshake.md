---
title: "Summary: TLS 1.3 Handshake"
---

> **Full notes:** [[notes/Networking/tls-1.3-handshake|TLS 1.3 Handshake: Key Exchange, Authentication, and Certificate Chain of Trust -->]]

## Key Concepts

**TLS 1.3 (RFC 8446)** -- Complete redesign of TLS. 1-RTT handshake, mandatory forward secrecy, only 5 AEAD cipher suites, server certificate encrypted, RSA key transport removed.

**1-RTT Handshake Flow** -- ClientHello (plaintext: client random, ECDHE public key, cipher suites, SNI) -> ServerHello (plaintext: server ECDHE public key, selected suite) -> both compute shared secret -> everything after is encrypted: EncryptedExtensions, Certificate, CertificateVerify, Finished.

**Key Exchange (ECDHE)** -- Session keys come from ephemeral Diffie-Hellman, NOT from the certificate. Both sides generate throwaway key pairs, exchange public halves, compute identical shared secret. HKDF key schedule derives handshake keys, then application keys.

**Certificate = Authentication Only** -- The certificate's public key verifies the CertificateVerify signature (proof the server holds the private key). It is NOT used to encrypt anything. Common misconception: "client encrypts data with server's public key" -- this is wrong for TLS 1.3.

**CertificateVerify** -- Server signs the handshake transcript hash with its certificate private key. Proves identity and binds the signature to this specific connection (prevents replay).

**Chain of Trust** -- Leaf cert (signed by intermediate CA) -> Intermediate cert (signed by root CA) -> Root CA (pre-installed in client trust store). Client walks the chain verifying each signature.

**Perfect Forward Secrecy** -- Ephemeral ECDHE keys are discarded after each session. Compromising the server's long-term certificate key cannot decrypt past sessions.

**0-RTT Resumption** -- Uses PSK from a previous session to send early data in the first message. Faster but NOT forward-secret and IS replayable. Only for idempotent operations.

## Quick Reference

```
ClientHello  ------->  (plaintext: ECDHE pub, cipher suites, SNI)
             <-------  ServerHello  (plaintext: ECDHE pub, selected suite)
  ~~~ compute shared secret, derive handshake keys ~~~
             <-------  {EncryptedExtensions}  (encrypted)
             <-------  {Certificate}          (encrypted)
             <-------  {CertificateVerify}    (encrypted)
             <-------  {Finished}             (encrypted)
Finished     ------->                         (encrypted)
  ~~~ derive application traffic keys ~~~
  <========= Application Data ==========>
```

| TLS 1.2 vs 1.3        | TLS 1.2           | TLS 1.3           |
|------------------------|-------------------|--------------------|
| Round trips            | 2-RTT             | 1-RTT              |
| Forward secrecy        | Optional          | Mandatory          |
| Certificate visibility | Plaintext         | Encrypted          |
| RSA key transport      | Supported         | Removed            |
| Cipher suites          | 37+               | 5 (AEAD only)      |

**Version fields:** Record layer = 0x0301 (TLS 1.0), legacy_version = 0x0303 (TLS 1.2) -- both frozen for middlebox compatibility. Real version via `supported_versions` extension.

**Client validation checks:** signature chain, hostname match (SAN/CN), validity dates, key usage, revocation (OCSP/CRL), basic constraints.

## Key Takeaways

- Session keys are from ECDHE, not the certificate. The certificate only authenticates. This is the most commonly misunderstood aspect.
- TLS 1.3 mandates forward secrecy -- compromising the server's long-term key cannot decrypt past traffic.
- Everything after ServerHello is encrypted (including the certificate), hiding server identity from passive eavesdroppers.
- SNI in ClientHello is still plaintext -- an eavesdropper can see which hostname you're connecting to. ECH (Encrypted Client Hello) addresses this.
- 0-RTT is fast but replayable and not forward-secret. Only use for idempotent requests (GET, not POST).
