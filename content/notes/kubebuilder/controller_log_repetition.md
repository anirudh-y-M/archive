---
title: Controller Log Repition Error I Faced with Kubebuilder
---

- **Q:** _What Service is `nameReference` referring to in the CRD, since our kustomization doesn’t render any Service?_

  - **A:** It’s referring to the **conversion webhook Service** (the Service fronting the webhook server).
  - **A:** `nameReference` doesn’t render a Service; it only tells kustomize to **rewrite that CRD field** _if_ a Service in the same build has its name/namespace transformed.
  - **A:** If our build only includes CRDs and no webhook Service, the rule is effectively a **no-op** (unless the CRD already has those fields to rewrite).

- **Q:** _`kind load docker-image memcached:test --name kubebuilder-test` prints “image not yet present on node … loading..” — explain._

  - **A:** kind nodes run containerd inside separate Docker containers; they don’t automatically see our local Docker images.
  - **A:** The message means the node didn’t have that image ID yet, so kind is **copying/importing** it into the node’s image store.

- **Q:** _How to see if the image is present on the kind cluster?_

  - **A:** List kind nodes and check each node’s containerd images via `docker exec`:
    - `kind get nodes --name kubebuilder-test`
    - `docker exec -it <node> crictl images | grep -E 'memcached|test'`
    - or `docker exec -it <node> ctr -n k8s.io images ls | grep -E 'memcached|test'`

- **Q:** _How to run a Pod with this image?_

  - **A:** Use `imagePullPolicy: IfNotPresent` so the cluster uses the loaded image:
    - `kubectl run memcached-test --image=memcached:test --restart=Never --image-pull-policy=IfNotPresent --port=11211`
  - **A:** Or apply a Pod YAML with:
    - `image: memcached:test`
    - `imagePullPolicy: IfNotPresent`

- **Q:** _Why are reconciler logs getting repeated?_

  - **A:** Reconcile is triggered by multiple sources:
    - Updating the CR **status** triggers another reconcile.
    - Creating/updating the owned **Deployment** triggers another reconcile (`Owns(&appsv1.Deployment{})`).
    - Cache/informer lag can cause a second reconcile to still “not find” the Deployment and try to create again, leading to `AlreadyExists`.
    - Any explicit `RequeueAfter` causes another reconcile later.
  - **A:** Fixes/mitigations:
    - Treat `AlreadyExists` on create as success (idempotency under cache race).
    - Avoid unnecessary `RequeueAfter` unless needed.
    - Only update status when it actually changes (already done later; do similar for the initial “Unknown” set).
    - Optional: predicates to ignore status-only updates on owned resources.

- **Q:** _Does `return ctrl.Result{RequeueAfter: time.Minute}, nil` enqueue once or every minute?_

  - **A:** It schedules **one delayed requeue** for that reconcile call.
  - **A:** It becomes “every minute” only if we return `RequeueAfter: 1m` on every reconcile.

- **Q:** _How to ensure at least 1 reconcile occurs every 3 minutes no matter what?_
  - **A:** Most direct: always return at end:
    - `return ctrl.Result{RequeueAfter: 3 * time.Minute}, nil`
  - **A:** Alternative: set manager cache `SyncPeriod` to 3 minutes (global resync behavior; less direct than `RequeueAfter`).

### Notes

- The controller watches the group and kind. So even if I replace `For(&cachev1alpha1.Memcached{})` with `For(&cachev1.Memcached{})`, it'll work as we expected.

  ```
  func (r *MemcachedReconciler) SetupWithManager(mgr ctrl.Manager) error {
    fmt.Println("0. Setting up controller with manager")
    return ctrl.NewControllerManagedBy(mgr).
      For(&cachev1alpha1.Memcached{}).
      Owns(&appsv1.Deployment{}).
      Named("memcached").
      Complete(r)
  }
  ```
