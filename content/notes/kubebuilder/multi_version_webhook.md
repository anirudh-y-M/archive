## Cert-manager + webhooks + versioning: Q&A notes

### Q: Where do we put the certificate for a mutating/validating webhook?

* **A:** We put the **webhook server TLS cert/key** in the **webhook Pod**, typically as a **Kubernetes Secret** mounted into the Deployment.
* **A:** We put the **CA certificate** (that signed the webhook server cert) into the **WebhookConfiguration** as `webhooks[].clientConfig.caBundle` so the API server can trust the webhook endpoint.

---

### Q: With cert-manager installed (self-signed Issuer), how do we create TLS for the webhook and mount it?

* **A:** We create a `Certificate` (cert-manager) that writes a TLS Secret (e.g., `webhook-server-tls`) containing `tls.crt` and `tls.key`.
* **A:** We mount that Secret into the webhook Deployment (e.g., at `/tls`) and configure the webhook server to serve HTTPS using those files.
* **A:** The certificate **must include DNS SANs** matching the Service the API server calls, e.g.:

  * `webhook-svc.<ns>.svc`
  * `webhook-svc.<ns>.svc.cluster.local`

---

### Q: My Secret is in a different namespace. Can we mount it into a Deployment in our namespace?

* **A:** No. Kubernetes Secrets are **namespaced**, and Pods can only mount Secrets **from their own namespace**.
* **A:** The usual fixes are:

  * **Re-issue the Certificate in our webhook namespace** (best for rotation), or
  * **Copy/sync** the Secret into our namespace (one-time copy won’t auto-rotate unless we use a sync mechanism).

---

### Q: Can we fetch “configs directly from etcd” and see what `apiVersion` is stored?

* **A:** Direct etcd reads are possible but not the usual approach:

  * Objects are stored in **storage encoding** (often protobuf/binary) and may be **encrypted at rest**.
  * The “stored apiVersion” is not “whatever we applied”; it’s the cluster’s **storage version** decision.
* **A:** For CRDs, the persisted version is determined by the CRD’s `spec.versions[].storage: true`. We can also inspect which versions have been stored historically via `status.storedVersions`.

---

## Webhooks + multi-version CRDs (Kubebuilder): Q&A

### Q: Why did our v2 (spoke) defaulting/validating webhook run when we applied a v1 YAML?

* **A:** Admission webhooks match **resources**, and by default `matchPolicy` behaves like **Equivalent**.
* **A:** With `Equivalent`, the API server may:

  * match a webhook registered for another served version of the same resource, and
  * **convert the object** to the version expected by the webhook before calling it.
* **A:** So applying `cache.my.domain/v1` can still trigger a webhook registered for `v2` if the match policy allows equivalence.

---

### Q: In our webhook YAML, we “strongly mentioned apiVersions: [v2]” — why could v1 still trigger it?

* **A:** Because `apiVersions` in webhook rules is subject to `matchPolicy`.
* **A:** If `matchPolicy` is **Equivalent** (explicitly or by default), v1 and v2 can be treated as equivalent for webhook matching, and the API server can call the webhook after converting.

---

### Q: What’s the flow of `kubectl apply` with conversion + admission webhooks?

* **A:** There isn’t a single, fixed “conversion step” between mutating and validating.
* **A:** Conversion can happen whenever the API server needs a different version:

  * to call a webhook registered for another version (when Equivalent matching applies),
  * to store the object in the CRD’s storage version,
  * to serve responses/watches to clients/controllers.
* **A:** High-level flow:

  * `kubectl` → API server → (maybe convert to webhook’s version) → **Mutating** → (maybe convert) → **Validating** → (convert to storage version) → etcd → controller watch → reconciler

---

### Q: After we set `matchPolicy: Exact`, why did our `kubectl apply` start failing with decode errors?

* **A:** We changed the behavior so the API server will call the webhook **only for the exact apiVersion in the request** (no equivalence conversion for webhook matching).
* **A:** We configured the webhook rules to include both:

  * `apiVersions: [v1alpha1, v1]`
  * but the webhook endpoint path/handler was still effectively a **v1alpha1 decoder** (kubebuilder-generated handler expects `*v1alpha1.Memcached`).
* **A:** Result:

  * We applied `cache.my.domain/v1`
  * API server called webhook with a **v1** object (because Exact)
  * Webhook tried to decode into **v1alpha1** Go type
  * Decode failed → admission denied:

    * `unable to decode ... v1 ... into *v1alpha1.Memcached`

---

### Q: How do we fix that failure?

* **A:** We have three valid patterns:

1. **Single-version admission (recommended)**

   * Make webhook rules list only the version our webhook code expects (e.g., only `v1alpha1`)
   * Use `matchPolicy: Equivalent` (or omit matchPolicy if default is Equivalent)
   * The API server converts v1 → v1alpha1 before calling the webhook

2. **True version-specific admission**

   * Keep `matchPolicy: Exact`
   * Have **separate webhook handlers** (or separate paths) for `v1alpha1` and `v1`
   * Each handler decodes its own version’s Go type

3. **One handler that supports multiple versions**

   * Keep `matchPolicy: Exact` + include multiple `apiVersions`
   * Update webhook code to detect request version and decode the matching Go type
   * Ensure both versions are added to the runtime scheme

---

### Q: What was the “main reason” something failed in our case?

* **A:** We configured the webhook to accept **v1 requests** (`apiVersions: [v1alpha1, v1]`) while the webhook handler was still decoding only into **v1alpha1** types.
* **A:** Setting `matchPolicy: Exact` made the mismatch visible immediately because the API server stopped converting v1 payloads into the v1alpha1 form expected by the webhook.

---
