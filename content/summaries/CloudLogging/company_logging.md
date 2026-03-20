---
title: "Summary: GKE Cluster Logging Architecture"
---

> **Full notes:** [[notes/CloudLogging/company_logging|GKE Cluster Logging Architecture - Q&A Documentation →]]

## Key Concepts

**Two-tier log collection** -- system logs and application logs follow separate paths. GKE's built-in logging handles system/control-plane logs. Application logs are collected by Fluent Bit DaemonSets.

**GKE `logging_config`** -- the `enable_components = ["SYSTEM_COMPONENTS"]` setting limits Cloud Logging ingestion to control plane logs only, reducing cost.

**Fluent Bit DaemonSet** -- runs one pod per node, tails `/var/log/containers/*.log`, enriches with K8s metadata, and sends to Cloud Logging via the Stackdriver output plugin. Excludes system namespaces (`kube-system`, `istio-system`, etc.).

**Log sinks** -- Cloud Logging sinks filter logs by namespace (`resource.type=k8s_container AND resource.labels.namespace_name=<ns>`) and route them to BigQuery datasets in each microservice's own GCP project.

**Cross-project IAM** -- each sink gets a unique writer identity (service account). That SA is granted `roles/bigquery.dataEditor` on the destination dataset in the microservice project.

**Fluentd sidecars** -- legacy pattern (replaced by centralized Fluent Bit). Some older apps still use Fluentd as a sidecar container.

## Quick Reference

```
                        GKE Cluster Project
                    ┌─────────────────────────────┐
                    │                             │
  System logs ─────►│  GKE built-in logging       │──► Cloud Logging
                    │  (SYSTEM_COMPONENTS)        │
                    │                             │
  App logs ────────►│  Fluent Bit DaemonSet       │──► Cloud Logging
                    │  (per node)                 │        │
                    └─────────────────────────────┘        │
                                                           ▼
                                                    Log Sink (filter
                                                    by namespace)
                                                           │
                                                           ▼
                                                  Microservice Project
                                                  ┌──────────────────┐
                                                  │  BigQuery Dataset │
                                                  │  (namespace logs) │
                                                  └──────────────────┘
```

**Filter pattern:** `resource.type=k8s_container AND resource.labels.namespace_name=<namespace>`

**IAM chain:** Log sink `writer_identity` → `bigquery.dataEditor` on destination dataset

## Key Takeaways

- System logs go through GKE native logging; app logs go through Fluent Bit -- they are separate pipelines.
- Log sinks use namespace-based filters to route each microservice's logs to its own BigQuery dataset in a separate GCP project.
- Cross-project log writing requires granting the sink's auto-generated writer identity `bigquery.dataEditor` on the target dataset.
- Fluent Bit excludes system namespaces to avoid double-collection.
- The starter kit supports multiple storage backends (BigQuery streaming, BigQuery batch load, GCS) for cost optimization.
