---
title: "Summary: Cert-manager + Webhooks + Versioning"
---

> **Full notes:** [[notes/kubebuilder/multi_version_webhook|Cert-manager + webhooks + versioning - Q&A notes →]]

## Key Concepts

### Webhook TLS Certificate Placement

Webhook TLS requires certificates in **two places**: (1) the **TLS cert/key** goes into the webhook Pod as a mounted Kubernetes Secret, and (2) the **CA certificate** (that signed the server cert) goes into the `WebhookConfiguration` under `webhooks[].clientConfig.caBundle` so the API server can verify the webhook endpoint. These are two separate concerns -- the Pod needs to serve HTTPS, and the API server needs to trust it.

### Cert-manager TLS Setup

With cert-manager installed (self-signed Issuer), you create a `Certificate` resource that writes a TLS Secret (e.g., `webhook-server-tls`) containing `tls.crt` and `tls.key`. This Secret is mounted into the webhook Deployment at a path like `/tls`, and the webhook server is configured to use those files for HTTPS. The certificate **must include DNS SANs** matching the Service name the API server calls, e.g., `webhook-svc.<ns>.svc` and `webhook-svc.<ns>.svc.cluster.local`.

```
TLS Flow with cert-manager
============================
cert-manager
  |
  v
Certificate CR  --->  TLS Secret (tls.crt, tls.key)
                           |
         +-----------------+-----------------+
         |                                   |
  Mounted in webhook Pod              CA cert placed in caBundle
  (Pod serves HTTPS on /tls)          (WebhookConfiguration)
         |                                   |
         v                                   v
  Webhook server listens            API server trusts endpoint
```

### Secret Namespace Restriction

Kubernetes Secrets are **namespaced**, and Pods can only mount Secrets **from their own namespace**. If the TLS Secret was created in a different namespace, the webhook Pod cannot use it directly. The fix is to either **re-issue the Certificate in the webhook's namespace** (preferred -- supports auto-rotation via cert-manager) or **copy/sync** the Secret into the correct namespace (one-time copy won't auto-rotate unless a sync mechanism is used).

### CRD Storage Version and etcd

Objects in etcd are stored in the CRD's **storage version** (determined by `spec.versions[].storage: true`), not the version used in `kubectl apply`. The actual storage format is often protobuf/binary and may be encrypted at rest. Direct etcd reads are possible but impractical for version inspection. The `status.storedVersions` field on the CRD tracks which versions have historically been persisted.

### matchPolicy: Equivalent vs Exact

Admission webhooks match on **resources**, and `matchPolicy` controls how version matching works:

- **`Equivalent`** (default): The API server treats all served versions of the same resource as equivalent. A webhook registered for `v2` can fire on a `v1` request -- the API server **converts** the object to `v2` before calling the webhook. This means `apiVersions: [v2]` in webhook rules does **not** prevent `v1` requests from triggering it.

- **`Exact`**: Only the exact version in the request matches the webhook rules. No conversion is done for webhook matching. A `v1` request will only fire webhooks whose rules explicitly include `v1`.

### Why v2 Webhook Fired on v1 Apply

