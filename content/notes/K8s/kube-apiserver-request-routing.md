---
title: "kube-apiserver Request Routing: Built-in, CRD, and Aggregated APIs"
---

## Overview

`kube-apiserver` is the only component that talks to etcd and the only entry point for client requests. From the outside it serves one giant REST tree (`/api/v1/...`, `/apis/apps/v1/...`, `/apis/cert-manager.io/v1/...`, `/apis/metrics.k8s.io/v1beta1/...`). From the inside, those paths are answered by **three completely different machines**:

| Category | Where the handler lives | Where data lives | Examples |
|---|---|---|---|
| Built-in APIs | Compiled into `kube-apiserver` | etcd (via `kube-apiserver`) | `core/v1`, `apps/v1`, `batch/v1`, `networking.k8s.io/v1` |
| CRDs | Generated dynamically inside `kube-apiserver` from a `CustomResourceDefinition` | etcd (via `kube-apiserver`) | `cert-manager.io/v1`, `keda.sh/v1alpha1`, your operators |
| Aggregated APIs | Separate pod, registered via `APIService` | Whatever that pod chooses (RAM, SQL, separate etcd, no storage) | `metrics.k8s.io`, `custom.metrics.k8s.io`, `external.metrics.k8s.io`, `sample-apiserver` |

A request walks the dispatch tree once and never crosses categories. Knowing which serves a request is the difference between "scale metrics-server" and "look at etcd metrics" when something breaks.

```
                    incoming HTTPS request
                              │
                              ▼
            ┌────────────────────────────────────┐
            │           kube-apiserver           │
            │ authn → authz → mutating admission │
            │      → validating admission        │
            │                                    │
            │       path / group dispatch        │
            │   ┌────────┬────────────┬────────┐ │
            │   ▼        ▼            ▼        │ │
            │ built-in  CRD       aggregation  │ │
            │ Go        (from CRD layer        │ │
            │ handler   object)   (proxy)      │ │
            │   │        │            │        │ │
            │   ▼        ▼            ▼        │ │
            │  etcd     etcd      backing Svc  │ │
            └─────────────────────────│────────┘
                                      ▼
                          extension apiserver pod
                          (its own storage)
```

Related: [[notes/K8s/extension_api_server_storage|Extension API Server Storage]] for the "what if I want my own storage" angle.

---

## Built-in (Native) APIs

