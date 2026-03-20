---
title: "Summary: Istio Observability & Extensibility"
---

> **Full notes:** [[notes/Networking/istio-observability-extensibility|Istio Observability & Extensibility -->]]

## Key Concepts

### Observability Data Flow

Three data streams from every Envoy sidecar, all automatic with zero app code changes: **Metrics** (scraped by Prometheus from port 15090), **Trace spans** (pushed via HTTP/gRPC to Jaeger/Zipkin/OTel Collector), **Access logs** (stdout or gRPC ALS to Loki/Elasticsearch/OTel Collector). Grafana visualizes metrics, Jaeger/Tempo UI shows traces, and Kiali provides service topology by combining Prometheus metrics + K8s API + trace data.

```
Envoy --:15090--> Prometheus --> Grafana (dashboards)
Envoy --spans-->  Jaeger/OTel Collector --> Jaeger UI
Envoy --logs-->   stdout / gRPC ALS --> Loki/Elasticsearch
Prometheus + K8s API --> Kiali (topology graph)
```

### Metrics

Envoy generates per-request metrics via the **`istio.stats` Wasm filter**. Standard Istio metrics:

| Metric | Type | Description |
|--------|------|-------------|
| `istio_requests_total` | Counter | Total requests (labels: source/dest workload, namespace, response_code, protocol, response_flags) |
| `istio_request_duration_milliseconds` | Histogram | Request duration with buckets |
| `istio_request_bytes` / `istio_response_bytes` | Histogram | Body sizes |
| `istio_tcp_sent/received_bytes_total` | Counter | TCP byte counters |
| `istio_tcp_connections_opened/closed_total` | Counter | TCP connection counts |

Prometheus scrapes port 15090 on every Envoy (via PodMonitor, ServiceMonitor, or annotation-based discovery). Port 15020 on pilot-agent serves a **merged** endpoint combining Envoy stats, pilot-agent metrics, and app metrics (if annotated).

Istio ships standard Grafana dashboards: Mesh Dashboard (global overview), Service Dashboard (per-service), Workload Dashboard (per-workload), Performance Dashboard, Control Plane Dashboard (istiod health).

### Customizing Metrics via Telemetry API

The Telemetry CRD allows per-workload metric customization: add custom label dimensions (`tagOverrides` with `UPSERT`), disable specific metrics (`disabled: true`), override tag values. Can target CLIENT_AND_SERVER or SERVER mode specifically.

### Distributed Tracing

Each Envoy generates a trace **span** per request it proxies. Spans are linked by a shared trace ID passed in headers, forming a tree of the request path through multiple services.

**Critical caveat**: Applications **must propagate** trace context headers from inbound to all outbound requests. Envoy cannot correlate inbound and outbound spans within the same app. Without propagation, each hop generates an independent trace -- multi-hop traces appear as disconnected single spans in Jaeger.

Headers to propagate: `x-request-id`, `x-b3-traceid`, `x-b3-spanid`, `x-b3-parentspanid`, `x-b3-sampled` (B3/Zipkin format), `traceparent`, `tracestate` (W3C Trace Context / OpenTelemetry). Most HTTP frameworks have middleware for automatic propagation (Spring Sleuth, Go ochttp, Python opentelemetry-instrumentation).

### Configuring Tracing

Via Telemetry API or MeshConfig. Key settings: `randomSamplingPercentage` (e.g., 1.0 for 1% sampling), `customTags` (add environment variables or literals to spans), provider selection (zipkin, opentelemetry). Supported backends: Zipkin, Jaeger, OpenTelemetry Collector (recommended), Datadog, Lightstep.

### Kiali

Dedicated observability console for Istio. Core capabilities: **topology graph** (real-time service-to-service traffic with request rates, error rates, response times), **traffic animation** (animated request flow), **Istio config validation** (flags missing DestinationRules, conflicting mTLS, unreachable routes), **health indicators** (color-coded per service/workload), **tracing integration** (embeds Jaeger/Tempo views), **wizard actions** (generate traffic routing and fault injection config from UI). Kiali pulls data from Prometheus, K8s API, and optionally Jaeger/Tempo.

### Wasm (WebAssembly) Plugins

Extend Envoy with custom filter logic (Go, Rust, C++, AssemblyScript) compiled to `.wasm`, executed in sandboxed V8/Wasmtime VM. Lifecycle: write plugin -> compile to .wasm -> push to OCI registry -> create WasmPlugin CRD -> istiod pushes config via xDS -> Envoy downloads .wasm (cached by istio-agent) -> loads into sandbox -> executes on matching requests (decodeHeaders, decodeBody, encodeHeaders, encodeBody callbacks).

