---
title: "Summary: kube-apiserver Request Routing — Built-in, CRD, and Aggregated APIs"
---

> **Full notes:** [[notes/K8s/kube-apiserver-request-routing|kube-apiserver Request Routing -->]]

## Key Concepts

### Three Categories of API Endpoints

`kube-apiserver` exposes one giant REST tree, but three completely different machines answer it:

| Category | Handler location | Storage | Examples |
|---|---|---|---|
| **Built-in** | Compiled into `kube-apiserver` binary | etcd via `kube-apiserver` | `core/v1`, `apps/v1`, `batch/v1`, `networking.k8s.io/v1` |
| **CRD** | Generated dynamically inside `kube-apiserver` from a `CustomResourceDefinition` | etcd via `kube-apiserver` | `cert-manager.io/v1`, `keda.sh/v1alpha1`, operators |
| **Aggregated** | Separate pod, registered via `APIService` (proxied) | Pod's choice (RAM, SQL, separate etcd, none) | `metrics.k8s.io`, `custom.metrics.k8s.io`, `external.metrics.k8s.io`, `sample-apiserver` |

### Built-in request path

```
GET /api/v1/namespaces/default/pods/web
  → APIRequestInfoResolver: {api: core, version: v1, resource: pods, ns: default, name: web}
  → authn → authz (RBAC SAR) → admission (audit only on GET)
  → core handler → REST storage for "pods"
  → etcd3.Storage.Get("pods/default/web")
  → return JSON
```

No proxy hop, no CRD, nothing dynamic. Versioned with the K8s release; no runtime removal.

### CRDs

Runtime extension served entirely **inside** kube-apiserver. **Free from kube-apiserver**: URL routing, OpenAPI v3 validation, defaulting (CEL since 1.25, GA 1.30), etcd storage, watch streams, conversion (via webhook for multi-version), `status`/`scale` subresources.

**Outside (your code)**: optional admission webhooks, conversion webhook, the operator that reconciles the CR.

Same etcd, same admission chain, same authz layer as built-ins. Only difference: schema came from a CRD object loaded at runtime instead of a Go struct.

Storage layout:
```
/registry/<group>/<resource>/<namespace>/<name>     (namespaced)
/registry/<group>/<resource>/<name>                  (cluster-scoped)
```

### CRD vs Aggregated decision

| Need | CRD | Aggregated |
|---|---|---|
| Stored, validated, watched objects with kubectl parity | ✓ perfect | possible but heavy |
| Computed-on-demand answer (metrics, derived state) | poor (must persist) | good |
| Custom storage backend (SQL, blob, time series) | impossible | yes |
| Object > 1.5 MiB | rejected at write | yes |
| Watch experience without writing the cache | included free | implement yourself |
| Minutes-to-implement budget | yes | no — Go binary, deploy, RBAC, certs |

Most extensions (cert-manager, KEDA, Argo CD, Crossplane, Tekton, Istio CRDs) are CRD-based. Aggregated apiservers are reserved for inherently non-storage problems.

> 1.5 MiB is a soft target (etcd `--max-request-bytes` and matching kube-apiserver defaults), not a hard ceiling. Large CRs balloon the watch cache, OpenAPI validation, and JSON serialization regardless.

### Aggregated APIs — wiring

A `Service` plus an `APIService`:

```yaml
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1beta1.metrics.k8s.io          # = "<version>.<group>"
spec:
  group: metrics.k8s.io
  version: v1beta1
  service: { name: metrics-server, namespace: kube-system }
  caBundle: <PEM CA verifying backing service>
  groupPriorityMinimum: 100
  versionPriority: 100
```

The aggregator (built-in inside kube-apiserver) caches the registry. On each request, if the path matches a registered group/version not served locally → look up Service endpoints → open TLS to one (round-robin, retry) → present the proxy-client cert → forward with delegated-auth headers → stream response back.

### Authentication delegation

Aggregated apiservers do **NOT** re-authenticate the original client. Trust kube-apiserver via the official "request-header" authenticator.

