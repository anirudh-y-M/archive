---
title: "Istio Observability & Extensibility: Metrics, Tracing, Kiali, WasmPlugin, EnvoyFilter, and Telemetry API"
---

## Overview

Istio provides comprehensive observability out of the box by leveraging Envoy's built-in telemetry capabilities. Every request passing through the mesh is automatically instrumented -- no application code changes required for metrics and basic tracing. Istio also exposes several mechanisms for extending Envoy's behavior beyond what the built-in CRDs offer: WasmPlugin, EnvoyFilter, Lua filters, and the Telemetry API.

For the Istio control plane architecture, see [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]]. For Envoy internals (filter chains, access logging), see [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]]. For security features, see [[notes/Networking/istio-security|Istio Security]].

---

## Observability Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    OBSERVABILITY DATA FLOW                                    │
│                                                                              │
│  ┌─── Pod ──────────────────────┐                                           │
│  │  ┌──────┐     ┌────────────┐ │                                           │
│  │  │ App  │◄───►│ Envoy      │ │                                           │
│  │  │      │     │ (istio-    │ │                                           │
│  │  │      │     │  proxy)    │ │                                           │
│  │  └──────┘     └──┬──┬──┬──┘ │                                           │
│  └──────────────────┼──┼──┼────┘                                           │
│                     │  │  │                                                  │
│          ┌──────────┘  │  └──────────┐                                      │
│          │             │             │                                       │
│          ▼             ▼             ▼                                       │
│  ┌──────────────┐ ┌────────────┐ ┌──────────────────┐                      │
│  │  :15090      │ │ Trace      │ │ Access Logs       │                      │
│  │  /stats/     │ │ Spans      │ │ (stdout or        │                      │
│  │  prometheus  │ │ (Zipkin/   │ │  gRPC ALS)        │                      │
│  │              │ │  OTel fmt) │ │                    │                      │
│  └──────┬───────┘ └─────┬──────┘ └────────┬──────────┘                     │
│         │               │                 │                                  │
│    Scrape (pull)   Push (HTTP/gRPC)   Collect (file/gRPC)                   │
│         │               │                 │                                  │
│         ▼               ▼                 ▼                                  │
│  ┌──────────────┐ ┌────────────────┐ ┌──────────────────┐                  │
│  │  Prometheus   │ │  Jaeger /       │ │  Loki /           │                 │
│  │              │ │  Zipkin /       │ │  Elasticsearch /  │                  │
│  │  (scrapes    │ │  Tempo /        │ │  OpenTelemetry    │                 │
│  │   all Envoys │ │  OpenTelemetry  │ │  Collector        │                  │
│  │   on :15090) │ │  Collector      │ │                    │                 │
│  └──────┬───────┘ └────────┬───────┘ └──────────────────┘                  │
│         │                  │                                                 │
│         ▼                  ▼                                                 │
│  ┌──────────────┐ ┌────────────────┐                                       │
│  │  Grafana      │ │  Jaeger UI /    │                                      │
│  │  (dashboards) │ │  Tempo UI       │                                      │
│  └──────────────┘ └────────────────┘                                       │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │  Kiali  (scrapes Prometheus + queries traces)                 │           │
│  │  - Service topology graph                                      │          │
│  │  - Traffic flow visualization                                  │          │
│  │  - Istio config validation                                     │          │
│  └──────────────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Metrics

Envoy generates a rich set of metrics for every request it proxies. Istio adds a set of **standard metrics** with consistent label dimensions that enable service-level dashboards.

### Standard Istio Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `istio_requests_total` | Counter | Total requests. Labels: `source_workload`, `destination_workload`, `source_namespace`, `destination_namespace`, `request_protocol`, `response_code`, `connection_security_policy`, `response_flags` |
| `istio_request_duration_milliseconds` | Histogram | Request duration in ms (buckets). Same labels as above. |
| `istio_request_bytes` | Histogram | Request body size in bytes. |
| `istio_response_bytes` | Histogram | Response body size in bytes. |
| `istio_tcp_sent_bytes_total` | Counter | Total bytes sent during TCP connections. |
| `istio_tcp_received_bytes_total` | Counter | Total bytes received during TCP connections. |
| `istio_tcp_connections_opened_total` | Counter | Total TCP connections opened. |
| `istio_tcp_connections_closed_total` | Counter | Total TCP connections closed. |

