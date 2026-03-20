---
title: "Summary: GKE Cluster Logging Architecture"
---

> **Full notes:** [[notes/CloudLogging/company_logging|GKE Cluster Logging Architecture - Q&A Documentation →]]

## Key Concepts

### GKE system logging configuration

GKE clusters use a `logging_config` block (via the `gke-cluster-kit` Terraform module) with `enable_components = ["SYSTEM_COMPONENTS"]` to limit Cloud Logging ingestion to control plane logs only. This excludes application container logs from native GKE logging, reducing cost and log volume. Some dev environments may add `APISERVER`, `CONTROLLER_MANAGER`, and `SCHEDULER` for deeper debugging.

### Application log collection and routing to BigQuery

Application container logs follow a completely separate path from system logs. Fluent Bit DaemonSets on each node collect app logs and send them to Cloud Logging. From there, **log sinks** (created by the `microservice-starter-kit` Terraform module) filter by Kubernetes namespace and route logs to BigQuery datasets in the microservice's own GCP project.

```
App container → stdout/stderr → /var/log/containers/*.log
                                        │
                                  Fluent Bit (DaemonSet)
                                        │
                                        ▼
                                  Cloud Logging
                                  (cluster project)
                                        │
                              Log Sink (namespace filter)
                                        │
                                        ▼
                              BigQuery Dataset
                              (microservice project)
```

The default filter: `resource.type=k8s_container AND resource.labels.namespace_name=<ns>`. Optional additional filters can refine by severity, resource type, or JSON payload fields.

### Fluent Bit DaemonSet details

Fluent Bit runs one pod per node in the `kouzoh-fluent-bit-prod` namespace. It tails `/var/log/containers/*.log`, parses Kubernetes metadata (namespace, pod, container), and sends to Cloud Logging via the **Stackdriver output plugin**. It explicitly excludes system namespaces from collection (`kube-system`, `istio-system`, `knative-serving`, `gke-system`, `config-management-system`) to avoid double-collection with GKE native logging.

Key config details: `Buffer_Chunk_Size: 512K`, `Buffer_Max_Size: 5M`, `Mem_Buf_Limit: 32M`, multiline parser for CRI format, and tolerations on all taints so it runs on every node (including ML and searchx pools).

### Fluentd sidecars (legacy)

Fluentd sidecars are an older pattern where Fluentd runs as a sidecar container alongside the main app container. This has been largely replaced by the centralized Fluent Bit DaemonSet approach but still exists in some legacy applications.

### Log sink filtering mechanism

Log sinks use Cloud Logging's filter syntax with two components: (1) the default namespace filter matching `k8s_container` resources in a specific namespace, and (2) optional additional filters for severity, resource types, or payload fields. Complex filters can combine these, e.g., `resource.type=k8s_container AND resource.labels.namespace_name=gateway AND (jsonPayload.level=error OR severity=ERROR)`.

The sink is created in the GKE cluster project (e.g., `mercari-jp-citadel-prod`) but routes logs to a BigQuery dataset in the microservice's own project.

### Cross-project IAM for log writing

Each log sink is created with `unique_writer_identity = true`, which auto-generates a dedicated service account. That service account must be granted `roles/bigquery.dataEditor` on the destination BigQuery dataset in the microservice project. This enables the cross-project architecture:

```
GKE Cluster Project                          Microservice Project
┌────────────────────────┐                  ┌─────────────────────────┐
│  Log Sink              │                  │  BigQuery Dataset       │
│  (unique_writer_identity│  ── IAM grant ──►  (namespace logs)       │
│   = auto SA)           │  dataEditor      │                         │
└────────────────────────┘                  └─────────────────────────┘
```

### Additional notes

- `SYSTEM_COMPONENTS` in GKE refers to control plane components, not node-level system logs.
- The `microservice-starter-kit` supports multiple storage backends: BigQuery streaming insert, BigQuery batch load, and GCS -- configurable via `logging.storages` for cost optimization.
- Table expiration can be set via `logging.table_expiration_time_day` (converted to milliseconds internally).

## Quick Reference

```
Full logging architecture:

                        GKE Cluster Project
                    ┌─────────────────────────────┐
                    │                             │
  System logs ─────►│  GKE built-in logging       │──► Cloud Logging (system only)
                    │  (SYSTEM_COMPONENTS)        │
                    │                             │
  App logs ────────►│  Fluent Bit DaemonSet       │──► Cloud Logging (app logs)
                    │  /var/log/containers/*.log   │        │
                    │  (excludes system ns)        │        │
                    └─────────────────────────────┘        │
                                                           ▼
                                                    Log Sink (per-namespace filter)
                                                    unique_writer_identity = true
                                                           │
                                          ┌────────────────┼────────────────┐
                                          ▼                ▼                ▼
                                   Microservice A    Microservice B   Microservice C
                                   ┌────────────┐   ┌────────────┐   ┌────────────┐
                                   │ BQ Dataset  │   │ BQ Dataset  │   │ BQ Dataset  │
                                   │ (ns-a logs) │   │ (ns-b logs) │   │ (ns-c logs) │
                                   └────────────┘   └────────────┘   └────────────┘

Filter:  resource.type=k8s_container AND resource.labels.namespace_name=<ns>
IAM:     sink writer_identity → roles/bigquery.dataEditor on destination dataset
```

| Component | Role | Location |
|-----------|------|----------|
| GKE logging_config | System/control plane logs to Cloud Logging | Cluster Terraform |
| Fluent Bit DaemonSet | App log collection from nodes | `kouzoh-fluent-bit-prod` ns |
| Log sinks | Namespace-based filtering + routing | Cluster project |
| BigQuery datasets | Log storage per microservice | Microservice project |
| IAM bindings | Cross-project write access | Microservice project |

## Key Takeaways

- System logs go through GKE native logging; app logs go through Fluent Bit -- they are completely separate pipelines.
- Fluent Bit excludes system namespaces to avoid double-collection with GKE native logging.
- Log sinks use namespace-based filters to route each microservice's logs to its own BigQuery dataset in a separate GCP project.
- Cross-project log writing requires creating the sink with `unique_writer_identity = true` and granting that auto-generated SA `bigquery.dataEditor` on the target dataset.
- The starter kit supports multiple storage backends (BigQuery streaming, BQ batch load, GCS) configurable per microservice for cost optimization.
- Fluentd sidecars are a legacy pattern largely replaced by centralized Fluent Bit DaemonSets.