Schemas are Go structs in [`k8s.io/api`](https://github.com/kubernetes/api), handlers are Go code in [`k8s.io/kubernetes`](https://github.com/kubernetes/kubernetes), storage runs straight to etcd via the `genericregistry` package.

Representative groups: `core/v1` (Pod, Service, Namespace, Node, ConfigMap, Secret, PV, ServiceAccount, Endpoints, ResourceQuota, LimitRange), `apps/v1` (Deployment, ReplicaSet, StatefulSet, DaemonSet), `batch/v1` (Job, CronJob), `networking.k8s.io/v1` (Ingress, IngressClass, NetworkPolicy), `discovery.k8s.io/v1` (EndpointSlice), `policy/v1` (PDB), `rbac.authorization.k8s.io/v1`, `coordination.k8s.io/v1` (Lease), `storage.k8s.io/v1`, plus the two registration APIs themselves: `apiextensions.k8s.io/v1` (CRDs) and `apiregistration.k8s.io/v1` (APIService).

### Request Path

```
GET /api/v1/namespaces/default/pods/web

  → kube-apiserver ServeHTTP
  → APIRequestInfoResolver: {api: core, version: v1, resource: pods, ns: default, name: web}
  → authn (token / cert / SA) → authz (RBAC SAR) → admission (audit only on GET)
  → core handler chain → REST storage for "pods"
  → etcd3.Storage.Get("pods/default/web")
  → deserialize, convert, return JSON
```

No proxy hop, no CRD, nothing dynamic. Compiled-in handler, direct etcd path.

### Operational Notes

- Versioned with the Kubernetes release; schema changes go through KEPs and feature gates, not runtime config.
- Share kube-apiserver's etcd budget under `--etcd-prefix` (default `/registry`).
- Cannot be removed at runtime; you upgrade or downgrade kube-apiserver.

---

## Custom Resource Definitions (CRDs)

A *runtime extension* served entirely **inside** kube-apiserver. You declare the resource via a `CustomResourceDefinition`, and kube-apiserver generates REST handlers indistinguishable from built-ins.

**Inside kube-apiserver (free):** URL routing, OpenAPI v3 validation, defaulting (CEL since 1.25, GA 1.30), etcd storage, watch streams (multiplexed off etcd watch), conversion (via webhook for multi-version), `status`/`scale` subresources.

**Outside (your code, optional):** validating/mutating admission webhooks for advanced rules, conversion webhook, the operator that reconciles the CR.

### Request Path

```
POST /apis/cert-manager.io/v1/namespaces/prod/certificates

  → APIRequestInfoResolver: group=cert-manager.io, v=v1, resource=certificates
  → CRD lookup (informer cache): name=certificates.cert-manager.io
       confirms schema, served version, storage version=v1
  → authn / authz (RBAC, identical to built-ins)
  → admission: mutating webhooks → schema validation → validating webhooks
  → etcd3.Storage.Create("cert-manager.io/v1/certificates/prod/<name>")
  → 201 Created
```

Same etcd, same admission chain, same authz layer as built-ins. Only difference: schema came from a CRD object loaded at runtime instead of a Go struct compiled in.

### CRD vs Aggregated: the Decision

| Need | CRD | Aggregated |
|---|---|---|
| Stored, validated, watched object with `kubectl` parity | yes (perfect fit) | possible but heavy |
| Computed-on-demand answer (metrics, derived state) | poor (must persist) | good |
| Custom storage backend (SQL, blob, time series) | impossible | yes |
| Object > 1.5 MiB | rejected at write | yes (you own the limits) |
| Watch experience without writing the cache | included for free | implement yourself |
| Minutes-to-implement budget | yes | no — Go binary, deploy, RBAC, certs |

Most extensions in real clusters (Istio, cert-manager, KEDA's CRDs, ArgoCD, Crossplane, Tekton, every operator) are CRD-based. Aggregated apiservers are reserved for inherently non-storage problems.

> **Note:** The 1.5 MiB limit comes from etcd's `--max-request-bytes` and kube-apiserver's matching defaults; it's a soft target, not a hard ceiling. But large CRs balloon the watch cache, OpenAPI validation, and JSON serialization regardless. Aggregated APIs let you shard or compress; etcd-backed CRDs do not.

### Storage Layout in etcd

```
/registry/<group>/<resource>/<namespace>/<name>     (namespaced)
/registry/<group>/<resource>/<name>                  (cluster-scoped)

e.g. /registry/cert-manager.io/certificates/prod/web-tls
     /registry/keda.sh/scaledobjects/prod/worker-scaler
```

CRDs share the same prefix scheme as built-ins.

---

## Aggregated APIs

The path used by `metrics.k8s.io`, `custom.metrics.k8s.io`, `external.metrics.k8s.io`, and any extension that needs a backend outside etcd. kube-apiserver becomes a TLS reverse proxy; actual handling happens in a separate pod.

### The Wiring

A `Service` plus an `APIService`:

```yaml
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1beta1.metrics.k8s.io        # = "<version>.<group>"
spec:
  group:   metrics.k8s.io
  version: v1beta1
  service: { name: metrics-server, namespace: kube-system }
  caBundle: <PEM CA verifying the backing Service's cert>
  groupPriorityMinimum: 100
  versionPriority: 100
```

The aggregator (built-in inside kube-apiserver) caches the registry. On each request, if the path matches a registered group/version that is **not** served locally, it: looks up Service endpoints → opens TLS to one (round-robin, retry) → presents the proxy-client cert → forwards the request with delegated-auth headers → streams the response back.

### Authentication Delegation

The aggregated apiserver does **not** re-authenticate the original client. It trusts kube-apiserver via the official "request-header" authenticator.

Flags on **kube-apiserver** (the proxying side):

| Flag | Purpose |
|---|---|
| `--proxy-client-cert-file` | Client cert kube-apiserver presents to the extension |
| `--proxy-client-key-file` | Private key for the above |
| `--requestheader-client-ca-file` | CA used by the extension to verify incoming proxy clients |
| `--requestheader-allowed-names` | Permitted CNs on the proxy client cert (empty = any signed by CA) |
| `--requestheader-username-headers` | Header carrying the username, e.g. `X-Remote-User` |
| `--requestheader-group-headers` | Header carrying groups, e.g. `X-Remote-Group` |
| `--requestheader-extra-headers-prefix` | Prefix for extra info, e.g. `X-Remote-Extra-` |

kube-apiserver auto-publishes the public halves into a ConfigMap the extension reads at startup:

```
ConfigMap: kube-system/extension-apiserver-authentication
data:
  client-ca-file:                <PEM bundle for client-cert authn>
  requestheader-client-ca-file:  <PEM proxy CA the extension trusts>
  requestheader-allowed-names:        '["aggregator"]'
  requestheader-extra-headers-prefix: '["X-Remote-Extra-"]'
  requestheader-group-headers:        '["X-Remote-Group"]'
  requestheader-username-headers:     '["X-Remote-User"]'
```

End-to-end for `kubectl top pod`:

```
1. kubectl → kube-apiserver
   authn (bearer/mTLS), authz (RBAC: get pods.metrics.k8s.io)

2. kube-apiserver looks up APIService(v1beta1.metrics.k8s.io)
   → backing Service kube-system/metrics-server:443

3. Opens TLS to a metrics-server pod IP.
   - Server cert verified against APIService.spec.caBundle
   - Client cert from --proxy-client-cert-file presented

4. Forwards original request, adding:
       X-Remote-User:  alice@example.com
       X-Remote-Group: developers
       X-Remote-Group: system:authenticated
       X-Remote-Extra-scopes: ["read"]

5. metrics-server:
   - Validates client cert against requestheader CA from the
     extension-apiserver-authentication ConfigMap.
   - Confirms CN is in --requestheader-allowed-names.
   - Reads X-Remote-User/Group as caller identity.
   - (Optional) issues SubjectAccessReview back to kube-apiserver
     for fine-grained RBAC against its own resources.
   - Returns JSON.

6. kube-apiserver streams the response back to kubectl unchanged.
```

The proxy client cert is the **only** way an arbitrary HTTP client can set `X-Remote-User` and have an extension apiserver believe it. Without the cert, those headers are meaningless — TLS rejects the connection before the headers matter.

### Local vs Proxied APIServices

```
$ kubectl get apiservices -o custom-columns=\
NAME:.metadata.name,SVC:.spec.service.name,LOCAL:.spec.service==null

NAME                              SVC                  LOCAL
v1.                               <none>               true
v1.apps                           <none>               true
v1beta1.metrics.k8s.io            metrics-server       false
v1beta2.custom.metrics.k8s.io     prometheus-adapter   false
v1.cert-manager.io                <none>               true   ← CRD
v1alpha1.keda.sh                  <none>               true   ← CRD
```

`LOCAL=true` (no `spec.service`) → kube-apiserver answers itself (built-in or CRD). `LOCAL=false` → aggregator proxies to a backing pod. Every CRD also gets an auto-managed APIService entry, but with no `spec.service`, so it's "local".

### Why Metrics Specifically Uses Aggregation

```
Cardinality ≈ |pods| × |containers| × samples_per_minute
A 1000-pod cluster ≈ 30,000 datapoints/minute, refreshed every 15s

If stored in etcd:
  - every refresh = 30,000 PUTs → write amplification on the Raft log
  - kubectl top = expensive cluster-wide LIST

If served from RAM by metrics-server:
  - constant memory budget proportional to live pod count
  - GET = map lookup, no etcd round-trip
  - history is intentionally discarded; Prometheus has the long tail
```

No benefit to persisting metrics in etcd, large cost. Aggregation is the right hammer.

### Operational Hazards

A broken APIService is a **single point of failure for an entire group**:

| Failure mode | Effect |
|---|---|
| Service has 0 endpoints | GET on group → `503 ServiceUnavailable` |
| TLS handshake fails (bad caBundle) | 503; audit logs note `x509: certificate signed by unknown CA` |
| Service responds slowly | Aggregator timeout (default 10s); discovery clients may hang up to 5s per official aggregation-layer docs |
| `APIService.status.Available=False` | Discovery doc lists the group unhealthy; client tools warn |
| `groupPriorityMinimum` collision | Higher number wins discovery; loser appears unreachable to clients caching discovery |

Discovery (`/apis`) merges all groups, so a slow APIService can slow down `kubectl api-resources`, `helm template`, and any client doing discovery on each command. This is why `metrics-server` is run as a multi-replica Deployment with a PDB.

---

## Decision Matrix

| Goal | Mechanism |
|---|---|
| Modify behavior of an existing API (default, validate, reject) | **Admission webhook** (mutating / validating) |
| Stored, validated, watched object — operators, configs | **CRD** (cert-manager, KEDA, Argo, Crossplane) |
| Computed / external / huge / live data — own storage | **Aggregated apiserver** (metrics-server pattern) |

Admission webhooks are listed for completeness — they don't add new APIs, they intercept existing ones. See [Dynamic Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/).

> **Note:** A CRD *can* technically be served by an aggregated apiserver — the [`sample-apiserver`](https://github.com/kubernetes/sample-apiserver) pattern. You build an extension apiserver that registers CRD-shaped types. Rarely worth it: you give up kube-apiserver's free implementation (validation, defaulting, watch, RBAC integration, OpenAPI publishing) and reimplement it. Use only when you need a non-etcd storage layer for objects that otherwise behave like CRDs.

---

## Inspecting and Debugging Routing

```bash
# Discovery: what groups exist and which mechanism serves each
kubectl get apiservices

# Filter to only aggregated (proxied) APIServices
kubectl get apiservices -o jsonpath='{range .items[?(@.spec.service)]}{.metadata.name}{"\t"}{.spec.service.namespace}/{.spec.service.name}{"\n"}{end}'

# Status of all APIServices (some may be Unavailable)
kubectl get apiservices -o custom-columns=\
NAME:.metadata.name,AVAILABLE:.status.conditions[0].status,REASON:.status.conditions[0].reason

# Per-category discovery
kubectl get --raw /apis/apps/v1 | jq                 # built-in
kubectl get --raw /apis/cert-manager.io/v1 | jq      # CRD
kubectl get --raw /apis/metrics.k8s.io/v1beta1 | jq  # aggregated

kubectl get crds

# When an aggregated API fails:
kubectl describe apiservice v1beta1.metrics.k8s.io
kubectl get endpoints -n kube-system metrics-server
kubectl logs -n kube-system deployment/metrics-server --tail=200
```

`status.conditions` on the APIService tells you whether the aggregator can reach it. `Available=False` reasons: `ServiceNotFound` (no Service), `MissingEndpoints` (Service exists, no ready pods), `FailedDiscoveryCheck` (call to extension's `/apis/<group>/<version>` returned non-200 within 5s).

---

## API Priority and Fairness Implications

Aggregated APIs share kube-apiserver's request pipeline up to the proxy hop. **API Priority and Fairness** (APF, GA in 1.29) — queue admission, concurrency, and FlowSchema matching — happens on the kube-apiserver side **before** the proxy hop. After the hop, the extension enforces its own concurrency limits.

Practical consequences:
- A misbehaving aggregated apiserver can hold open hundreds of in-flight requests in kube-apiserver. Set `--request-timeout` (default 60s) and tune APF `FlowSchema` to bound impact.
- Discovery requests (`/apis/<group>`) are a hot path — keep them fast.
- Cascade: metrics-server overloaded → clients retry → kube-apiserver fills concurrency budget → unrelated requests time out. Real, observed in large clusters.

---

## What the API Server Does Beyond Proxying etcd

The routing story above answers *where* a request is handled. This section answers a different question that comes up constantly: **if etcd is the database, what is the API server actually for?**

The framing "kube-apiserver is a thin REST wrapper over etcd" is wrong by a wide margin. etcd is the *dumb* part — a linearizable key/value store with no notion of a Pod, a namespace, or a label. **Every piece of Kubernetes semantics lives in the API server.** It is a policy-and-semantics engine that happens to persist to etcd.

And there is exactly one path to etcd:

```
kubelet ─┐
scheduler┤
KCM      ├──── HTTPS ────▶ kube-apiserver ────▶ etcd
operators┤                (the ONLY etcd client)
kubectl ─┘

Nothing else in Kubernetes has etcd credentials. A hard architectural
invariant — which is also why the audit log is complete, why RBAC is
enforceable at all, and why encryption-at-rest works.
```

### The Request Pipeline, In Order

```
   TLS handshake
        │
        ▼
   API Priority & Fairness  ── queue admission, concurrency shares, FlowSchema
        │                      (see "API Priority and Fairness Implications" above)
        ▼
   AUTHENTICATION           ── x509 client certs, ServiceAccount JWTs, OIDC,
        │                      authenticating webhook, bootstrap tokens
        │                      ⇒ produces the identity: system:node:<name>,
        │                        system:serviceaccount:<ns>:<sa>, alice@corp
        ▼
   AUTHORIZATION            ── RBAC, Node authorizer, ABAC, authz webhook
        │                      (modes run in order; first ALLOW wins)
        ▼
   MUTATING ADMISSION       ── built-in plugins, then MutatingAdmissionWebhooks,
        │                      then MutatingAdmissionPolicy (CEL)
        ▼
   SCHEMA + OBJECT VALIDATION  ── OpenAPI structural schema, then Go validation
        │                          (or CEL x-kubernetes-validations for CRDs)
        ▼
   VALIDATING ADMISSION     ── built-in plugins, ValidatingAdmissionWebhooks,
        │                      ValidatingAdmissionPolicy (CEL, GA 1.30)
        ▼
   REGISTRY / STRATEGY      ── defaulting, version conversion, finalizer
        │                      handling, deletionTimestamp, subresource logic,
        │                      resourceVersion / optimistic concurrency
        ▼
   ENCRYPTION AT REST       ── envelope encryption (KMS v2 / AES-GCM)
        │
        ▼
      etcd

   ╰──▶ AUDIT events emitted at RequestReceived / ResponseStarted /
        ResponseComplete / Panic, per the configured audit policy
```

Stage-by-stage, what actually matters:

- **Authentication** is where `system:node:<node-name>` comes from. The kubelet presents a client certificate whose CN is `system:node:<name>` and whose O is `system:nodes`. That identity is what makes the next stage possible.
- **Authorization** — beyond RBAC, the **Node authorizer** is a dedicated authz mode that restricts each kubelet to objects relevant to *its own* node: only the Secrets/ConfigMaps mounted by pods scheduled there, only its own Node object, only pods bound to it. Without it, a single compromised kubelet could read every Secret in the cluster. This is why the finalizing `DELETE` a kubelet sends for a terminating pod is safe to permit at all.
- **Mutating admission** is why *the object you submitted is not the object that gets stored*. Built-in plugins plus webhooks inject Istio sidecars, mount the projected ServiceAccount token volume, add `imagePullSecrets` from the SA, apply `LimitRange` defaults, default the StorageClass / IngressClass, add `node.kubernetes.io/not-ready` tolerations, and set `spec.priority` from the PriorityClass. Compare `kubectl get pod -o yaml` against your manifest and count the differences.
- **Validating admission** is `ResourceQuota`, `PodSecurity`, `NamespaceLifecycle` (rejects creates in a Terminating namespace), `LimitRanger`, plus Gatekeeper / Kyverno policies. Note the ordering: mutation happens *before* validation deliberately, so a sidecar injected by a webhook is still subject to quota.
- **Audit** exists precisely because the API server is the universal chokepoint. Every mutation in the cluster passes through here, so a single audit policy captures everything.

### Semantics the API Server Owns (Not etcd, Not Controllers)

| Concern | What the API server does |
|---|---|
| Optimistic concurrency | Maps `metadata.resourceVersion` ↔ etcd revision; returns `409 Conflict` on a stale write. etcd has revisions; *pods* having resourceVersions is the API server's invention. |
| Patch semantics | Strategic-merge patch (needs Go struct tags — etcd cannot do this), JSON Patch (RFC 6902), JSON Merge Patch (RFC 7386), and Server-Side Apply with per-field ownership tracked in `metadata.managedFields` |
| API version conversion | Stores **one** version, converts on read and write. `v1beta1` ↔ `v1` is transparent to clients; etcd holds only the storage version |
| Defaulting | Fills unset fields from the schema before persisting (`imagePullPolicy`, `restartPolicy: Always`, `terminationGracePeriodSeconds: 30`, `dnsPolicy`, `successfulJobsHistoryLimit: 3`) |
| Deletion semantics | `deletionTimestamp`, `deletionGracePeriodSeconds`, finalizer blocking, `propagationPolicy`. **The object survives a `DELETE` until finalizers clear — enforced here, not by any controller.** See [[notes/K8s/pod-deletion-lifecycle-and-garbage-collection\|Pod Deletion Lifecycle & GC]] |
| Name / UID generation | `metadata.generateName` → random suffix with collision retry, UID assignment, `creationTimestamp`, `generation` bumping |
| Watch cache | Serves most LIST/WATCH from an in-memory reflector per resource; emits `Bookmark` events; **consistent reads served from cache** (`ConsistentListFromCache`: Beta-on 1.31, GA 1.34, needs etcd ≥ v3.4.31 / v3.5.13 for watch-progress). Most reads never reach etcd at all |
| Field & label selectors, pagination | Server-side filtering, plus `limit`/`continue` chunking (the `continue` token encodes an etcd revision + key) |
| Encryption at rest | Envelope encryption of Secrets and other configured resources — etcd only ever sees ciphertext |
| Event TTL | `--event-ttl` (default `1h0m0s`) implemented as an etcd lease on Event keys |
| ClusterIP / NodePort allocation | Stateful in-process allocation from the Service CIDR and the node-port range, with a repair loop for drift |
| Dry-run | Runs the *entire* pipeline — including webhooks — then discards instead of persisting |

### Subresources with Real Business Logic

A subresource is not merely a storage split; several carry behavior that exists nowhere else.

| Subresource | What it does |
|---|---|
| `pods/eviction` | **Checks PodDisruptionBudgets.** Returns `200` (allowed, then deletes), `429 Too Many Requests` (budget would be violated), `500` (pod covered by multiple PDBs). This PDB logic lives *in the API server* — which is exactly why a plain `DELETE` on a pod bypasses PDBs entirely |
| `pods/exec`, `pods/attach`, `pods/portforward` | Authorizes, upgrades the connection (SPDY or WebSocket), and streams bidirectionally to the kubelet |
| `pods/log` | Proxies to the kubelet's log endpoint; handles `follow`, `tailLines`, `previous` |
| `pods/binding` | How kube-scheduler assigns `spec.nodeName`. The scheduler never PATCHes the pod spec directly |
| `pods/status` | The only way kubelet reports phase/conditions. `PrepareForUpdate` here explicitly forces `spec = oldSpec` and `deletionTimestamp = nil`, so a status write can never mutate the spec or fake a deletion |
| `pods/resize` | In-place vertical resource resize. Alpha 1.27, Beta 1.33, **GA 1.35** (`InPlacePodVerticalScaling`) |
| `serviceaccounts/token` | Issues signed, audience-scoped, time-bound JWTs (TokenRequest API). This is a **cryptographic service**, not storage |
| `*/scale` | A uniform `Scale` shape over Deployment/RS/StatefulSet, and the surface HPA writes to |
| `*/status` generally | A separate RBAC surface *and* a separate Server-Side-Apply field-ownership domain, so a controller owning `status` cannot clobber user-owned `spec` |
| `nodes/proxy`, `services/proxy` | Generic authorizing proxy into the cluster |

### Services the API Server Provides to Other Components

- **TokenReview** (`authentication.k8s.io/v1`) — the kubelet uses it to authenticate requests hitting its *own* `:10250` API. So when metrics-server scrapes a kubelet, the kubelet turns around and asks the API server "is this token valid?"
- **SubjectAccessReview** (`authorization.k8s.io/v1`) — the kubelet then asks "is this identity allowed to read `nodes/metrics`?" Also what `kubectl auth can-i` calls, and what aggregated apiservers use for fine-grained authz after delegated authentication (see the delegation flow above).
- **CertificateSigningRequest** — the API is hosted here; the actual *signing* is done by kube-controller-manager's signer controllers. This is the node bootstrap path (`kubelet-serving`, `kube-apiserver-client-kubelet`).
- **The aggregation layer** and **CRD machinery** — covered in detail earlier in this note.
- **`/openapi/v2` and `/openapi/v3`** — how `kubectl explain`, client-side apply, and schema-aware tooling discover types.
- **`/healthz`, `/livez`, `/readyz`** (`?verbose` for per-check breakdown) and **`/metrics`**.

### What It Deliberately Does *Not* Do

**Reconciliation.** There are no control loops in the API server. It is strictly request/response plus watch. Desired-state convergence is kube-controller-manager's job.

```
kube-apiserver  =  synchronous validation, admission, persistence, notification
controllers     =  asynchronous reconciliation toward desired state
```

A handful of bootstrap-ish exceptions prove the rule rather than break it: it reconciles the endpoints of the default `kubernetes` Service in `default`, runs repair loops for ClusterIP / NodePort allocation drift, and re-reconciles bootstrap RBAC (`system:*` ClusterRoles and bindings) on every startup so you cannot permanently lock yourself out.

### Tying It Back: One Line of a Pod Deletion

When a kubelet finishes tearing down a terminating pod and sends the finalizing delete:

```
DELETE /api/v1/namespaces/prod/pods/api-8545cb-h4k2p?gracePeriodSeconds=0
  Authorization: Bearer <or mTLS client cert>
  body: DeleteOptions{ gracePeriodSeconds: 0, preconditions: { uid: "..." } }

  ① APF        → admitted to a flow queue
  ② authn      → identity = system:node:gke-pool-a-9x7q  (x509 CN)
  ③ authz      → Node authorizer: is this pod bound to THIS node? yes → allow
  ④ admission  → any DELETE webhooks matching pods get an AdmissionReview
                 with object:null, oldObject:<pod>, options:<DeleteOptions>
  ⑤ registry   → UID precondition matches? finalizers empty? yes to both
  ⑥ etcd       → DELETE /registry/pods/prod/api-8545cb-h4k2p
  ⑦ audit      → methodName io.k8s.core.v1.pods.delete,
                 principalEmail system:node:gke-pool-a-9x7q
  ⑧ watch      → DELETED event fanned out to every informer
```

"Kubelet deleted the pod" is really *kubelet asked and the API server decided*. Full breakdown in [[notes/K8s/pod-deletion-lifecycle-and-garbage-collection|Pod Deletion Lifecycle, Garbage Collection, and Who Actually Deletes a Pod]].

---

## See also

- [[notes/K8s/pod-deletion-lifecycle-and-garbage-collection|Pod Deletion Lifecycle & Garbage Collection]] — the deletion semantics, finalizers, admission-on-DELETE, and `pods/eviction` PDB logic described above, end to end.
- [[notes/K8s/hpa-vpa-autoscaling|HPA / VPA / metrics-server / Custom + External Metrics]] — canonical real-world example of all three categories at once.
- [[notes/K8s/extension_api_server_storage|Extension API Server Storage]] — storage choices once you go aggregated.
- [[notes/K8s/kubernetes|Kubernetes Concepts]] — DaemonSets, taints, scheduling primitives.
- Official: [API Aggregation Layer](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/apiserver-aggregation/)
- Official: [Configure the aggregation layer](https://kubernetes.io/docs/tasks/extend-kubernetes/configure-aggregation-layer/)
- Official: [Custom Resource Definitions](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)
- Official: [Dynamic Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/)
- Repo: [`kubernetes/sample-apiserver`](https://github.com/kubernetes/sample-apiserver)
- Repo: [`kubernetes-sigs/custom-metrics-apiserver`](https://github.com/kubernetes-sigs/custom-metrics-apiserver)
- Repo: [`kubernetes-sigs/prometheus-adapter`](https://github.com/kubernetes-sigs/prometheus-adapter)
- Repo: [`kedacore/keda`](https://github.com/kedacore/keda)

---

## Interview Prep

### Q: Differentiate built-in API, CRD, and aggregated apiserver.

**A:** They differ in *where the handler runs* and *what storage it uses*.

|  | Built-in | CRD | Aggregated |
|---|---|---|---|
| Handler | Compiled into kube-apiserver | Generated by kube-apiserver at runtime | External pod, reached via TLS proxy |
| Storage | etcd (kube-apiserver) | etcd (kube-apiserver) | Whatever the pod chooses |
| Schema source | Go structs in `k8s.io/api` | OpenAPI in CRD object | Defined by the pod's code |
| Admission | same chain | same chain | kube-apiserver runs admission for the *proxy* request only |
| Watch / list | yes (etcd-backed) | yes (etcd-backed) | pod implements (often informer-based) |
| Failure blast radius | crashes apiserver (whole cluster) | same as built-in | group-level only |
| Versioning | with k8s release | runtime via CRD update | decoupled from k8s releases |
| Examples | Pod, Deployment, Job, Service | cert-manager, keda.sh, crossplane | metrics.k8s.io, custom.metrics, external.metrics |

The 80% case is "use a CRD". Aggregation is for problems that aren't etcd-shaped.

### Q: When would you choose an aggregated apiserver over a CRD?

**A:** Three real reasons:

1. **Storage doesn't fit etcd** — metrics (high cardinality, ephemeral), logs, anything > 1.5 MiB per object, anything you want backed by SQL (joins/relations) or S3 (size).
2. **Computed responses** — the "object" doesn't exist as a row anywhere; it's derived live from the world (current memory usage, queue depth). Persisting that to etcd would be wrong, not just expensive.
3. **API behavior CRDs can't express** — non-standard subresources, custom verbs, peculiar pagination, server-streaming responses (kube-apiserver supports these for built-ins but not CRDs).

If none apply, take the CRD. Operational cost difference is large: CRDs require zero infrastructure; an aggregated apiserver is Deployment + Service + APIService + RBAC + cert plumbing.

### Q: How does authentication flow from a user to an aggregated apiserver?

**A:**

```
kubectl --token--> kube-apiserver (authn ✔, authz ✔, identity=alice/[dev])
                       │
                       │ proxies, sets:
                       │   X-Remote-User: alice
                       │   X-Remote-Group: dev, system:authenticated
                       │   X-Remote-Extra-...: ...
                       │ presents --proxy-client-cert
                       ▼
                 extension apiserver
                   - verifies TLS client cert against requestheader CA
                   - trusts X-Remote-* headers
                   - (optionally) posts SubjectAccessReview back
                     to kube-apiserver for fine-grained RBAC
```

Trust anchor is `--requestheader-client-ca-file` on kube-apiserver. The extension reads the CA from the auto-created `extension-apiserver-authentication` ConfigMap in `kube-system`. Without a valid client cert signed by that CA, headers aren't trusted — spoofing is impossible.

### Q: Can a CRD be served by an aggregated apiserver instead?

**A:** Yes — the [`sample-apiserver`](https://github.com/kubernetes/sample-apiserver) pattern. Build a Go program with `k8s.io/apiserver` that defines types like a CRD would, register an `APIService`, and write `RESTStorage` for each resource against your storage of choice (RAM, SQL, Redis, separate etcd).

Do this when: object size/volume blows past etcd's limits; you want a relational DB for richer querying; you need a feature kube-apiserver's CRD machinery doesn't expose (custom subresources beyond `status`/`scale`).

Avoid when: standard CRD features are enough — you give up kube-apiserver's free validation, defaulting, conversion, watch caching, RBAC integration, OpenAPI publishing, and have to reimplement all of them.

### Q: What's the API Priority and Fairness implication of registering an APIService?

**A:** The aggregator runs *inside* kube-apiserver, so admission, queueing, and APF FlowSchema matching happen on the kube-apiserver side **before** the proxy hop. After the hop, the extension enforces its own concurrency limits independently.

Concrete impacts:
- Bursty load on `metrics.k8s.io` (dashboards polling) is matched by an APF FlowSchema like `service-accounts`; you can write one specifically for it to isolate it.
- A *slow* extension holds open kube-apiserver goroutines for `--request-timeout` (default 60s). With many concurrent clients, that exhausts APF quota and queues unrelated calls.
- Discovery (`/apis/<group>`) has its own implicit budget — the aggregation layer expects responses in **5s or less** (per official docs); breaches show as `FailedDiscoveryCheck` on the APIService.

Operationally: monitor `apiserver_request_duration_seconds{group="<your-aggregated-group>"}` and set `failureThreshold` on the extension's readiness probe so kube-apiserver stops sending it requests if stalled.

### Q: How do you debug a failing APIService?

**A:** Walk the chain top-to-bottom:

```
1. kubectl get apiservices                     # AVAILABLE=False?
2. kubectl describe apiservice <name>          # status.conditions reason:
     ServiceNotFound        → create the Service
     MissingEndpoints       → check Deployment / Pod status
     FailedDiscoveryCheck   → TLS or network problem; see logs
     Passed                 → healthy
3. kubectl get svc/endpoints/pods -n <ns>      # endpoints empty? readiness probes? image pulls?
4. kubectl logs -n <ns> deployment/<extension>
     "x509: certificate signed by unknown CA"
       → Pod isn't trusting kube-apiserver's proxy-client cert.
         Check requestheader-client-ca-file mount + ConfigMap.
     "failed to authenticate request: unable to extract user from request"
       → Pod isn't reading X-Remote-* headers; mismatched
         requestheader-username-headers config.
5. kubectl get --raw /apis/<group>/<version> | jq
     valid JSON → proxy is fine
     503 / hang → proxy failing; back to step 3
6. kube-apiserver logs:
     "OpenAPI AggregationController: Processing item v1beta1.metrics.k8s.io"
     "Error during proxy: x509: ..."
     "no available endpoint for service ..."
```

Two common gotchas:
- `caBundle` is base64 of *PEM*, not raw DER. Mistakes cause `x509: signed by unknown CA` even though "the cert is right".
- `Service` must point at the port the extension actually serves on (typically `443`). `APIService.spec.service.port` defaults to 443; mismatches show as `connect: connection refused`.

### Q: An APIService is healthy but `kubectl top` still fails. Where else could the failure be?

**A:** The aggregation layer is healthy but the data path inside metrics-server can fail independently:

```
kube-apiserver ──✔ proxy works──> metrics-server ──scrapes /metrics/resource──> Kubelet
                                                                                  ↑
                                                                                  failures
                                                                                  here don't
                                                                                  affect
                                                                                  APIService
                                                                                  status

Common in-pod failures:
  - --kubelet-insecure-tls flag missing in self-signed clusters
  - Bad --kubelet-preferred-address-types
        (try: InternalIP,ExternalIP,Hostname)
  - NetworkPolicy blocks 10250 (kubelet read-only port)
  - metrics-server too small; OOMKilled silently
```

The APIService check is just a discovery probe; it doesn't validate the data flow. Always cross-check with `kubectl get --raw` against a real metric URL and inspect `metrics-server` logs.

### Q: What happens at the wire-level when a client lists `/apis/`?

**A:** That's the **discovery** call kubectl uses on every command (cached locally for a few minutes). kube-apiserver merges three sources:

```
GET /apis HTTP/1.1
  → kube-apiserver builds the response on the fly:
       (1) hardcoded list of built-in groups
       (2) every CRD currently registered (informer cache)
       (3) every APIService currently registered (informer cache)
       (4) for aggregated groups, a 5s-budget GET to each extension's
           /apis/<group>/<version> to check it's actually serving
           (failures mark the group's status condition False)
  → giant JSON list; cached client-side under ~/.kube/cache

If an aggregated apiserver is *very slow*, the discovery merge slows down
every kubectl call until the client cache rebuilds.
```

This is why one broken aggregated apiserver can degrade *every* `kubectl` command — discovery is on the hot path. The aggregator's discovery cache (refreshed every 30s by default) mitigates but doesn't eliminate it.

### Q: If etcd is the database, what does kube-apiserver actually add? Isn't it just a REST wrapper?

**A:** It is the opposite of a thin wrapper. etcd is a linearizable key/value store with **no concept of a Pod, a namespace, a label, or a Secret**. Every Kubernetes semantic lives in the API server.

```
                     etcd knows          kube-apiserver knows
                     ──────────          ───────────────────
keys/values              ✔                       ✔
revisions                ✔              resourceVersion + 409 Conflict
watch on a key range     ✔              typed watch cache, bookmarks, selectors
                         ✗              schemas, defaulting, validation
                         ✗              API version conversion (v1beta1 ↔ v1)
                         ✗              admission (mutating + validating)
                         ✗              RBAC / Node authorizer
                         ✗              deletionTimestamp + finalizers
                         ✗              strategic-merge patch, Server-Side Apply
                         ✗              subresources (eviction, exec, log, token)
                         ✗              encryption at rest (etcd sees ciphertext)
                         ✗              ClusterIP / NodePort allocation
                         ✗              audit
```

Concrete proof points to reach for in an interview:

1. **Your object is not what you submitted.** Mutating admission injects sidecars, SA token volumes, `imagePullSecrets`, LimitRange defaults, PriorityClass values. `diff` your manifest against `kubectl get -o yaml`.
2. **`pods/eviction` contains PodDisruptionBudget logic.** A plain `DELETE` on the same pod bypasses PDBs completely. That asymmetry only makes sense if the business logic lives in the API server, not in etcd or a controller.
3. **`serviceaccounts/token` is a crypto service** — it signs audience-scoped, time-bound JWTs. Nothing about that is storage.
4. **Deletion is not deletion.** A `DELETE` on an object with finalizers writes `deletionTimestamp` and keeps the etcd key. Enforced in the registry layer, not by any controller.
5. **Most reads never touch etcd.** The watch cache serves LIST/WATCH from memory, and since `ConsistentListFromCache` (Beta-on 1.31, GA 1.34) even *consistent* lists are served from cache using etcd watch-progress notifications.

The one thing it deliberately does **not** do is reconcile. No control loops (bar a few bootstrap repair loops: the default `kubernetes` Service endpoints, ClusterIP/NodePort allocation drift, bootstrap RBAC). The clean line: **API server = synchronous validation, admission, persistence, notification. Controllers = asynchronous reconciliation.**

### Q: A kubelet sends `DELETE pods/x?gracePeriodSeconds=0`. Walk the request through the API server.

**A:** Every stage does real work, and the answer shows why "kubelet deletes the pod" is a misstatement.

```
① APF          FlowSchema match (kubelet traffic → system-node-high or similar);
               admitted to a queue with a concurrency share
② AUTHN        x509 client cert, CN=system:node:gke-pool-a-9x7q, O=system:nodes
               ⇒ identity established
③ AUTHZ        Node authorizer (not plain RBAC): may this kubelet delete THIS
               pod? Only if pod.spec.nodeName == this node. Otherwise 403.
               ← this is what stops one compromised kubelet from deleting
                 pods (or reading Secrets) cluster-wide
④ ADMISSION    matching DELETE webhooks get an AdmissionReview with
               object: null, oldObject: <the pod as persisted>,
               options: <DeleteOptions incl. gracePeriodSeconds: 0>
               failurePolicy: Fail + webhook down ⇒ the delete is BLOCKED
⑤ REGISTRY     UID precondition matches? (guards against deleting a recreated
               pod of the same name).  finalizers empty? if not → the key STAYS
               and only deletionTimestamp is (re)written
⑥ etcd         DELETE /registry/pods/prod/x     ← the only actual etcd call
⑦ AUDIT        methodName: io.k8s.core.v1.pods.delete
               principalEmail: system:node:gke-pool-a-9x7q
⑧ WATCH        DELETED event fanned out to every informer (RS controller,
               EndpointSlice controller, your operator, kubectl -w)
```

Six of those eight stages are pure API-server policy. The kubelet **requested**; the API server **decided**. Full deletion-lifecycle breakdown in [[notes/K8s/pod-deletion-lifecycle-and-garbage-collection|Pod Deletion Lifecycle & Garbage Collection]].

### Q: Why does the kubelet's own `:10250` API call back into kube-apiserver?

**A:** Because the kubelet is not an identity provider or a policy engine. When metrics-server scrapes `https://<node>:10250/metrics/resource`, the kubelet delegates both halves of the decision:

```
metrics-server ──Bearer <SA token>──▶ kubelet :10250
                                         │
                    ┌────────────────────┴────────────────────┐
                    ▼                                         ▼
        POST /apis/authentication.k8s.io/v1/           POST /apis/authorization.k8s.io/v1/
             tokenreviews                                   subjectaccessreviews
        "is this token valid, and who is it?"          "may that identity GET
                    │                                   nodes/metrics on this node?"
                    ▼                                         ▼
             kube-apiserver                             kube-apiserver (RBAC)
                    │                                         │
                    └──────── allowed / denied ◀──────────────┘
                                    │
                              kubelet serves or 403s
```

Requires `--authentication-token-webhook=true` and `--authorization-mode=Webhook` in the kubelet config (the default on GKE and kubeadm clusters). Set `--authorization-mode=AlwaysAllow` and anyone who can reach port 10250 can exec into any container on that node — a well-known misconfiguration.

Note the symmetry with the aggregation layer described earlier: aggregated apiservers *also* use SubjectAccessReview for fine-grained authz after kube-apiserver has already authenticated the caller. `TokenReview` / `SubjectAccessReview` are the generic "outsource the decision to the API server" primitives.