These metrics are generated by the **Istio stats filter** (`istio.stats`), a Wasm filter compiled into Envoy. It intercepts request/response metadata and emits the standard metrics with the correct label dimensions.

### Metrics Collection Flow

```
  Envoy sidecar (in every pod)
       │
       │  Exposes /stats/prometheus on port 15090
       │  (merged with Istio standard metrics)
       │
       ▼
  Prometheus scrapes port 15090
       │
       │  Typically via PodMonitor or ServiceMonitor CRDs
       │  (if using prometheus-operator) or via
       │  annotation-based discovery:
       │    prometheus.io/scrape: "true"
       │    prometheus.io/port: "15090"
       │    prometheus.io/path: "/stats/prometheus"
       │
       ▼
  Grafana dashboards
       │
       │  Istio ships standard dashboards:
       │  - Mesh Dashboard (global overview)
       │  - Service Dashboard (per-service metrics)
       │  - Workload Dashboard (per-workload detail)
       │  - Performance Dashboard (control plane metrics)
       │  - Control Plane Dashboard (istiod health)
```

> **Note:** Port 15020 on `pilot-agent` serves a merged metrics endpoint that combines Envoy stats (from 15090) with pilot-agent's own metrics and application metrics (if configured via `prometheus.io/` annotations on the pod). This is useful when you want a single scrape target per pod.

### Customizing Metrics via Telemetry API

The Istio Telemetry API allows per-workload metric configuration -- adding custom dimensions, disabling specific metrics, or overriding tag values:

```yaml
apiVersion: telemetry.istio.io/v1
kind: Telemetry
metadata:
  name: custom-metrics
  namespace: my-app
spec:
  metrics:
  - providers:
    - name: prometheus
    overrides:
    - match:
        metric: REQUEST_COUNT
        mode: CLIENT_AND_SERVER
      tagOverrides:
        request_host:
          operation: UPSERT
          value: "request.host"    # add request_host label
    - match:
        metric: REQUEST_DURATION
        mode: SERVER
      disabled: true               # disable duration histogram for this workload
```

---

## Distributed Tracing

Istio enables distributed tracing across microservices by having each Envoy sidecar generate a **span** for every request it handles. These spans, linked by trace context headers, form a complete trace of a request's path through the mesh.

### How It Works

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     DISTRIBUTED TRACING FLOW                              │
│                                                                           │
│  Client                                                                   │
│    │                                                                      │
│    │  GET /api/product/123                                                │
│    │  (no trace headers)                                                  │
│    ▼                                                                      │
│  ┌────────────────────┐                                                  │
│  │ Envoy A (ingress)  │ ◄── Generates root span                         │
│  │                     │     Creates: x-request-id, x-b3-traceid,        │
│  │                     │     x-b3-spanid, x-b3-sampled                   │
│  └─────────┬──────────┘                                                  │
│            │  Span A: "inbound|gateway → product-svc"                    │
│            ▼                                                              │
│  ┌────────────────────┐                                                  │
│  │ App: product-svc   │ ◄── App MUST propagate trace headers             │
│  │                     │     when making outbound calls                   │
│  │  calls:             │                                                  │
│  │  - reviews-svc      │                                                  │
│  │  - ratings-svc      │                                                  │
│  └──┬───────────┬──────┘                                                 │
│     │           │                                                         │
│     ▼           ▼                                                         │
│  ┌────────┐  ┌────────┐                                                  │
│  │Envoy B │  │Envoy C │ ◄── Each generates a child span                 │
│  │        │  │        │     linked to the same trace ID                  │
│  └────┬───┘  └────┬───┘                                                  │
│       │           │                                                       │
│       ▼           ▼                                                       │
│  ┌────────┐  ┌────────┐                                                  │
│  │reviews │  │ratings │                                                  │
│  │svc     │  │svc     │                                                  │
│  └────────┘  └────────┘                                                  │
│                                                                           │
│  Result in Jaeger/Zipkin:                                                │
│  ┌─ Trace: abc123 ──────────────────────────────────────────────────┐    │
│  │                                                                    │    │
│  │  ├── Span A: gateway → product-svc       [0ms────────200ms]      │    │
│  │  │   ├── Span B: product → reviews-svc   [10ms──────150ms]      │    │
│  │  │   └── Span C: product → ratings-svc   [20ms────100ms]        │    │
│  │                                                                    │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Critical Caveat: Applications MUST Propagate Trace Headers

