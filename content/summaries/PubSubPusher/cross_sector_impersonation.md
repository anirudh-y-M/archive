---
title: "Summary: PubSub Pusher - Cross-Sector Impersonation"
---

> **Full notes:** [[notes/PubSubPusher/cross_sector_impersonation|PubSub Pusher →]]

## Key Concepts

- **Common Service Account** (`pubsub-pusher@<project>.iam`) -- Used for two things: (1) issuing MSID tokens for peer authentication, and (2) reading proto file descriptor sets from GCS buckets (`storage.objectViewer`).

- **Cross-Sector Impersonation** -- When PubSub messages cross sector boundaries, a Google ID Token is needed for the gateway. The namespace-dedicated SA impersonates a subscriber-side SA to generate this token via the IAM Credentials API (`GenerateIdToken`).

- **Push (consuming) path** -- If `CrossSector.OidcToken.ServiceAccountEmail` is set, that SA is impersonated. If not set, the default SA's token is used directly.

- **Publish path** -- Always uses a namespace-dedicated SA: `ns-{trimmed-namespace}@{project}.iam.gserviceaccount.com`. This SA impersonates the subscriber-created SA.

- **Token attachment** -- The Google ID Token is attached to gRPC requests via a `UnaryClientInterceptor`. Two more interceptors handle SUID-to-PPID conversion and escape proxy routing.

## Quick Reference

```
Cross-Sector gRPC Call Chain
=============================

Pusher Pod
  |
  +-- TokenSourceInterceptor      --> attaches Google ID Token
  +-- SUIDConverterInterceptor    --> converts SUID -> PPID
  +-- EscapeProxyInterceptor      --> routes via gateway
  |
  v
Escape Proxy / Gateway  -->  Target Sector Service
```

| Scenario | SA Used for Token | How |
|---|---|---|
| Push + explicit OidcToken SA | Specified SA email | IAM Credentials API impersonation |
| Push + no OidcToken SA | Default SA | `DefaultTokenSource` (no impersonation) |
| Publish (always) | `ns-{trimmedNS}@{project}.iam` | IAM Credentials API impersonation |

```
Namespace-Dedicated SA Naming
==============================
ns-<trimmed-namespace>@<controller-namespace>.iam.gserviceaccount.com

- Trimmed = short env suffix removed (e.g., "-dev", "-prod")
- Max 30 chars for GCP SA ID
```

## Key Takeaways

- The common SA (`pubsub-pusher@...`) handles MSID tokens and GCS access -- it is not used directly for cross-sector token generation.
- Cross-sector auth uses Google ID Tokens generated via SA impersonation through the IAM Credentials API.
- Push and Publish paths differ: Push optionally impersonates a configured SA; Publish always impersonates via the namespace-dedicated SA.
- The subscriber-side SA must be registered in the IDP so the generated Google ID Token can be verified at the destination.
- Three gRPC interceptors work together: token attachment, SUID conversion, and escape proxy routing.
