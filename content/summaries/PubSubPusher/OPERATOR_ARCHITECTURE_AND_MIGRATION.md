---
title: "Summary: Pusher Operator - Architecture & V2 Migration"
---

> **Full notes:** [[notes/PubSubPusher/OPERATOR_ARCHITECTURE_AND_MIGRATION|Pusher Operator - Architecture & V2 Migration →]]

## Key Concepts

- **FDS Registry** -- A long-running background process that keeps an in-memory cache of gRPC file descriptors in sync with a GCS bucket. It subscribes to a Pub/Sub notification topic and blocks indefinitely via `subscription.Receive(...)`, acting as a daemon inside the operator.

- **Deployment Replica Watcher** -- A Kubernetes Informer that tracks `Replicas` and `AvailableReplicas` for pusher deployments. For V2 (multi-namespace), it was changed from single-namespace to cluster-wide watch using `NamespaceAll` with a label selector filter, and the store key changed to `namespace/name` to avoid collisions.

- **Monitoring Server (h2c)** -- Serves both HTTP/1.1 and unencrypted HTTP/2 on a single port using `h2c.NewHandler`. Routes gRPC traffic (HTTP/2 + `application/grpc`) to the gRPC server, everything else to a standard HTTP mux.

- **`/replicas` Endpoint** -- Consumed by the pusher sidecar's rate limiter. Sidecars poll this endpoint to get current replica counts and dynamically adjust per-pod rate limits.

- **Logger Injection** -- The controller-runtime framework automatically injects the logger into `context.Context` passed to `Reconcile()`. No manual embedding needed; `log.FromContext(ctx)` retrieves it.

## Quick Reference

```
Operator Startup Flow
=====================
main.go
  |
  +-- mgr.Add(registry.Sync)     <-- FDS: long-running Pub/Sub listener
  |
  +-- ReplicaWatcher (Informer)   <-- Tracks deployment replicas cluster-wide
  |
  +-- Monitoring Server (:port)
        |
        +-- /metrics, /healthz    <-- HTTP/1.1
        +-- gRPC (replicas svc)   <-- HTTP/2 (h2c)
        +-- /replicas?namespace=  <-- Polled by pusher sidecars
```

| Component | V1 (single-ns) | V2 (multi-ns) |
|---|---|---|
| Watch scope | Single namespace | `NamespaceAll` |
| Filtering | None (implicit) | `LabelSelector: app=pubsub-pusher` |
| Store key | Deployment name | `namespace/name` |

## Key Takeaways

- FDS Registry is a continuous Pub/Sub listener, not a one-shot job -- it runs for the lifetime of the operator.
- V2 migration required switching the replica watcher to cluster-wide scope with label filtering and composite store keys.
- The monitoring server multiplexes HTTP and gRPC on a single port using h2c and content-type routing.
- The `/replicas` endpoint enables dynamic rate limiting in pusher sidecars based on live replica counts.
- `log.FromContext(ctx)` works because controller-runtime injects the logger automatically -- no manual setup needed.