WasmPlugin CRD specifies: `selector` (target workloads), `url` (OCI image), `phase` (AUTHN/AUTHZ/STATS/UNSPECIFIED for filter chain position), `pluginConfig` (JSON config), `imagePullPolicy`, optional `match` (SERVER/CLIENT mode, ports).

Performance: 10-50 microsecond overhead for simple logic (header reads/writes). Heavier plugins (body parsing, regex) add more. Native C++ filters are faster but Wasm is portable and safe.

Use cases: custom metrics, header injection/transformation, token exchange, request body validation, A/B testing cookie assignment.

### EnvoyFilter

Low-level CRD that directly patches Envoy configuration generated by Istio. An **escape hatch** for features not exposed by higher-level CRDs. Supports patch operations: ADD, REMOVE, MERGE, REPLACE, INSERT_BEFORE, INSERT_AFTER, INSERT_FIRST. Can target: LISTENER, FILTER_CHAIN, NETWORK_FILTER, HTTP_FILTER, ROUTE_CONFIGURATION, VIRTUAL_HOST, HTTP_ROUTE, CLUSTER, EXTENSION_CONFIG. Context: SIDECAR_INBOUND, SIDECAR_OUTBOUND, GATEWAY, ANY.

**Danger**: EnvoyFilter patches reference internal Envoy config structures that change between Istio versions. Risks: silent breakage (patch matches nothing on upgrade), hard to debug, ordering conflicts between multiple EnvoyFilters, upgrade blocker. Always prefer WasmPlugin, Telemetry API, or higher-level CRDs.

### Lua Filters

Lightweight inline scripting injected via EnvoyFilter. Access to request/response headers (read/modify), body (read/modify with buffering), dynamic metadata, logging, async HTTP calls. Runs in a coroutine per request, single-threaded within the worker, must not block. For complex logic, prefer Wasm or ext_authz.

### Telemetry API

Istio's CRD for declaratively configuring observability. Covers tracing (providers, sampling, custom tags), metrics (providers, tag overrides, disable specific metrics), and access logging (providers, filter expressions like `response.code >= 400`).

Scoping rules: mesh-wide (in `istio-system` with no selector), namespace-wide (in target namespace, no selector), workload-specific (with `selector.matchLabels`). Inheritance: workload > namespace > mesh (more specific overrides less specific).

## Quick Reference

```
Observability Data Flow:
  Envoy --:15090--> Prometheus --> Grafana
  Envoy --spans-->  Jaeger/OTel --> Trace UI
  Envoy --logs-->   stdout/ALS --> Loki/ES
  Kiali <-- Prometheus + K8s API + traces

Headers apps MUST propagate for tracing:
  B3:  x-request-id, x-b3-traceid, x-b3-spanid, x-b3-parentspanid, x-b3-sampled
  W3C: traceparent, tracestate
```

| Extension Method | Use When | Stability | Risk |
|-----------------|----------|-----------|------|
| Telemetry API | Custom metrics, tracing config, log filtering | Stable CRD | Low |
| WasmPlugin | Custom logic (headers, validation, metrics) | Stable ABI (proxy-wasm) | Low-Medium |
| Lua (via EnvoyFilter) | Quick one-off customizations | Depends on EnvoyFilter | Medium |
| EnvoyFilter | Envoy features not exposed by any CRD | Internal config structures | High (version-fragile) |

| WasmPlugin Phase | Position in Filter Chain |
|-----------------|------------------------|
| AUTHN | Before authentication filters |
| AUTHZ | Before authorization filters |
| STATS | Before stats filters |
| UNSPECIFIED | Before router (default) |

## Key Takeaways

- Metrics and access logs are fully automatic. Distributed tracing requires applications to propagate trace context headers -- without this, multi-hop traces break into disconnected single spans.
- The `istio.stats` Wasm filter generates standard Istio metrics with consistent label dimensions across all proxies.
- Kiali combines Prometheus metrics, K8s API data, and traces into a single UI with topology graphs, config validation, and health indicators.
- Prefer WasmPlugin over EnvoyFilter for custom Envoy extensions -- WasmPlugin uses a stable ABI (proxy-wasm), is loaded via a supported CRD, and survives Istio upgrades. EnvoyFilter patches internal config that changes between versions and can silently break.
- EnvoyFilter dangers: silent patch failures on upgrade, ordering conflicts, upgrade blockers. Use only when no other API exposes the needed feature.
- The Telemetry API lets you customize metrics dimensions, disable specific metrics, configure tracing sampling rates, and filter access logs -- all declaratively per workload, namespace, or mesh.
- Lua filters are lightweight for quick customizations but must not block (single-threaded per worker). For complex logic, use Wasm or ext_authz.
- Port 15020 (pilot-agent) serves a merged metrics endpoint combining Envoy, pilot-agent, and app metrics -- useful for single scrape target per pod.
