---
title: "Summary: Pusher Operator - Architecture & V2 Migration"
---

> **Full notes:** [[notes/PubSubPusher/OPERATOR_ARCHITECTURE_AND_MIGRATION|Pusher Operator - Architecture & V2 Migration →]]

## Key Concepts

### FDS Registry Lifecycle

The FDS (File Descriptor Set) Registry is initialized in `cmd/operator/main.go` via `fds.NewRegistry(...)` using GCS and Pub/Sub clients. It is added to the controller manager as a `Runnable` via `mgr.Add(registry.Sync)`, which means it starts and stops with the operator process.

`registry.Sync` is **not** a one-shot job -- it is a continuous, long-running daemon process. Internally it calls `subscription.Receive(...)` which blocks indefinitely, listening for GCS notification messages via Pub/Sub. This keeps the local in-memory cache of gRPC file descriptors synchronized with the source-of-truth GCS bucket in real time.

### Deployment Monitoring (replicas package)

The replica watcher (`monitoring/replicas/watcher.go`) sets up a Kubernetes **Informer** that watches for `Add`, `Update`, and `Delete` events on Deployments. It maintains an in-memory `Store` tracking `Replicas` (desired) and `AvailableReplicas` (ready) for each deployment. This store is exposed via the `replicas` server to pusher sidecars.

**V2 Migration Problem:** The original V1 implementation was hardcoded to watch a single namespace (`w.namespace`) and keyed the store by deployment name alone. In a multi-namespace V2 architecture, this breaks because (1) deployments in other namespaces are invisible, and (2) same-named deployments in different namespaces collide in the store.

**V2 Fix -- three changes:**
1. **Watch scope** changed to `metav1.NamespaceAll` ("") for cluster-wide watching
2. **Label selector** (`constants.LabelSelectorForPubsubPusher`) added to filter only relevant deployments and avoid watching every deployment in the cluster
3. **Store key** changed from bare deployment name to `namespace/name` composite key to prevent collisions

```go
// V2 updated watch function
ListFunc: func(options metav1.ListOptions) (runtime.Object, error) {
    options.LabelSelector = constants.LabelSelectorForPubsubPusher
    return w.clientset.AppsV1().Deployments(metav1.NamespaceAll).List(ctx, options)
},
```

### Monitoring Server and Endpoints

The monitoring server (`monitoring/server.go`) uses `h2c.NewHandler` to serve **both HTTP/1.1 and unencrypted HTTP/2** on a single port. This is needed because gRPC requires HTTP/2, while standard endpoints like `/metrics` and `/healthz` use HTTP/1.1. TLS is not needed here because it is terminated elsewhere in the cluster (e.g., service mesh).

Traffic routing works via a `rootHandler` function that checks `r.ProtoMajor == 2` AND `Content-Type` starting with `application/grpc`. If both are true, the request goes to `s.grpcserver`; otherwise it goes to `s.mux` (standard HTTP mux). This allows a single port to multiplex both protocols transparently.

### /replicas Endpoint and Rate Limiting

The `/replicas` endpoint is consumed by the **Rate Limiter** inside the Pusher sidecar (`pusher/rate_limiter.go`). Sidecars periodically poll `http://operator-service:port/replicas?namespace=<ns>` to get the current replica count of their deployment. This data is used to dynamically adjust per-pod rate limits -- e.g., if replicas decrease, each remaining pod is allowed higher throughput.

### Logger Injection in Reconciler

The logger is **not** manually embedded in `main.go`. Instead, `ctrl.SetLogger(logger)` registers the global logger, and the **controller-runtime framework** automatically injects it into the `context.Context` passed to each `Reconcile()` call, enriched with metadata (controller group, kind, namespaced name). `log.FromContext(ctx)` retrieves this pre-configured logger.

## Quick Reference

```
Operator Startup Flow
=====================
main.go
  |
  +-- fds.NewRegistry(gcsClient, pubsubClient)
  |     |
  |     +-- mgr.Add(registry.Sync)   <-- Long-running Pub/Sub listener
  |                                       blocks on subscription.Receive()
  |
  +-- ReplicaWatcher (Informer)
  |     |
  |     +-- V1: single namespace, name-only key
  |     +-- V2: NamespaceAll + LabelSelector, namespace/name key
  |
  +-- Monitoring Server (:port)
        |
        +-- rootHandler checks ProtoMajor + Content-Type
        |     |
        |     +-- gRPC (HTTP/2 + application/grpc) --> s.grpcserver
        |     +-- HTTP/1.1 (everything else)        --> s.mux
        |
        +-- /metrics, /healthz   <-- standard HTTP
        +-- /replicas?namespace=  <-- polled by pusher sidecars for rate limiting
```

| Component | V1 (single-ns) | V2 (multi-ns) |
|---|---|---|
| Watch scope | `w.namespace` (single) | `metav1.NamespaceAll` (cluster-wide) |
| Filtering | None (implicit namespace scope) | `LabelSelector: app=pubsub-pusher` |
| Store key | Deployment name only | `namespace/name` (composite) |
| Collision risk | None (single ns) | Eliminated by composite key |

| Server Route | Condition | Handler |
|---|---|---|
| gRPC | `ProtoMajor == 2` AND `Content-Type: application/grpc` | `s.grpcserver` |
| HTTP | Everything else | `s.mux` (metrics, healthz, replicas) |

## Key Takeaways

- FDS Registry is a continuous Pub/Sub listener (`subscription.Receive` blocks forever), not a one-shot job -- it runs for the entire lifetime of the operator.
- V2 migration required three coordinated changes to the replica watcher: cluster-wide scope, label-selector filtering, and composite store keys to prevent cross-namespace name collisions.
- The monitoring server multiplexes HTTP/1.1 and gRPC (HTTP/2) on a single port using `h2c.NewHandler` and content-type-based routing -- no TLS needed for internal cluster traffic.
- The `/replicas` endpoint drives dynamic rate limiting: pusher sidecars poll it to learn their deployment's current replica count and adjust throughput accordingly.
- `log.FromContext(ctx)` works because controller-runtime auto-injects the logger into the reconcile context -- no manual embedding in `main.go` is needed.