Even with `apiVersions: [v2]` explicitly set in webhook rules, applying a `v1` YAML triggered the webhook. This is because `matchPolicy: Equivalent` (the default) causes the API server to match the `v1` request to the `v2` webhook rule (they're the same resource, just different versions), convert the object to `v2`, and call the webhook.

### The Exact + Multi-Version Decode Failure

Setting `matchPolicy: Exact` with `apiVersions: [v1alpha1, v1]` in the rules, but having a webhook handler that only decodes `v1alpha1`, causes a failure. With Exact matching, the API server sends the `v1` object **as-is** (no conversion). The webhook handler tries to decode it into `*v1alpha1.Memcached` and fails with `unable to decode ... v1 ... into *v1alpha1.Memcached`.

```
Exact Mode Failure Scenario
==============================
kubectl apply (v1 YAML)
  |
  v
API Server (matchPolicy: Exact)
  |
  +-- Rules say: apiVersions: [v1alpha1, v1]
  +-- Request is v1, matches "v1" in rules
  +-- Sends v1 object to webhook (NO conversion)
  |
  v
Webhook Handler
  +-- Tries to decode into *v1alpha1.Memcached
  +-- FAILS: v1 object cannot decode into v1alpha1 type
  +-- Admission denied with decode error
```

### Three Valid Fix Patterns

| Pattern | matchPolicy | apiVersions in Rules | Handler | Tradeoff |
|---|---|---|---|---|
| **Single-version (recommended)** | Equivalent | Only the version handler expects (e.g., `v1alpha1`) | One decoder | API server handles conversion; simplest |
| **Version-specific** | Exact | Each version listed separately | Separate handlers/paths per version | More webhook code, full control |
| **Multi-version handler** | Exact | Multiple versions in one rule | Detects request version, decodes accordingly | Complex handler, both types in scheme |

The **recommended** approach is single-version admission: register the webhook for one version only (the one your Go handler decodes), use `matchPolicy: Equivalent`, and let the API server convert incoming requests to that version before calling the webhook.

### The kubectl apply Full Flow

The full flow with conversion and admission webhooks:

```
kubectl apply (v1 YAML)
  |
  v
API Server receives request
  |
  +-- Maybe convert to webhook's version (if Equivalent match)
  |
  +-- Mutating Admission Webhooks
  |     (can modify the object)
  |
  +-- Maybe convert again (between mutating and validating if needed)
  |
  +-- Validating Admission Webhooks
  |     (can reject but not modify)
  |
  +-- Convert to storage version (spec.versions[].storage: true)
  |
  +-- Persist to etcd
  |
  +-- Controller watch receives event
  |     (may convert to controller's preferred version)
  |
  v
Reconciler processes object
```

Conversion can happen at **multiple points** -- there is no single fixed conversion step. The API server converts whenever it needs a different version: for webhook matching, for storage, and for serving responses to clients/controllers.

### The Root Cause

The "main reason" for the failure was a mismatch between the webhook configuration and the handler's capability. The webhook was configured to accept `v1` requests (`apiVersions: [v1alpha1, v1]`) while the handler could only decode `v1alpha1`. Setting `matchPolicy: Exact` made this mismatch immediately visible because the API server stopped hiding it behind automatic conversion.

## Quick Reference

```
matchPolicy Comparison
========================

Equivalent (default):
  v1 request --> API server converts to v2 --> calls v2 webhook
  (webhook rules: apiVersions: [v2])
  Result: WORKS -- webhook sees v2 object

Exact:
  v1 request --> API server checks rules for v1 --> calls webhook with v1 as-is
  (webhook rules: apiVersions: [v1alpha1, v1])
  Result: FAILS if handler only decodes v1alpha1
```

| Aspect | Equivalent | Exact |
|---|---|---|
| Default? | Yes (if unset) | Must be explicit |
| Cross-version matching | Yes (same resource = equivalent) | No (version must match exactly) |
| Conversion before webhook call | Yes (to webhook's expected version) | No (sends request as-is) |
| When to use | Single-version handler (recommended) | Multi-handler or version-specific logic |

| TLS Component | Where It Goes | Purpose |
|---|---|---|
| `tls.crt` + `tls.key` | Mounted Secret in webhook Pod | Pod serves HTTPS |
| CA certificate | `caBundle` in WebhookConfiguration | API server verifies webhook |
| DNS SANs | In the Certificate spec | Must match Service FQDN |

## Key Takeaways

- Webhook TLS requires certs in **two places**: the TLS cert/key in the Pod (mounted Secret) and the CA cert in `caBundle` on the WebhookConfiguration.
- Secrets are namespace-scoped -- re-issue the Certificate in the webhook's namespace rather than trying to cross-reference.
- `matchPolicy: Equivalent` (default) means a webhook registered for one CRD version can fire on requests for **any** equivalent version, with the API server converting the object automatically.
- Setting `matchPolicy: Exact` with multiple `apiVersions` but a single-version decoder is a common mistake that causes decode failures -- the API server no longer converts for you.
- The safest pattern: register the webhook for **one version only** (the one your handler decodes) and use `matchPolicy: Equivalent` to let the API server handle version conversion.
- CRD storage version is set by `spec.versions[].storage: true`, independent of what version clients use in requests. Check `status.storedVersions` for history.
- Conversion can happen at multiple points in the request lifecycle: for webhook matching, between mutating/validating, for storage, and for serving responses.
