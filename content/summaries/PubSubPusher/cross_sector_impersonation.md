---
title: "Summary: PubSub Pusher - Cross-Sector Impersonation"
---

> **Full notes:** [[notes/PubSubPusher/cross_sector_impersonation|PubSub Pusher →]]

## Key Concepts

### Common Service Account

The service account `pubsub-pusher@<project>.iam.gserviceaccount.com` is the **common SA** for the entire pubsub-grpc-pusher system. It serves two purposes: (1) issuing **MSID tokens** (MicroService IDentification) for peer authentication between services, using `msid.NewTokenIssuer` with `WithImpersonation(CommonServiceAccount(project))`, and (2) reading **proto file descriptor sets** from GCS buckets via the `storage.objectViewer` role. This SA is **not** directly used for cross-sector token generation.

### Cross-Sector Impersonation -- Push Path (Consuming Messages)

When consuming messages cross-sector, the behavior depends on whether `CrossSector.OidcToken.ServiceAccountEmail` is explicitly set in the CRD spec. If set, that specified SA is impersonated to generate a Google ID Token. If not set, the default SA's token is used directly (no impersonation). The namespace-dedicated SA impersonates the subscriber-side SA, which must be registered in the IDP so that the generated Google ID Token can be verified at the destination.

```go
// From pubsubgrpcpush_controller.go -- Push path
var impersonateSA string
if item.Spec.Push.CrossSector.OidcToken != nil {
    impersonateSA = item.Spec.Push.CrossSector.OidcToken.ServiceAccountEmail
}
```

### Cross-Sector Impersonation -- Publish Path (Publishing Messages)

The publish path **always** uses a namespace-dedicated SA with the format `ns-{trimmed-namespace}@{controller-namespace}.iam.gserviceaccount.com`. The namespace name is trimmed of its short env suffix (e.g., `-dev`, `-prod`) because GCP SA IDs have a 30-character limit. This namespace-dedicated SA impersonates the subscriber-created SA to generate the ID token. Multiple namespace-dedicated SAs are created via Terraform modules, one per namespace that needs cross-sector publishing.

```go
// SA naming logic
func namespaceDedicatedServiceAccount(targetNamespace, namespace string) string {
    trimedTargetNS := trimShortEnvSuffix(targetNamespace)
    return fmt.Sprintf("ns-%s@%s.iam.gserviceaccount.com", trimedTargetNS, namespace)
}
```

### Token Generation Mechanism

Google ID Tokens are generated via `authority.NewGoogleIDTokenSource()`. If `impersonateEmail` is non-empty, it calls the **IAM Credentials API** (`GenerateIdToken`) to create a token as the impersonated SA, with a 55-minute expiry (buffer on the 1-hour actual validity). If `impersonateEmail` is empty, it falls back to `DefaultTokenSourceWithProactiveCacheForIDToken`, using the default SA's credentials directly.

### Token Attachment and gRPC Interceptor Chain

The generated Google ID Token is attached to outgoing gRPC requests via three chained `UnaryClientInterceptor`s:

1. **`TokenSourceUnaryClientInterceptor(ts)`** -- attaches the Google ID Token as authorization metadata
2. **`CallerUnaryClientInterceptor(suidConverter)`** -- converts SUID (Sector User ID) to PPID (Platform-Private ID) for the destination client ID
3. **`EscapeProxyInterceptor(gatewayEndpoint)`** -- adds the gateway endpoint to the context so the request is routed through the cross-sector escape proxy

### Terraform Infrastructure

Namespace-dedicated SAs are provisioned via Terraform modules (`modules/namespace_dedicated_service_account`). Each module takes `env`, `organization`, `service_id`, and `namespace` as inputs, and optionally `destination_client_ids`. SAs are registered with the IDP so the generated tokens can be verified. Each namespace needing cross-sector publishing gets its own module invocation.

### Additional Notes

The escape proxy interceptor works by calling `escapeproxy.WithContext(ctx, endpoint)`, injecting the gateway endpoint into the request context. The system also handles SUID-to-PPID conversion as part of cross-sector communication, which is required because different sectors use different user ID schemes.

## Quick Reference

```
Cross-Sector gRPC Call Chain (detailed)
=========================================

Pusher Pod
  |
  +-- NewGoogleIDTokenSource(audience, impersonateEmail)
  |     |
  |     +-- impersonateEmail != "" ?
  |     |     YES --> IAM Credentials API: GenerateIdToken(SA, audience)
  |     |              --> Bearer token, 55min expiry
  |     |     NO  --> DefaultTokenSource (default SA credentials)
  |     |
  |     v
  +-- Interceptor Chain:
  |     1. TokenSourceInterceptor      --> attaches Google ID Token
  |     2. SUIDConverterInterceptor    --> converts SUID -> PPID
  |     3. EscapeProxyInterceptor      --> injects gateway endpoint into ctx
  |
  v
Escape Proxy / Gateway  -->  Target Sector Service
                              (verifies token via IDP)
```

```
SA Naming and Relationships
============================

Common SA (MSID + GCS access):
  pubsub-pusher@<project>.iam.gserviceaccount.com

Namespace-Dedicated SA (cross-sector publishing):
  ns-<trimmed-namespace>@<controller-namespace>.iam.gserviceaccount.com
  (env suffix like -dev/-prod stripped, max 30 chars for GCP SA ID)
```

| Scenario | SA Used for Token | Impersonation? | Mechanism |
|---|---|---|---|
| Push + explicit `OidcToken.ServiceAccountEmail` | Specified SA email | Yes | IAM Credentials API `GenerateIdToken` |
| Push + no `OidcToken` SA configured | Default SA | No | `DefaultTokenSource` (direct credentials) |
| Publish (always) | `ns-{trimmedNS}@{project}.iam` | Yes | IAM Credentials API `GenerateIdToken` |

| Component | Role |
|---|---|
| `authority/service_account.go` | Defines common SA format |
| `authority/msid.go` | Creates MSID token issuer via common SA impersonation |
| `authority/impersonate.go` | Google ID Token source (default or impersonated) |
| `controllers/resources.go` | Namespace-dedicated SA naming logic |
| `pusher/pusher.go` | Wires up interceptor chain for cross-sector calls |
| `pusher/middlewares/escapeproxy.go` | Escape proxy context injection |

## Key Takeaways

- The common SA (`pubsub-pusher@...`) handles MSID tokens and GCS access -- it is **not** used directly for cross-sector token generation.
- Cross-sector auth uses Google ID Tokens generated via SA impersonation through the IAM Credentials API, with a 55-minute cache/expiry buffer.
- Push and Publish paths differ: Push **optionally** impersonates a configured SA (falls back to default); Publish **always** impersonates via the namespace-dedicated SA.
- Namespace-dedicated SAs follow the `ns-{trimmedNS}@{project}` naming convention, trimming env suffixes to fit the 30-char GCP SA ID limit.
- The subscriber-side SA must be registered in the IDP so the generated Google ID Token can be verified at the destination sector.
- Three gRPC interceptors form the cross-sector call chain: token attachment, SUID-to-PPID conversion, and escape proxy routing.
- Terraform modules provision one namespace-dedicated SA per namespace that needs cross-sector publishing capabilities.
