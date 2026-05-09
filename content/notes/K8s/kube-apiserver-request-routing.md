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

## See also

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
