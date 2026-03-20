---
title: "Summary: Understanding Self-Signed Certificates"
---

> **Full notes:** [[notes/AuthNZ/self_signed_certificate|Understanding Self-Signed Certificates -->]]

## Key Concepts

### Which Key Signs a Self-Signed Certificate?

The entity's own **private key** signs the certificate data. In a traditional CA-signed setup, you send a CSR to the CA and they sign it with their private key. In a self-signed scenario, you act as your own authority -- your private key vouches for the public key contained within the certificate. With OpenSSL, this is done in one step using `openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes`. The `-x509` flag tells OpenSSL to produce a self-signed certificate directly instead of a CSR. The `-newkey rsa:4096` creates the private key, and OpenSSL uses it to sign the certificate.

### How the Certificate Verifies Itself

Self-signed certificates verify through a mathematical loop. The certificate contains the public key that corresponds to the private key used to sign it. A client (e.g., browser) checks that the Issuer and Subject fields are identical (confirming self-signed), extracts the public key from the certificate, and uses that public key to verify the digital signature. If the signature is valid, it proves the certificate hasn't been altered since it was signed by the owner of the matching private key. You can inspect this loop with `openssl x509 -in cert.pem -text -noout` -- look for Subject and Issuer being identical.

### Why Browsers Show "Not Secure"

There is a fundamental difference between **cryptographic integrity** and **identity trust**. The self-verification proves the certificate wasn't tampered with and that the producer of the public key holds the matching private key -- the math is perfect. However, the browser has no way of knowing *who* created that key pair. Anyone can create a self-signed certificate claiming any identity. Because the certificate is not signed by a Root Authority in the browser's pre-installed Root Store, the browser warns: "I can verify the math, but I cannot verify the identity behind it."

### Lifecycle Summary

| Phase | Component Used | Action |
|-------|---------------|--------|
| **Generation** | RSA/ECC Algorithm | Create a private/public key pair |
| **Creation** | Private Key | Sign identity data + public key to produce the `.crt` file |
| **Verification** | Public Key (inside cert) | Client verifies the signature on the same cert |
| **Validation** | Root Store / Trust Anchor | Client checks if a trusted third-party CA signed the cert |

### Manual Verification

You can verify a self-signed certificate's signature using its own public key:

```bash
openssl verify -CAfile cert.pem cert.pem
# Returns OK if the self-signature is mathematically valid
```

The `-CAfile` flag tells OpenSSL to use the certificate itself as the "trusted authority" for verification.

## Quick Reference

**Generate a self-signed certificate (one command):**

```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
```

**Inspect a certificate:**

```bash
openssl x509 -in cert.pem -text -noout
# Subject == Issuer confirms self-signed
```

**Verify the self-signature:**

```bash
openssl verify -CAfile cert.pem cert.pem
# OK = mathematically valid
```

**Integrity vs Trust:**

| | Cryptographic Integrity | Identity Trust |
|---|------------------------|----------------|
| What it proves | Certificate wasn't tampered with | Who created the certificate |
| Self-signed result | Pass (math works) | Fail (no trusted CA vouches) |
| Browser behavior | Signature valid | "Not Secure" warning |

## Key Takeaways

- Self-signed means the private key signs a certificate containing its own corresponding public key -- issuer and subject are identical.
- The math (cryptographic integrity) is perfectly valid. The problem is **trust** -- no third party vouches for the identity.
- Browsers warn "Not Secure" because the cert is not in their Root Store, not because the signature is broken.
- Use `-x509` flag in OpenSSL to produce a self-signed cert directly instead of generating a CSR.
- Self-signed certs are appropriate for development/testing and internal services where you control the trust store.
- Manual verification: `openssl verify -CAfile cert.pem cert.pem` -- uses the cert as its own trusted authority.