| Flag (on kube-apiserver) | Purpose |
|---|---|
| `--proxy-client-cert-file` | Client cert kube-apiserver presents to the extension |
| `--proxy-client-key-file` | Private key for above |
| `--requestheader-client-ca-file` | CA the extension uses to verify incoming proxy clients |
| `--requestheader-allowed-names` | Permitted CNs on the proxy client cert (empty = any signed by CA) |
| `--requestheader-username-headers` | Header carrying username, e.g. `X-Remote-User` |
| `--requestheader-group-headers` | Header carrying groups, e.g. `X-Remote-Group` |
| `--requestheader-extra-headers-prefix` | Prefix for extra info, e.g. `X-Remote-Extra-` |

kube-apiserver auto-publishes the public halves into ConfigMap **`kube-system/extension-apiserver-authentication`**, which the extension reads at startup.

End-to-end for `kubectl top pod`:
1. kubectl → kube-apiserver: authn (bearer/mTLS), authz (RBAC `get pods.metrics.k8s.io`).
2. kube-apiserver looks up APIService → backing Service.
3. Opens TLS to extension pod IP. Server cert verified against `APIService.spec.caBundle`. Client cert from `--proxy-client-cert-file`.
4. Forwards request, adding `X-Remote-User`, `X-Remote-Group`, `X-Remote-Extra-*` headers.
5. Extension validates client cert against requestheader CA, confirms CN is in allowed names, reads `X-Remote-*` as caller identity. Optionally posts a SubjectAccessReview back for fine-grained RBAC.
6. Response streamed back unchanged.

The proxy client cert is the **only** way an arbitrary HTTP client can set `X-Remote-User` and have an extension trust it. Spoofing fails at TLS.

### Local vs Proxied APIServices

```bash
kubectl get apiservices -o custom-columns=\
NAME:.metadata.name,SVC:.spec.service.name,LOCAL:.spec.service==null
```

`LOCAL=true` (no `spec.service`) → answered in-process by kube-apiserver (built-in or CRD). `LOCAL=false` → proxied. Every CRD also gets an auto-managed APIService entry, but with no `spec.service`.

### Why metrics specifically uses aggregation

Metrics cardinality ≈ |pods| × |containers| × samples_per_minute. A 1000-pod cluster: ~30,000 datapoints/minute, refreshed every 15s. Persisting in etcd would crush the Raft log (30,000 PUTs per refresh) and make `kubectl top` an expensive cluster-wide LIST. metrics-server holds it in RAM with constant memory budget; history is intentionally discarded (Prometheus has the long tail).

### Operational hazards

A broken APIService is a **single point of failure for an entire group**:

| Failure | Effect |
|---|---|
| Service has 0 endpoints | GET on group → `503 ServiceUnavailable` |
| Bad caBundle / TLS handshake fails | 503 + audit log `x509: signed by unknown CA` |
| Slow extension | Aggregator timeout (default 10s); discovery clients may hang up to 5s per official docs |
| `Available=False` | Discovery doc lists group unhealthy; client tools warn |
| `groupPriorityMinimum` collision | Higher number wins discovery; loser appears unreachable to clients with cached discovery |

Discovery (`/apis`) merges all groups, so a slow APIService can slow down `kubectl api-resources`, `helm template`, and any client doing discovery on every command. Run metrics-server multi-replica with a PDB.

### Decision matrix

| Goal | Mechanism |
|---|---|
| Modify behavior of existing API (default, validate, reject) | **Admission webhook** (mutating/validating) |
| Stored, validated, watched object — operators, configs | **CRD** |
| Computed/external/huge/live data — own storage | **Aggregated apiserver** |