Envoy generates spans automatically, but it cannot correlate inbound and outbound spans within the same application. The application **must** copy the following headers from incoming requests to all outgoing requests:

| Header | Format | Purpose |
|--------|--------|---------|
| `x-request-id` | UUID | Envoy-generated unique request ID |
| `x-b3-traceid` | 128-bit hex | Zipkin/B3 trace identifier |
| `x-b3-spanid` | 64-bit hex | Zipkin/B3 span identifier |
| `x-b3-parentspanid` | 64-bit hex | Parent span ID |
| `x-b3-sampled` | `0` or `1` | Whether the trace is sampled |
| `traceparent` | W3C Trace Context | W3C standard trace context (used with OpenTelemetry) |
| `tracestate` | W3C Trace Context | Vendor-specific trace data |

If the application does not propagate these headers, each Envoy generates an independent trace with no parent-child relationship. Multi-hop traces appear as disconnected, single-span traces in Jaeger.

Most HTTP frameworks have middleware/interceptors to propagate these automatically (e.g., Spring Sleuth, Go's `ochttp`, Python's `opentelemetry-instrumentation`).

### Configuring Tracing

Tracing is configured via the Telemetry API or MeshConfig:

```yaml
# Via Telemetry API (per-namespace or per-workload)
apiVersion: telemetry.istio.io/v1
kind: Telemetry
metadata:
  name: tracing-config
  namespace: istio-system          # mesh-wide if in istio-system
spec:
  tracing:
  - providers:
    - name: zipkin                 # or "opentelemetry"
    randomSamplingPercentage: 1.0  # sample 1% of requests
    customTags:
      environment:
        literal:
          value: "production"
```

Supported tracing backends: **Zipkin**, **Jaeger** (with Zipkin-compatible collector), **OpenTelemetry Collector** (recommended for new deployments), **Datadog**, **Lightstep/ServiceNow**.

---

## Kiali

Kiali is the dedicated observability console for Istio. It provides a web UI for understanding the structure and health of the service mesh.

Core capabilities:

- **Topology graph**: Real-time visualization of service-to-service traffic flow, with edges showing request rates, error rates, and response times. Can be viewed at namespace, workload, app, or service granularity.
- **Traffic animation**: Animated dots flowing along edges showing actual request volume and direction.
- **Istio config validation**: Validates VirtualService, DestinationRule, AuthorizationPolicy, and other Istio CRDs. Flags issues like missing DestinationRules for subsets referenced in VirtualServices, conflicting mTLS settings, or unreachable routes.
- **Health indicators**: Color-coded health status for services, workloads, and apps based on error rates and request success rates.
- **Distributed tracing integration**: Embeds Jaeger/Tempo trace views directly in the Kiali UI for correlated troubleshooting.
- **Wizard actions**: Can generate Istio config (e.g., traffic routing, fault injection) directly from the UI.

Kiali pulls data from Prometheus (for metrics and graph generation), the Kubernetes API (for workload/service info), and optionally Jaeger/Tempo (for traces).

---

## Wasm (WebAssembly) Plugins

WebAssembly allows extending Envoy with custom filter logic written in Go, Rust, C++, or AssemblyScript, compiled to a `.wasm` binary. Envoy loads and executes the Wasm module in a sandboxed VM (V8 or Wasmtime) inside the proxy process.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    WASM PLUGIN LIFECYCLE                                   │
│                                                                           │
│  Developer writes plugin                                                  │
│  (Go with proxy-wasm-go-sdk,                                             │
│   Rust with proxy-wasm-rust-sdk)                                         │
│         │                                                                 │
│         ▼                                                                 │
│  Compile to .wasm binary                                                 │
│         │                                                                 │
│         ▼                                                                 │
│  Push to OCI registry                                                    │
│  (e.g., ghcr.io/myorg/my-plugin:v1)                                     │
│         │                                                                 │
│         ▼                                                                 │
│  Create WasmPlugin CRD                                                   │
│         │                                                                 │
│         ▼                                                                 │
│  istiod translates to Envoy Wasm filter config                           │
│  pushes via LDS/xDS                                                      │
│         │                                                                 │
│         ▼                                                                 │
│  Envoy downloads .wasm from OCI registry                                 │
│  (via istio-agent, cached locally)                                       │
│         │                                                                 │
│         ▼                                                                 │
│  Envoy loads .wasm into V8/Wasmtime sandbox                              │
│  Inserts filter into HTTP filter chain                                   │
│         │                                                                 │
│         ▼                                                                 │
│  Plugin executes on every matching request                               │
│  (decodeHeaders, decodeBody, encodeHeaders, encodeBody callbacks)        │
└──────────────────────────────────────────────────────────────────────────┘
```

```yaml
apiVersion: extensions.istio.io/v1alpha1
kind: WasmPlugin
metadata:
  name: custom-header-plugin
  namespace: my-app
