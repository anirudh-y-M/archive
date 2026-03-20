---
title: "Summary: KMS & GitHub App Private Key Security"
---

> **Full notes:** [[notes/Git/kms-github-app|KMS & GitHub App Private Key Security →]]

## Key Concepts

**KMS (Key Management Service)** centralizes cryptographic key storage and operations. Your app never sees raw key material -- all encrypt/decrypt/sign operations happen inside KMS, backed by HSMs.

**The use case:** Instead of storing a GitHub App private key as a file or env var (where it can be stolen if the app is compromised), import it into Cloud KMS. The app calls KMS to sign JWTs -- the key never enters application memory.

**The setup flow:**
1. Convert GitHub's PEM key to PKCS#8 DER format
2. Create a KMS Key Ring and Import Job
3. Create a CryptoKey (`ASYMMETRIC_SIGN`, `import_only`)
4. Import the private key, then delete the local copy
5. Grant `roles/cloudkms.signer` to the service account (least privilege)
6. App uses KMS-backed signer with `ghinstallation` library to sign JWTs

## Quick Reference

```
App starts
  |
  v
Create KMS-backed signer (no key in memory)
  |
  v
ghinstallation builds JWT claims --> sends to KMS for signing
  |
  v
Signed JWT --> GitHub API --> installation access token (1hr)
  |
  v
go-github client uses token for all API calls
(auto-refreshes on expiry)
```

| Without KMS | With KMS |
|-------------|----------|
| Private key in env var or file | Key only inside KMS |
| Full key theft if app compromised | Attacker can only make signing requests (rate-limited, audit-logged) |
| No audit trail of key usage | Cloud Audit Logs for every sign operation |

**Key Terraform resources:** `google_kms_key_ring`, `google_kms_crypto_key` (purpose: ASYMMETRIC_SIGN, import_only: true), `google_kms_crypto_key_iam_member` (role: cloudkms.signer)

## Key Takeaways

- KMS ensures the private key never enters your application runtime -- even a full compromise can't exfiltrate it
- `roles/cloudkms.signer` is the least-privilege IAM role for signing-only access
- The `ghinstallation` Go library natively supports custom signers, making KMS integration straightforward
- Installation tokens auto-refresh (1-hour validity) with no manual renewal logic needed
- Always delete the local key file after importing into KMS
