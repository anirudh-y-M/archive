---
title: GKE Cluster Logging Architecture - Q&A Documentation
---

## 1. How is GKE cluster logging configured to send only system logs to Cloud Logging?

**Answer:**

GKE clusters are configured with a `logging_config` block that specifies which components send logs to Cloud Logging. The configuration uses the `enable_components` parameter set to `["SYSTEM_COMPONENTS"]`, which limits Cloud Logging ingestion to only system-level logs from the GKE control plane. [3-cite-0](#3-cite-0) 

This configuration is implemented through the `gke-cluster-kit` Terraform module, which creates a dynamic `logging_config` block in the `google_container_cluster` resource: [3-cite-1](#3-cite-1) 

By setting `enable_components` to only `SYSTEM_COMPONENTS`, the cluster excludes application container logs from being sent to Cloud Logging, reducing costs and log volume. Some development environments may include additional components like `APISERVER`, `CONTROLLER_MANAGER`, and `SCHEDULER` for more comprehensive debugging.

---

## 2. How are application container logs collected and routed to BigQuery datasets in namespace-specific projects?

**Answer:**

Application container logs follow a different path than system logs. They are collected by Fluent Bit DaemonSets running on each node and sent directly to Cloud Logging. From there, log sinks filter and route logs to BigQuery datasets in the microservice's own project based on the Kubernetes namespace.

The microservice-starter-kit module automatically creates log sinks that filter logs by namespace and route them to BigQuery: [3-cite-2](#3-cite-2) 

The log sink is created in the GKE cluster project (e.g., `mercari-jp-citadel-prod`) but routes logs to a BigQuery dataset in the microservice's own project. The filter uses the namespace name to ensure only relevant logs are captured: [3-cite-3](#3-cite-3) 

The default filter pattern `resource.type=k8s_container AND resource.labels.namespace_name=${local.kubernetes_namespace_name}` ensures that only logs from containers in the specific Kubernetes namespace are routed to that microservice's BigQuery dataset.

---

## 3. What is the role of Fluent Bit DaemonSets and Fluentd sidecars in collecting application logs?

**Answer:**

### Fluent Bit DaemonSet

Fluent Bit runs as a DaemonSet (one pod per node) in the `kouzoh-fluent-bit-prod` namespace and is responsible for collecting all application container logs from the cluster nodes: [3-cite-4](#3-cite-4) 

Fluent Bit collects logs by:
- Tailing container log files from `/var/log/containers/*.log`
- Parsing Kubernetes metadata to enrich logs with namespace, pod, and container information
- Filtering and processing logs before sending them to Cloud Logging via the Stackdriver output plugin [3-cite-5](#3-cite-5) 

The Fluent Bit configuration sends logs to Cloud Logging (Stackdriver) where they can then be routed by log sinks: [3-cite-6](#3-cite-6) 

### Fluentd Sidecars

Fluentd sidecars are an older pattern used in some legacy applications (notably `mercari-api-us`) where Fluentd runs as a sidecar container alongside the main application container. This pattern has largely been replaced by the centralized Fluent Bit DaemonSet approach. [3-cite-7](#3-cite-7) 

---

## 4. How does the log sink filtering mechanism route logs by namespace?

**Answer:**

The log sink filtering mechanism uses Cloud Logging's filter syntax to route logs based on Kubernetes namespace labels. The filter is constructed with two components:

1. **Default namespace filter**: Matches logs from containers in a specific namespace [3-cite-8](#3-cite-8) 

2. **Optional additional filters**: Can be specified to further refine log routing [3-cite-9](#3-cite-9) 

Example log sink configurations from the platform show this filtering pattern in action: [3-cite-10](#3-cite-10) 

The filter `resource.type=k8s_container AND resource.labels.namespace_name=gateway` ensures that only logs from the `gateway` namespace are sent to the specified BigQuery destination. More complex filters can combine namespace filtering with severity levels, resource types, or JSON payload fields.

---

## 5. What IAM permissions enable cross-project log writing?

**Answer:**

Cross-project log writing requires specific IAM permissions granted to the log sink's writer identity. When a log sink is created with `unique_writer_identity = true`, Google Cloud automatically creates a service account for that sink. This service account must be granted the `roles/bigquery.dataEditor` role on the destination BigQuery dataset.

For BigQuery destinations: [3-cite-11](#3-cite-11) 

This pattern is repeated for each log sink that writes to BigQuery. The `writer_identity` attribute from the `google_logging_project_sink` resource provides the automatically-generated service account that needs permissions: [3-cite-12](#3-cite-12) 

The log sink is created in the GKE cluster project (where the logs originate), but the IAM binding grants the sink's writer identity permission to write to a BigQuery dataset in a different project. This enables the cross-project log routing architecture where:

1. Logs are generated in the GKE cluster project (e.g., `mercari-jp-citadel-prod`)
2. Log sinks filter and route logs from the cluster project
3. The sink's writer identity has `bigquery.dataEditor` permissions on datasets in the microservice projects
4. Logs are written to BigQuery datasets in the namespace-specific microservice project

---

## Notes

- The Fluent Bit DaemonSet configuration excludes system namespaces like `kube-system`, `istio-system`, `knative-serving`, `gke-system`, and `config-management-system` from being collected, as these are handled by the GKE system logging configuration.

- The `SYSTEM_COMPONENTS` logging configuration in GKE refers to the control plane components, not node-level system logs. Application logs from user workloads are always collected separately via Fluent Bit.

- The microservice-starter-kit has evolved to support multiple storage backends (BigQuery, GCS, BigQuery batch load) through the `logging.storages` configuration, providing flexibility in log destination and cost optimization. [3-cite-13](#3-cite-13)

### Citations

**File:** terraform/microservices-platform/production/cluster-citadel-2g/regions/tokyo/cluster/terragrunt.hcl (L149-151)
```terraform
      logging_config = {
        enable_components = ["SYSTEM_COMPONENTS"]
      }
```

**File:** terraform/modules/gke-cluster-kit/main.tf (L187-192)
```terraform
  dynamic "logging_config" {
    for_each = each.value.logging_config != null ? [1] : []
    content {
      enable_components = each.value.logging_config.enable_components
    }
  }
```

**File:** terraform/modules/microservice-starter-kit/google_logging_project_sink.tf (L34-47)
```terraform
resource "google_logging_project_sink" "container_logs_bq_sink" {
  for_each = { for s in local.logging.normalized_storages : s.name => s if s.type == "bigquery" && ! s.disable_sink && var.enable_gcp && var.enable_kubernetes && (var.service_country == "jp" || var.service_country == "") }

  provider = google.common

  depends_on = [google_bigquery_dataset.container_logs]

  name    = "${google_project.microservice[0].project_id}-${each.value.name}-bq-sink"
  project = "mercari-jp-citadel-${var.shortened_environment[var.environment]}"

  destination            = "bigquery.googleapis.com/projects/${google_project.microservice[0].project_id}/datasets/${each.value.destination}"
  filter                 = local.logging.log_sink_filter
  unique_writer_identity = true
}
```

**File:** terraform/modules/microservice-starter-kit/locals.tf (L362-379)
```terraform
locals {
  default_log_sink_filter = "resource.type=k8s_container AND resource.labels.namespace_name=${local.kubernetes_namespace_name}"

  logging = {
    normalized_storages = [
      for s in try(var.logging.storages, []) : {
        name           = s.name
        type           = s.type
        destination    = try(s.destination, "") == "" ? s.name : s.destination
        disable_sink   = try(s.disable_sink, false)
        create_storage = try(s.destination, "") == ""
      }
    ]
    keep_legacy_dataset = try(var.logging.keep_legacy_dataset, true)

    default_table_expiration_time_ms = try(var.logging.table_expiration_time_day, null) != null ? var.logging.table_expiration_time_day * 24 * 60 * 60 * 1000 : null
    log_sink_filter                  = try(var.logging.additional_filter, "") == "" ? local.default_log_sink_filter : "${local.default_log_sink_filter} ${var.logging.additional_filter}"
  }
```

**File:** manifests/microservices-platform/kouzoh-fluent-bit/production/citadel-2g-prod-tokyo-01/DaemonSet/fluent-bit.yaml (L1-90)
```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluent-bit
  namespace: kouzoh-fluent-bit-prod
  annotations:
    scaleops.sh/default-rightsize-auto: "true"
  labels:
    app: fluent-bit
spec:
  selector:
    matchLabels:
      app: fluent-bit
  updateStrategy:
    rollingUpdate:
      maxUnavailable: 25%
  template:
    metadata:
      labels:
        app: fluent-bit
      annotations:
        ad.datadoghq.com/fluent-bit.check_names: '["prometheus"]'
        ad.datadoghq.com/fluent-bit.init_configs: '[{}]'
        ad.datadoghq.com/fluent-bit.instances: |
          [{
            "prometheus_url": "http://%%host%%:2020/api/v1/metrics/prometheus",
            "namespace": "fluent",
            "metrics": ["fluentbit_*"]
          }]
        ad.datadoghq.com/fluent-bit.logs: |
          [{
            "source":"docker",
            "service":"kouzoh-fluent-bit",
            "log_processing_rules": [{
              "type": "exclude_at_match",
              "name": "exclude-mem-buf-overlimit",
              "pattern" : ".*mem buf overlimit.*"
            },
            {
              "type": "exclude_at_match",
              "name": "exclude-stdout",
              "pattern" : "\\[[0-9]+\\] (kube|label_pruned)\\.var\\.log\\.containers\\..*\\.log.*"
            }]
          }]
        fluentbit.io/exclude: "true"
    spec:
      priorityClassName: platform-critical
      serviceAccountName: pod-default
      imagePullSecrets:
      - name: gcr-image-puller-service-account
      containers:
      - name: fluent-bit
        image: fluent/fluent-bit:2.1.10
        ports:
          - containerPort: 2020
        resources:
          requests:
            cpu: 750m
            memory: 128Mi
          limits:
            cpu: 3
            memory: 512Mi
        volumeMounts:
        - name: fluent-bit-config
          mountPath: /fluent-bit/etc
          readOnly: true
        - name: var-log
          mountPath: /var/log
        - name: var-lib
          mountPath: /var/lib/docker/containers
          readOnly: true
        - name: var-run
          mountPath: /var/run/kouzoh-fluent-bit/pos-files
      volumes:
      - name: fluent-bit-config
        configMap:
          name: fluent-bit
      - name: var-log
        hostPath:
          path: /var/log
      - name: var-lib
        hostPath:
          path: /var/lib/docker/containers
      - name: var-run
        hostPath:
          path: /var/run/kouzoh-fluent-bit/pos-files
      tolerations:
      # Fluent Bit should run on all nodes, regardless of their taints.
      # e.g. ml and searchx node pools.
      - operator: Exists
```

**File:** manifests/microservices-platform/kouzoh-fluent-bit/production/citadel-2g-prod-tokyo-01/ConfigMap/fluent-bit.yaml (L13-26)
```yaml
    [INPUT]
        Name                    tail
        DB                      /var/run/kouzoh-fluent-bit/pos-files/flb_kube.db
        DB.Sync                 Normal
        Buffer_Chunk_Size       512K
        Buffer_Max_Size         5M
        Mem_Buf_Limit           32M
        Refresh_Interval        5
        Rotate_Wait             10
        Skip_Long_Lines         On
        Tag                     kube.*
        Path                    /var/log/containers/*.log
        Exclude_Path            /var/log/containers/*_kube-system_*.log,/var/log/containers/*_istio-system_*.log,/var/log/containers/*_knative-serving_*.log,/var/log/containers/*_gke-system_*.log,/var/log/containers/*_config-management-system_*.log,/var/log/containers/*_mercari-api-jp-prod_*.log
        multiline.parser        cri
```

**File:** manifests/microservices-platform/kouzoh-fluent-bit/production/citadel-2g-prod-tokyo-01/ConfigMap/fluent-bit.yaml (L91-100)
```yaml
    [OUTPUT]
        Name                    stackdriver
        Match                   kube.*
        k8s_cluster_name        citadel-2g-prod-tokyo-01
        k8s_cluster_location    asia-northeast1-b
        labels_key              root.labels
        resource                k8s_container
        severity_key            level_mercari
        tag_prefix              kube.var.log.containers.
        export_to_project_id    mercari-jp-citadel-prod
```

**File:** manifests/microservices/mercari-api-us/development/double-2g-dev-us-west1-01/ReviewApp/mercari-api-us.yaml (L1-1)
```yaml
apiVersion: kubetempura.mercari.com/v1
```

**File:** terraform/microservices-platform/development/google_logging_project_sink.tf (L1-7)
```terraform
resource "google_logging_project_sink" "gateway_error_log_bigquery_sink" {
  name                   = "gateway_error_log_bigquery_sink"
  project                = google_project.mercari_jp_citadel_dev.project_id
  destination            = "bigquery.googleapis.com/projects/mercari-gateway-jp-dev/datasets/gateway_error_log"
  filter                 = "resource.type=k8s_container AND resource.labels.namespace_name=gateway AND (jsonPayload.level=error OR severity=ERROR)"
  unique_writer_identity = true
}
```

**File:** terraform/microservices/souzoh-beyond-jp/production/google_bigquery_dataset_iam_member.tf (L196-201)
```terraform
resource "google_bigquery_dataset_iam_member" "service_log_account_bigquery_sink_is_data_editor_of_service_log_account" {
  dataset_id = google_bigquery_dataset.service_log_account.dataset_id
  project    = module.souzoh-beyond-jp.gcp_project_id
  role       = "roles/bigquery.dataEditor"
  member     = google_logging_project_sink.service_log_account_bigquery_sink.writer_identity
}
```

**File:** terraform/microservices/souzoh-beyond-jp/production/google_logging_project_sink.tf (L34-42)
```terraform
resource "google_logging_project_sink" "operation_log_bigquery_sink" {
  name        = "operation-log-bigquery-sink"
  description = "Sink to operation logs to bigquery dataset"
  destination = "bigquery.googleapis.com/${google_bigquery_dataset.operation_log.id}"
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"graphql\" jsonPayload.type=\"operation-log\""
  project     = module.souzoh-beyond-jp.gcp_project_id

  unique_writer_identity = true
}
```

**File:** terraform/modules/microservice-starter-kit/CHANGELOG.md (L23-24)
```markdown
- [#244029](https://github.com/kouzoh/microservices-terraform/pull/244029) BQ batch load for logging as an alternative to BQ streaming insert . see [Design](https://docs.google.com/document/d/1iKjFqEcjBtcd5Te_EeTLjdVOxAjwNqljZG0paozN7Cw) for approach details and [configure-a-log-sink](https://microservices.mercari.in/guides/configure-a-log-sink/) for implementation details.
- [#252744](https://github.com/kouzoh/microservices-terraform/pull/252744) Fix akashi to include resource creation for google_project_service.gcp_api_service and adds the release date for this version.
```