> A CRD *can* be served by an aggregated apiserver — the [`sample-apiserver`](https://github.com/kubernetes/sample-apiserver) pattern. Rarely worth it: you give up free validation/defaulting/watch/RBAC and reimplement them. Only use for non-etcd storage of CRD-shaped objects.

### APF (API Priority and Fairness) implications

APF (GA 1.29) — admission, queueing, FlowSchema matching all happen on the kube-apiserver side **before** the proxy hop. After that, the extension enforces its own concurrency limits.

- A misbehaving aggregated apiserver can hold open kube-apiserver goroutines for `--request-timeout` (default 60s). Many concurrent clients exhausts APF quota and queues unrelated calls.
- Discovery (`/apis/<group>`) has its own implicit budget — extension expected to respond in **5s or less**; breaches show as `FailedDiscoveryCheck`.
- Cascade: metrics-server overloaded → clients retry → kube-apiserver fills concurrency → unrelated requests time out.

### What the API server does beyond proxying etcd

**"kube-apiserver is a thin REST wrapper over etcd" is wrong by a wide margin.** etcd is a linearizable KV store with **no concept of a Pod, namespace, label, or Secret**. All Kubernetes semantics live in the API server. And there is exactly **one** etcd client in the whole system — nothing else has etcd credentials, which is also why the audit log is complete and RBAC is enforceable at all.

Request pipeline, in order:

```
TLS → APF (queue admission, concurrency, FlowSchema)
    → AUTHENTICATION   → identity (system:node:<name>, system:serviceaccount:…)
    → AUTHORIZATION    → RBAC / Node authorizer / ABAC / authz webhook
    → MUTATING ADMISSION   → built-ins + MutatingAdmissionWebhooks + MutatingAdmissionPolicy
    → SCHEMA + OBJECT VALIDATION
    → VALIDATING ADMISSION → built-ins + ValidatingAdmissionWebhooks + ValidatingAdmissionPolicy (CEL, GA 1.30)
    → REGISTRY / STRATEGY  → defaulting, conversion, finalizers, deletionTimestamp, resourceVersion
    → ENCRYPTION AT REST   → KMS v2 / AES-GCM
    → etcd
  ↳ AUDIT at RequestReceived / ResponseStarted / ResponseComplete / Panic
```

- **Authentication** is where `system:node:<node-name>` comes from (client cert CN `system:node:<name>`, O `system:nodes`).
- The **Node authorizer** is a dedicated authz mode restricting each kubelet to objects relevant to *its own* node — only Secrets/ConfigMaps mounted by pods scheduled there, only its own Node, only pods bound to it. Without it, one compromised kubelet reads every Secret in the cluster.
- **Mutating admission** is why *the stored object differs materially from what you submitted*: Istio sidecars, projected SA token volumes, `imagePullSecrets`, LimitRange defaults, default StorageClass/IngressClass, `not-ready` tolerations, PriorityClass → `spec.priority`.
- **Validating admission** = ResourceQuota, PodSecurity, NamespaceLifecycle, LimitRanger, plus Gatekeeper/Kyverno. Mutation runs *before* validation deliberately, so an injected sidecar is still subject to quota.

Semantics the API server owns (not etcd, not controllers):

| Concern | What it does |
|---|---|
| Optimistic concurrency | `metadata.resourceVersion` ↔ etcd revision; `409 Conflict` |
| Patch semantics | strategic-merge (needs Go struct tags), JSON Patch (RFC 6902), JSON Merge (RFC 7386), SSA with `metadata.managedFields` |
| API version conversion | stores **one** version, converts on read/write; `v1beta1` ↔ `v1` transparent |
| Defaulting | `restartPolicy: Always`, `terminationGracePeriodSeconds: 30`, `imagePullPolicy`, `successfulJobsHistoryLimit: 3` |
| Deletion semantics | `deletionTimestamp`, `deletionGracePeriodSeconds`, finalizer blocking, `propagationPolicy` — **the object survives DELETE until finalizers clear, enforced here** |
| Name/UID generation | `generateName` suffix + collision retry, UID, `creationTimestamp`, `generation` bumping |
| Watch cache | serves most LIST/WATCH from memory; bookmarks; **consistent reads from cache** (`ConsistentListFromCache` Beta-on 1.31, **GA 1.34**, needs etcd ≥ v3.4.31/v3.5.13). Most reads never reach etcd |
| Selectors, pagination | server-side field/label filtering; `limit`/`continue` (token encodes an etcd revision + key) |
| Encryption at rest | envelope encryption — etcd only ever sees ciphertext |
| Event TTL | `--event-ttl` (default `1h0m0s`) via etcd lease |
| ClusterIP / NodePort allocation | stateful in-process allocation + repair loop for drift |
| Dry-run | full pipeline including webhooks, then discards |

Subresources with real business logic:

| Subresource | What it does |
|---|---|
| `pods/eviction` | **checks PodDisruptionBudgets** → `200` allowed / `429` blocked / `500` multiple PDBs. This is why a plain `DELETE` on a pod bypasses PDBs entirely |
| `pods/exec`, `attach`, `portforward` | authorize, upgrade (SPDY/WebSocket), stream to kubelet |
| `pods/log` | proxies to kubelet's log endpoint (`follow`, `tailLines`, `previous`) |
| `pods/binding` | how kube-scheduler assigns `spec.nodeName` |
| `pods/status` | `PrepareForUpdate` forces `spec = oldSpec` and `deletionTimestamp = nil`, so a status write can never mutate spec or fake a deletion |
| `pods/resize` | in-place vertical resize — Alpha 1.27, Beta 1.33, **GA 1.35** |
| `serviceaccounts/token` | signs audience-scoped, time-bound JWTs — a **crypto service**, not storage |
| `*/scale`, `*/status` | separate RBAC surface **and** separate SSA field-ownership domain |
| `nodes/proxy`, `services/proxy` | generic authorizing proxy |

Services offered to other components: **TokenReview** (kubelet uses it to authenticate callers to its own `:10250`, e.g. metrics-server), **SubjectAccessReview** (kubelet authorizes them; also `kubectl auth can-i` and aggregated-apiserver fine-grained authz), **CertificateSigningRequest** (API hosted here; signing done by KCM's signer controllers), the aggregation layer and CRD machinery (above), `/openapi/v2` + `/openapi/v3` (`kubectl explain`, client-side apply), `/healthz` `/livez` `/readyz` `/metrics`.

**What it deliberately does NOT do: reconciliation.** No control loops — strictly request/response plus watch.

> API server = synchronous validation, admission, persistence, notification.
> Controllers = asynchronous reconciliation toward desired state.

Bootstrap-ish exceptions that prove the rule: it reconciles the default `kubernetes` Service's endpoints, runs repair loops for ClusterIP/NodePort allocation drift, and re-reconciles bootstrap RBAC (`system:*` ClusterRoles) on startup.

**Tying it back:** when a kubelet sends `DELETE pods/x?gracePeriodSeconds=0`, the API server runs APF → authn (`system:node:<node>`) → **Node authorizer** (is this pod bound to *this* node?) → admission (DELETE webhooks get `object: null`, `oldObject: <pod>`, `options: <DeleteOptions>`) → registry (UID precondition, finalizers empty?) → etcd delete → audit → watch fan-out. **Kubelet asks; the API server decides.** See [[notes/K8s/pod-deletion-lifecycle-and-garbage-collection|Pod Deletion Lifecycle & GC]].

## Quick Reference

### Routing diagram

```
incoming HTTPS request
        │
        ▼
┌────────────────────────────────┐
│         kube-apiserver         │
│ authn → authz → admission       │
│                                │
│       path / group dispatch    │
│   ┌──────┬───────────┬──────┐  │
│   ▼      ▼           ▼      │  │
│ built-in CRD       aggregation │
│ Go       (from CRD layer (proxy)│
│ handler  object)              │
│   │      │           │       │
│   ▼      ▼           ▼       │
│ etcd    etcd     backing Svc │
└──────────────────────────│───┘
                           ▼
                 extension apiserver pod
                 (its own storage)
```

### Inspection commands

```bash
kubectl get apiservices                                      # all
kubectl get apiservices -o jsonpath='{range .items[?(@.spec.service)]}{.metadata.name}{"\t"}{.spec.service.namespace}/{.spec.service.name}{"\n"}{end}'
kubectl get apiservices -o custom-columns=NAME:.metadata.name,AVAILABLE:.status.conditions[0].status,REASON:.status.conditions[0].reason
kubectl get --raw /apis/apps/v1 | jq                          # built-in
kubectl get --raw /apis/cert-manager.io/v1 | jq               # CRD
kubectl get --raw /apis/metrics.k8s.io/v1beta1 | jq           # aggregated
kubectl describe apiservice v1beta1.metrics.k8s.io
kubectl get endpoints -n kube-system metrics-server
```

`status.conditions[*].reason`: `ServiceNotFound`, `MissingEndpoints`, `FailedDiscoveryCheck` (call to extension's `/apis/<group>/<version>` returned non-200 within 5s), `Passed`.

### Key flags table

| Side | Flag | Purpose |
|---|---|---|
| kube-apiserver | `--proxy-client-cert-file` / `-key-file` | mTLS client identity for proxying |
| kube-apiserver | `--requestheader-client-ca-file` | CA the extension uses to verify proxy client |
| kube-apiserver | `--requestheader-{username,group,extra-headers-prefix}-headers` | Header names to set/expect |
| kube-apiserver | `--request-timeout` (60s default) | Bound proxied call duration |
| Extension | (reads) `kube-system/extension-apiserver-authentication` ConfigMap | Pulls CAs and header names auto-published by kube-apiserver |

## Key Takeaways

- Three categories: built-in (compiled in), CRDs (dynamic inside kube-apiserver), aggregated (proxied to a separate pod). Built-in and CRDs share the etcd path; aggregated owns its own storage.
- For 80% of needs, a CRD is the right answer — operators, configs, controllers all use it. Aggregated apiservers exist for problems that aren't etcd-shaped (metrics, computed responses, non-etcd storage, oversize objects).
- An `APIService` with `spec.service.name` set is aggregated (LOCAL=false); without it, kube-apiserver answers locally (built-in or CRD).
- Aggregation routes via TLS reverse proxy. Authentication is delegated — kube-apiserver authenticates the user, then forwards identity in `X-Remote-*` headers, secured by mTLS via `--proxy-client-cert-file`. Spoofing fails at TLS.
- The `kube-system/extension-apiserver-authentication` ConfigMap is the trust anchor — kube-apiserver auto-publishes the requestheader CA and the extension reads it at startup.
- Metrics use aggregation specifically because high-cardinality time-series data would crush etcd. metrics-server holds the active window in RAM; Prometheus owns history.
- A broken APIService blast-radiuses the entire API group AND can slow down every `kubectl` command via discovery merging. The aggregation layer expects discovery to respond in 5s — slower replies show up as `FailedDiscoveryCheck`.
- APF (GA 1.29) admission happens before the proxy hop on the kube-apiserver side. A slow extension can still exhaust kube-apiserver goroutines holding `--request-timeout` (60s default) connections.
- For debugging: walk `kubectl get apiservices` → `describe` → check Service/Endpoints/Pods → check extension logs for `x509` or `unable to extract user from request` → end-to-end with `kubectl get --raw`.
- A CRD can technically be served by an aggregated apiserver (sample-apiserver pattern), but you give up all of kube-apiserver's free validation/defaulting/watch/RBAC machinery — only worth it for non-etcd storage of CRD-shaped data.
- kube-apiserver is **not** a thin wrapper over etcd. etcd knows keys, revisions, and range watches; everything else — schemas, defaulting, conversion, admission, RBAC, `resourceVersion`/409s, strategic-merge and SSA, finalizers and `deletionTimestamp`, subresources, encryption at rest, ClusterIP allocation, audit — is API-server logic. It is the **only** etcd client in the system.
- Several subresources carry real business logic, not just a storage split: `pods/eviction` holds the **PDB check** (which is exactly why a plain `DELETE` on a pod bypasses PDBs), `serviceaccounts/token` is a JWT signing service, `pods/binding` is how the scheduler assigns a node, and `pods/status` structurally cannot mutate spec or fake a deletion.
- The API server runs **no reconciliation loops** (bar a few bootstrap repair loops: default `kubernetes` Service endpoints, ClusterIP/NodePort drift, bootstrap RBAC). Synchronous validation/admission/persistence/notification here; asynchronous reconciliation in kube-controller-manager.
- `TokenReview` and `SubjectAccessReview` are the generic "outsource the decision to the API server" primitives — the kubelet uses both to secure its own `:10250` port, and aggregated apiservers use SAR for fine-grained authz after delegated authentication.