spec:
  selector:
    matchLabels:
      app: my-service
  url: oci://ghcr.io/myorg/header-plugin:v1.2.0   # OCI image with .wasm
  phase: AUTHN                   # where in the filter chain to insert
                                 # AUTHN (before authn), AUTHZ (before authz),
                                 # STATS (before stats), UNSPECIFIED (before router)
  pluginConfig:                  # plugin-specific config (passed as JSON)
    header_name: "x-custom-id"
    header_value: "injected-by-wasm"
  imagePullPolicy: IfNotPresent  # Always, IfNotPresent, Never
  match:                         # optional: only apply to specific traffic
  - mode: SERVER                 # SERVER (inbound), CLIENT (outbound), or UNDEFINED (both)
    ports:
    - number: 8080
```

**Performance characteristics**: Wasm plugins add latency compared to native C++ filters. Typical overhead is 10-50 microseconds per filter invocation for simple logic (header reads/writes). Computationally heavy plugins (parsing large request bodies, regex evaluation) can add significantly more. For extremely latency-sensitive paths, native C++ filters are preferred, but Wasm provides a safe, portable alternative that does not require recompiling Envoy.

**Use cases**: Custom metrics emission, header injection/transformation, request routing based on custom logic, token exchange/transformation, request body validation, A/B testing cookie assignment.

---

## EnvoyFilter

EnvoyFilter is a low-level CRD that directly patches the Envoy configuration generated by Istio. It is an **escape hatch** for configuring Envoy features not exposed through Istio's higher-level CRDs (VirtualService, DestinationRule, AuthorizationPolicy, etc.).

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: add-lua-filter
  namespace: my-app
spec:
  workloadSelector:
    labels:
      app: my-service
  configPatches:
  - applyTo: HTTP_FILTER                    # what to patch
    match:
      context: SIDECAR_INBOUND              # SIDECAR_INBOUND, SIDECAR_OUTBOUND,
                                            # GATEWAY, ANY
      listener:
        filterChain:
          filter:
            name: envoy.filters.network.http_connection_manager
            subFilter:
              name: envoy.filters.http.router    # insert before router
    patch:
      operation: INSERT_BEFORE               # ADD, REMOVE, MERGE, REPLACE,
                                             # INSERT_BEFORE, INSERT_AFTER,
                                             # INSERT_FIRST
      value:
        name: envoy.filters.http.lua
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua
          inline_code: |
            function envoy_on_request(request_handle)
              request_handle:headers():add("x-custom-header", "hello-from-lua")
            end
```

Patch operations:

| Operation | Description |
|-----------|-------------|
| `ADD` | Add a new resource (listener, cluster, filter) |
| `REMOVE` | Remove a matched resource |
| `MERGE` | Deep-merge the patch value into the matched resource |
| `REPLACE` | Replace the matched resource entirely |
| `INSERT_BEFORE` | Insert a filter before the matched filter |
| `INSERT_AFTER` | Insert a filter after the matched filter |
| `INSERT_FIRST` | Insert a filter at the beginning of the chain |

`applyTo` targets:

| Value | What It Patches |
|-------|----------------|
| `LISTENER` | Top-level listener config |
| `FILTER_CHAIN` | Filter chain within a listener |
| `NETWORK_FILTER` | Network-level filter in a chain |
| `HTTP_FILTER` | HTTP filter within HCM |
| `ROUTE_CONFIGURATION` | RDS route config |
| `VIRTUAL_HOST` | Virtual host within a route config |
| `HTTP_ROUTE` | Specific route entry |
| `CLUSTER` | CDS cluster config |
| `EXTENSION_CONFIG` | ECDS extension config |

