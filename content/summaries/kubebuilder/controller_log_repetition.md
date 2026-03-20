---
title: "Summary: Controller Log Repetition Error with Kubebuilder"
---

> **Full notes:** [[notes/kubebuilder/controller_log_repetition|Controller Log Repetition Error I Faced with Kubebuilder →]]

## Key Concepts

- **Kustomize `nameReference`** -- In CRD kustomization, `nameReference` tells kustomize to rewrite CRD fields if a matching Service gets its name transformed. If no Service is in the build, the rule is a no-op.

- **kind image loading** -- kind nodes run containerd in Docker containers and don't see local Docker images. `kind load docker-image` copies images into the node's containerd store. Verify with `crictl images` inside the node.

- **Why reconcile logs repeat** -- Multiple triggers cause re-reconciliation:
  - Updating the CR status triggers a new reconcile
  - Creating/updating an owned Deployment triggers reconcile (`Owns(&appsv1.Deployment{})`)
  - Informer cache lag can cause a second reconcile to not find a just-created resource, leading to `AlreadyExists` errors
  - Explicit `RequeueAfter` schedules another reconcile

- **`RequeueAfter` behavior** -- Each `return ctrl.Result{RequeueAfter: time.Minute}, nil` schedules exactly one delayed requeue. It becomes periodic only if returned on every reconcile.

- **Controller watches by GVK** -- The controller matches on group and kind, so `For(&v1alpha1.Memcached{})` and `For(&v1.Memcached{})` are interchangeable.

## Quick Reference

```
Why Reconcile Runs Multiple Times
===================================

CR Created
  |
  +-- Reconcile #1: create Deployment, update status
  |     |
  |     +-- status update --> triggers Reconcile #2
  |     +-- Deployment create --> triggers Reconcile #3 (Owns)
  |
  +-- Reconcile #2: Deployment may not be in cache yet
  |     --> AlreadyExists on create (cache lag)
  |
  +-- RequeueAfter --> Reconcile #4 (delayed)
```

| Fix | What it does |
|---|---|
| Treat `AlreadyExists` as success | Idempotent under cache race |
| Skip unnecessary `RequeueAfter` | Fewer spurious reconciles |
| Only update status when changed | Avoids status-triggered re-reconcile |
| Predicates on owned resources | Ignore status-only updates |

## Key Takeaways

- Reconcile is not called once -- expect multiple invocations per change due to status updates, owned resource watches, and requeue.
- Always treat `AlreadyExists` on resource creation as a success to handle informer cache lag gracefully.
- `RequeueAfter` is a single delayed enqueue, not a timer -- it becomes periodic only if you return it every time.
- Only update CR status when it actually changes to avoid unnecessary reconcile loops.
- Controllers match on group+kind, not the specific Go type version you pass to `For()`.
