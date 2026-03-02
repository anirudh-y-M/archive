# PubSub gRPC Pusher Operator - Architecture & V2 Migration Q&A

### **1. FDS Registry Lifecycle**

**Q: What is happening in `cmd/operator/main.go` lines 229-235 with the FDS Registry?**
**A:** This code initializes the **File Descriptor Set (FDS) Registry** and schedules it as a background process within the Kubernetes Controller Manager.
- **`fds.NewRegistry(...)`**: Creates the registry instance using Google Cloud Storage (GCS) and Pub/Sub clients.
- **`mgr.Add(...)`**: Adds a "Runnable" to the manager, ensuring this function starts and stops with the operator.
- **`registry.Sync(...)`**: The actual function being run. It subscribes to a GCS notification topic via Pub/Sub to keep the local in-memory cache of gRPC file descriptors synchronized with the source of truth in the bucket.

**Q: Is `registry.Sync` a one-time execution or a scheduled job?**
**A:** It is a **continuous, long-running process**.
- The function calls `subscription.Receive(...)`, which blocks indefinitely while listening for incoming Pub/Sub messages.
- It acts like a daemon or background worker, processing events in real-time as long as the operator is running.

---

### **2. Deployment Monitoring (`replicas` package)**

**Q: What is the purpose of `monitoring/replicas/watcher.go` (lines 37-81)?**
**A:** This component is responsible for monitoring Kubernetes Deployments to track their replica counts.
- It sets up a Kubernetes **Informer** that watches for `Add`, `Update`, and `Delete` events on Deployments.
- It maintains an in-memory `Store` containing the number of `Replicas` (desired) and `AvailableReplicas` (ready) for each tracked deployment.
- This data is used by the `replicas` server to expose metrics to the pusher sidecars.

**Q: Does the Watcher need updates for the V2 CRD (multi-namespace support)?**
**A:** **Yes.** The original implementation was hardcoded to watch a single namespace (`w.namespace`) and keyed the store only by deployment name. This would fail in a multi-namespace V2 architecture because:
1.  It would ignore deployments in other namespaces.
2.  Deployments with the same name in different namespaces would overwrite each other in the store (naming collisions).

**Q: How should the Watcher be updated?**
**A:**
1.  **Watch Scope:** Change the list/watch function to use `metav1.NamespaceAll` ("") to watch the entire cluster instead of a single namespace.
2.  **Filtering:** Apply a `LabelSelector` (e.g., `app=pubsub-pusher`) to ensure it only watches relevant deployments, avoiding performance issues from watching *every* deployment in the cluster.
3.  **Store Key:** Update the internal `Store` to use a unique key combining the namespace and name (e.g., `namespace/name`) to prevent collisions.

**Q: What does the updated code block in `monitoring/replicas/watcher.go` (lines 38-47) do?**
**A:**
```go
ListFunc: func(options metav1.ListOptions) (runtime.Object, error) {
    options.LabelSelector = constants.LabelSelectorForPubsubPusher
    return w.clientset.AppsV1().Deployments(metav1.NamespaceAll).List(ctx, options)
},
```
- **`metav1.NamespaceAll`**: Configures the watcher to look for deployments in **all namespaces**.
- **`options.LabelSelector`**: Filters the results to only include deployments with the specific label (e.g., `app=pubsub-pusher`).
- **Result:** The watcher now efficiently tracks all PubSub Pusher deployments across the cluster without being flooded by irrelevant events.

---

### **3. Monitoring Server & Endpoints**

**Q: In `monitoring/server.go`, what is the `h2c.NewHandler` doing?**
**A:** It creates a server capable of handling **both HTTP/1.1 and unencrypted HTTP/2 (h2c)** on the same port.
- This allows the server to accept standard HTTP requests (like `/metrics` or `/healthz`) AND gRPC requests (which require HTTP/2) without needing TLS.
- This is commonly used in internal cluster communication (e.g., sidecars) where TLS is terminated elsewhere.

**Q: How does `server.go` distinguish between HTTP and gRPC requests?**
**A:** It uses a traffic routing function (`rootHandler`):
- Checks if `r.ProtoMajor == 2` AND `Content-Type` starts with `application/grpc`.
- **If YES:** Forwards the request to `s.grpcserver` (gRPC handler).
- **If NO:** Forwards the request to `s.mux` (standard HTTP handler).
- This allows a single port to serve multiple protocols transparently.

**Q: Where is the `/replicas` endpoint used?**
**A:** It is consumed by the **Rate Limiter** inside the Pusher component (`pusher/rate_limiter.go`).
- The pusher sidecar periodically polls `http://operator-service:port/replicas?namespace=<ns>`.
- It retrieves the current replica count for its deployment.
- This data is used to dynamically adjust rate limits (e.g., allowing higher throughput per pod if the total number of replicas decreases).

---

### **4. Miscellaneous**

**Q: Where is the logger embedded in the context in `pubsubgrpcpush_controller.go`?**
**A:** The logger is embedded by the **controller-runtime framework**, not manually in `main.go`.
- `ctrl.SetLogger(logger)` registers the global logger.
- The framework automatically injects this logger into the `context.Context` passed to `Reconcile()`, adding metadata like the controller group, kind, and the resource's namespaced name.
- `log.FromContext(ctx)` retrieves this pre-configured logger.