> **Warning:** EnvoyFilter patches are brittle. They reference internal Envoy config structures that can change across Istio versions. An EnvoyFilter that works on Istio 1.20 may silently fail or cause crashes on Istio 1.22 if the generated config structure changed. Always prefer WasmPlugin, Telemetry, or higher-level CRDs when possible. Use EnvoyFilter only as a last resort, and pin your Istio version in CI tests for any EnvoyFilter resources.

---

## Lua Filters

Lua filters provide lightweight inline scripting for quick customizations without the overhead of compiling and distributing a Wasm binary. They are typically injected via EnvoyFilter (as shown above).

Lua scripts have access to:

- Request/response headers (read and modify)
- Request/response body (read and modify, with buffering)
- Dynamic metadata (read and write, for passing data between filters)
- Logging
- Making async HTTP calls to upstream clusters

```lua
-- Example: Add response time header and log slow requests
function envoy_on_request(request_handle)
  request_handle:headers():add("x-request-start", tostring(os.clock()))
end

function envoy_on_response(response_handle)
  local start = tonumber(response_handle:headers():get("x-request-start"))
  if start then
    local duration = os.clock() - start
    response_handle:headers():add("x-response-time-ms", tostring(duration * 1000))
    if duration > 1.0 then
      response_handle:logWarn("Slow request: " .. tostring(duration) .. "s")
    end
  end
end
```

**Limitation**: Lua filters run in a coroutine per request. They are single-threaded within the worker and must not block. For complex logic, Wasm plugins or ext_authz are preferred.

---

## Telemetry API

The Telemetry API is Istio's CRD for configuring observability per-workload, per-namespace, or mesh-wide. It provides a declarative way to configure metrics, tracing, and access logging without resorting to EnvoyFilter.

```yaml
apiVersion: telemetry.istio.io/v1
kind: Telemetry
metadata:
  name: mesh-telemetry
  namespace: istio-system         # mesh-wide when in istio-system
spec:
  # --- Tracing configuration ---
  tracing:
  - providers:
    - name: opentelemetry          # registered in meshConfig.extensionProviders
    randomSamplingPercentage: 5.0
    disableSpanReporting: false
    customTags:
      cluster_name:
        environment:
          name: CLUSTER_NAME

  # --- Metrics configuration ---
  metrics:
  - providers:
    - name: prometheus
    overrides:
    - match:
        metric: ALL_METRICS
        mode: CLIENT_AND_SERVER
      tagOverrides:
        request_method:
          operation: UPSERT
          value: "request.method"

  # --- Access log configuration ---
  accessLogging:
  - providers:
    - name: envoy                  # file-based (stdout)
    filter:
      expression: "response.code >= 400"  # only log errors
  - providers:
    - name: otel-als               # gRPC ALS to OTel Collector
```

The Telemetry API scoping rules:

- **Mesh-wide**: Telemetry resource in `istio-system` namespace with no `selector`
- **Namespace-wide**: Telemetry resource in a target namespace with no `selector`
- **Workload-specific**: Telemetry resource with a `selector.matchLabels`
- **Inheritance**: Workload > Namespace > Mesh. More specific configs override less specific ones.

---

## See also

