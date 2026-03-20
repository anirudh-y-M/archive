---
title: "Summary: Cert-manager + Webhooks + Versioning"
---

> **Full notes:** [[notes/kubebuilder/multi_version_webhook|Cert-manager + webhooks + versioning - Q&A notes →]]

## Key Concepts

- **Webhook TLS setup** -- The webhook Pod holds the TLS cert/key (from a Secret), and the `WebhookConfiguration` holds the CA cert in `caBundle` so the API server trusts the endpoint. With cert-manager, a `Certificate` resource writes a TLS Secret that gets mounted into the Pod.

- **Secret namespace restriction** -- Secrets are namespaced; Pods can only mount Secrets from their own namespace. If the cert is in another namespace, either re-issue the Certificate in the webhook's namespace or sync the Secret.

- **CRD storage version** -- The version persisted in etcd is determined by `spec.versions[].storage: true`, not by what you `kubectl apply`. Objects are stored in protobuf/binary and may be encrypted.

- **`matchPolicy: Equivalent` vs `Exact`** -- With `Equivalent` (default), the API server can convert objects between served versions to match a webhook. A webhook registered for v2 can fire on v1 requests. With `Exact`, only the exact version in the request matches.

- **Version mismatch pitfall** -- If you set `matchPolicy: Exact` and list multiple `apiVersions` in the webhook rules, but the handler only decodes one version, requests for the other version will fail with decode errors.

## Quick Reference

```
kubectl apply (v1 YAML)
  |
  v
API Server
  |
  +-- matchPolicy: Equivalent?
  |     YES --> convert v1 -> v2 --> call v2 webhook
  |     NO (Exact) --> call webhook only if rules include v1
  |
  +-- Mutating Webhook --> (maybe convert) --> Validating Webhook
  |
  +-- Convert to storage version --> etcd
```

| Pattern | matchPolicy | apiVersions in rules | Handler |
|---|---|---|---|
| Single-version (recommended) | Equivalent | Only the version handler expects | One decoder |
| Version-specific | Exact | Each version listed | Separate handlers per version |
| Multi-version handler | Exact | Multiple versions | Detects request version, decodes accordingly |

```
TLS Flow with cert-manager
============================
cert-manager --> Certificate CR --> TLS Secret (tls.crt, tls.key)
                                        |
                      +-----------------+-----------------+
                      |                                   |
               Mounted in webhook Pod          CA cert in caBundle
               (serves HTTPS)                  (WebhookConfiguration)
```

## Key Takeaways

- Webhook TLS requires the cert in the Pod and the CA in `caBundle` on the WebhookConfiguration -- two separate places.
- `matchPolicy: Equivalent` (default) means a webhook registered for one CRD version can fire on requests for any equivalent version after conversion.
- Setting `matchPolicy: Exact` with multiple `apiVersions` but a single-version decoder is a common mistake that causes decode failures.
- The safest pattern: register the webhook for one version only and let `matchPolicy: Equivalent` handle conversion.
- CRD storage version is set by the `storage: true` flag, independent of what version clients use in requests.
