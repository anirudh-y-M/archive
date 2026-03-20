---
title: "Summary: Controller Log Repetition Error with Kubebuilder"
---

> **Full notes:** [[notes/kubebuilder/controller_log_repetition|Controller Log Repetition Error I Faced with Kubebuilder →]]

## Key Concepts

### Kustomize `nameReference` and Webhook Service

In CRD kustomization, the `nameReference` transformer refers to the **conversion webhook Service** (the Service fronting the webhook server). It does not render a Service itself -- it only tells kustomize to **rewrite CRD fields** if a Service in the same build has its name/namespace transformed. If the build only includes CRDs and no webhook Service, the `nameReference` rule is effectively a **no-op**.

### kind Image Loading

kind nodes run containerd inside separate Docker containers, so they **do not** see images from the local Docker daemon. The command `kind load docker-image` copies/imports the image into the node's containerd store. The "image not yet present on node... loading..." message confirms this import is happening.

To verify an image is present on a kind cluster:
- `kind get nodes --name <cluster>` to list nodes
- `docker exec -it <node> crictl images | grep <image>` to check containerd images
- Use `imagePullPolicy: IfNotPresent` in Pod specs to use loaded images

### Why Reconciler Logs Repeat

Reconcile is triggered by **multiple sources**, leading to repeated log entries:

1. **Status updates** -- Updating the CR's `.status` subresource triggers a new reconcile event
2. **Owned resource changes** -- Creating or updating an owned Deployment triggers reconcile via `Owns(&appsv1.Deployment{})`
3. **Informer cache lag** -- A second reconcile may run before the cache reflects a just-created resource, causing `AlreadyExists` errors on a duplicate create attempt
4. **Explicit `RequeueAfter`** -- Returning `ctrl.Result{RequeueAfter: time.Minute}` schedules another reconcile after the delay

```
Reconcile Trigger Chain (detailed)
====================================

CR Created by user
  |
  +-- Reconcile #1 fires (CR watch)
  |     |
  |     +-- Creates Deployment
  |     |     \--> triggers Reconcile #3 (Owns watch)
  |     |
  |     +-- Updates CR status to "Progressing"
  |     |     \--> triggers Reconcile #2 (CR watch, status change)
  |     |
  |     +-- Returns RequeueAfter: 1m
  |           \--> schedules Reconcile #4 (delayed)
  |
  +-- Reconcile #2 fires (from status update)
  |     |
  |     +-- Cache may not have Deployment yet
  |     +-- Tries to create Deployment again
  |     +-- Gets AlreadyExists error (cache lag race)
  |
  +-- Reconcile #3 fires (from Deployment create, Owns watch)
  |
  +-- Reconcile #4 fires (from RequeueAfter, 1 min later)
```

### Fixes and Mitigations

| Fix | What it does | Why it helps |
|---|---|---|
| Treat `AlreadyExists` as success | Makes create calls idempotent | Handles cache-lag races gracefully |
| Avoid unnecessary `RequeueAfter` | Removes explicit requeue unless truly needed | Fewer spurious reconcile cycles |
| Only update status when changed | Skips the status write if values are identical | Prevents status-update-triggered reconcile |
| Predicates on owned resources | Ignore status-only updates on Deployments | Filters out events that don't need reconcile |

### `RequeueAfter` Behavior

`return ctrl.Result{RequeueAfter: time.Minute}, nil` schedules **exactly one** delayed requeue for that specific reconcile invocation. It does **not** create a repeating timer. It becomes "every minute" only if the code returns `RequeueAfter: 1m` on **every** reconcile call. To guarantee at least one reconcile every N minutes regardless of events, either always return `RequeueAfter: N*time.Minute` at the end of the reconcile function, or set the manager's cache `SyncPeriod` to N minutes (global resync, less targeted).

### Controller Watches by Group and Kind

The controller matches resources by **group and kind**, not by the specific Go type version passed to `For()`. So `For(&cachev1alpha1.Memcached{})` and `For(&cachev1.Memcached{})` are functionally interchangeable -- both set up a watch on the same `cache.my.domain/Memcached` resource.

```go
func (r *MemcachedReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&cachev1alpha1.Memcached{}). // v1 works identically here
        Owns(&appsv1.Deployment{}).
        Named("memcached").
        Complete(r)
}
```

## Quick Reference

```
Reconcile Trigger Sources
===========================
  CR event (create/update/delete)  ----+
  Status subresource update        ----+--> Work Queue --> Reconcile()
  Owned resource event (Owns)      ----|
  RequeueAfter (delayed enqueue)   ----+
  Cache SyncPeriod (global resync) ----+
```

| Trigger | Example | Avoidable? |
|---|---|---|
| CR create/update | User applies CR | No (primary trigger) |
| Status update | `r.Status().Update(ctx, cr)` | Yes -- skip if unchanged |
| Owned resource | Deployment created/updated | Partially -- use predicates |
| `RequeueAfter` | `ctrl.Result{RequeueAfter: 1m}` | Yes -- only use when needed |
| Cache resync | Manager `SyncPeriod` | Config-dependent |

```
kind Image Loading Flow
========================
Local Docker daemon
  |
  +-- kind load docker-image <img> --name <cluster>
        |
        +-- Copies image into kind node's containerd store
              |
              +-- Pod with imagePullPolicy: IfNotPresent
                    --> uses local image, no registry pull
```

## Key Takeaways

- Reconcile is **not** called once per change -- expect multiple invocations from status updates, owned resource watches, cache lag, and requeue.
- Always treat `AlreadyExists` on resource creation as success to handle the informer cache lag race condition gracefully.
- `RequeueAfter` is a single delayed enqueue, not a repeating timer -- it becomes periodic only if returned on every reconcile call.
- Only update CR status when values actually change to avoid triggering unnecessary reconcile loops.
- Controllers match on group+kind, not the specific Go type version -- `For(&v1alpha1.X{})` and `For(&v1.X{})` are equivalent.
- `nameReference` in kustomize is a no-op when no matching Service is in the build -- it only rewrites fields when a Service name transform occurs.
- kind nodes need explicit `kind load docker-image` because containerd inside kind doesn't share the host Docker image store.
