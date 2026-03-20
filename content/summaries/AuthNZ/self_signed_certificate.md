---
title: "Summary: Understanding Self-Signed Certificates"
---

> **Full notes:** [[notes/AuthNZ/self_signed_certificate|Understanding Self-Signed Certificates -->]]

## Key Concepts

**What it is:** A certificate where the issuer and subject are the same entity. You sign your own public key with your own private key, instead of having a CA do it.

**How it works:** Generate a key pair, use the private key to sign the certificate data (which contains the public key). To verify, a client extracts the public key from the cert and checks the signature -- the math is self-referential.

**Why browsers reject it:** The cryptographic integrity is valid (signature checks out), but there is no **identity trust**. A browser's Root Store contains pre-installed CA certificates. If no trusted CA vouches for the certificate, the browser warns: "I can verify the math, but not who is behind it."

## Quick Reference

**Lifecycle:**

| Phase | Component | Action |
|-------|-----------|--------|
| Generation | RSA/ECC algorithm | Create private/public key pair |
| Creation | Private key | Sign identity data + public key --> `.crt` |
| Verification | Public key (in cert) | Client verifies signature on the cert |
| Validation | Root Store | Client checks if a trusted CA signed it |

**One-liner to generate:**

```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
```

**Inspect a certificate:**

```bash
openssl x509 -in cert.pem -text -noout
# Look for: Subject == Issuer (confirms self-signed)
```

**Verify the self-signature:**

```bash
openssl verify -CAfile cert.pem cert.pem
# Returns OK if the signature is mathematically valid
```

## Key Takeaways

- Self-signed means the private key signs a certificate containing its own corresponding public key -- issuer and subject are identical.
- The math (cryptographic integrity) is perfectly valid. The problem is **trust** -- no third party vouches for the identity.
- Browsers warn "Not Secure" because the cert is not in their Root Store, not because the signature is broken.
- Use `-x509` flag in OpenSSL to produce a self-signed cert directly instead of a CSR.
- Self-signed certs are fine for development/testing and internal services where you control the trust store.