- [[notes/Networking/istio-architecture-deep-dive|Istio Architecture Deep Dive]] -- control plane, xDS, sidecar injection, iptables, request lifecycle
- [[notes/Networking/istio-envoy-internals|Istio Envoy Internals]] -- Envoy filter chain, access logging
- [[notes/Networking/istio-traffic-management|Istio Traffic Management]] -- VirtualService, DestinationRule, Gateway API
- [[notes/Networking/istio-security|Istio Security]] -- mTLS, AuthorizationPolicy, RequestAuthentication, ext_authz
- [Istio Observability (official docs)](https://istio.io/latest/docs/concepts/observability/)
- [Istio Standard Metrics Reference](https://istio.io/latest/docs/reference/config/metrics/)
- [Istio Distributed Tracing](https://istio.io/latest/docs/tasks/observability/distributed-tracing/)
- [Istio WasmPlugin Reference](https://istio.io/latest/docs/reference/config/proxy_extensions/wasm-plugin/)
- [Istio Telemetry API Reference](https://istio.io/latest/docs/reference/config/telemetry/)
- [Istio EnvoyFilter Reference](https://istio.io/latest/docs/reference/config/networking/envoy-filter/)
- [Kiali (official site)](https://kiali.io/)
- [Proxy-Wasm Spec (ABI)](https://github.com/proxy-wasm/spec)

---

## Interview Prep

### Q: How does distributed tracing work in Istio? What is the critical requirement for applications?

**A:** Each Envoy sidecar automatically generates a trace **span** for every request it proxies -- one span for the inbound side and one for the outbound side. Spans are tagged with source/destination metadata and sent to a tracing backend (Jaeger, Zipkin, OTel Collector).

```
  Svc A (Envoy) ──► Svc B (Envoy) ──► Svc C (Envoy)
  [Span: A→B]       [Span: B→C]

  These spans are linked by a shared trace ID passed via headers.
```

The **critical requirement**: Applications must propagate trace context headers (`x-request-id`, `x-b3-traceid`, `x-b3-spanid`, `x-b3-sampled`, `traceparent`) from incoming requests to all outgoing requests. Envoy cannot do this automatically because it does not understand the application-level relationship between an inbound request and the outbound calls it triggers. Without header propagation, each hop generates an independent trace -- multi-hop correlation is lost, and Jaeger shows disconnected single-span traces instead of a unified request tree.

---

### Q: What metrics does Istio generate automatically? How are they collected?

**A:** Istio generates standard metrics via the `istio.stats` Wasm filter in every Envoy proxy. The key metrics:

- `istio_requests_total` -- counter, broken down by source/destination workload, namespace, response code, protocol
- `istio_request_duration_milliseconds` -- histogram with buckets
- `istio_request_bytes` / `istio_response_bytes` -- size histograms
- `istio_tcp_sent_bytes_total` / `istio_tcp_received_bytes_total` -- TCP byte counters

These are exposed on each Envoy's `/stats/prometheus` endpoint on port 15090. Prometheus scrapes this port across all meshed pods (typically via PodMonitor or annotation-based discovery). Grafana dashboards then visualize the data.

Istio ships with standard Grafana dashboards: Mesh Dashboard (global overview), Service Dashboard (per-service), Workload Dashboard (per-workload), and Control Plane Dashboard (istiod health).

The Telemetry API (CRD) can customize metrics per-workload -- adding dimensions, disabling specific metrics, or changing tag values.

---

### Q: What is a WasmPlugin? When would you use it over an EnvoyFilter?

**A:** A WasmPlugin is an Istio CRD that loads a WebAssembly module into Envoy as an HTTP filter. The module runs in a sandboxed VM (V8/Wasmtime) and can inspect/modify requests and responses.

Use **WasmPlugin** when:
- You need custom logic (custom metrics, header transformation, request validation) not available via Istio CRDs
- You want a portable, safe extension that survives Istio upgrades
- You are willing to accept ~10-50 microsecond overhead per invocation

Use **EnvoyFilter** when:
- You need to configure an Envoy feature not exposed by any Istio API
- You need direct control over Envoy internals (e.g., changing listener bind config, adding bootstrap extensions)
- You accept the risk of breakage across Istio version upgrades

WasmPlugin is the preferred approach because it uses a stable ABI (proxy-wasm), is loaded via a supported Istio CRD, and does not patch raw Envoy config. EnvoyFilter is an escape hatch -- it directly manipulates generated Envoy config, which changes between Istio versions, making patches fragile.

---

### Q: What is the danger of using EnvoyFilter in production?

**A:** EnvoyFilter patches reference internal Envoy configuration structures generated by Istio. These structures are **not part of Istio's stable API** and can change between minor versions. The specific dangers:

1. **Silent breakage**: An EnvoyFilter that worked on Istio 1.20 may silently fail to match on 1.22 if the generated config structure changed. The patch applies to nothing, and the expected behavior is missing with no error.
2. **Hard to debug**: When EnvoyFilter patches go wrong, the symptoms are often subtle -- a missing filter, an incorrect route, or unexpected 503s. There is no straightforward validation tool.
3. **Ordering conflicts**: Multiple EnvoyFilters can conflict with each other, and their application order depends on creation timestamp and namespace, which is fragile.
4. **Upgrade blocker**: Teams with many EnvoyFilters often cannot upgrade Istio without extensive testing of every patch.

Best practice: always prefer WasmPlugin, Telemetry API, or higher-level CRDs. Reserve EnvoyFilter for features genuinely not exposed by any other API, and test them in CI against your target Istio version.
