---
title: Issue when installing an external tool Chkk
---

### **Part 1: The Core Architecture (The "What")**

#### **Q: What exactly is `v1beta1.external.metrics.k8s.io`?**

**A:** It is a **Kubernetes APIService**.
In a standard Kubernetes cluster, the API Server (`kube-apiserver`) handles requests for native resources like Pods, Services, and Deployments. However, Kubernetes is designed to be extensible. The `APIService` resource tells the main API Server:

> *"I do not know how to handle requests for `external.metrics.k8s.io`. Instead of rejecting them, please proxy (forward) any request matching this path to a specific backend service running inside the cluster."*

In your case, that backend service is the **Datadog Cluster Agent**.

#### **Q: Why was the status "Healthy" even though my HPA was failing?**

**A:** The status `True` / `Available` in the APIService output merely confirms **network connectivity**.
The Kubernetes Aggregation Layer periodically pings the registered backend (Datadog Cluster Agent Service on port 8443).

* **The Check:** "Can I establish a TCP connection and get a 200 OK from the `/` or `/healthz` endpoint?"
* **The Result:** "Yes."
* **The Misconception:** This status does *not* check if the agent can actually fetch data, if your API keys are valid, or if your metric definitions are correct. It only confirms the "pipe" is open, not that the water is clean.

---

### **Part 2: The Workflow (The "How")**

#### **Q: What happens step-by-step when an HPA requests a metric?**

**A:** The flow is complex and involves multiple hops:

1. **HPA Controller Loop:** The Horizontal Pod Autoscaler (HPA) controller (part of `kube-controller-manager`) wakes up (default every 15-30s).
2. **API Request:** The HPA sees it needs a metric named `proxy-dynamic-min-replicas`. It sends a GET request to the main API Server:
`GET /apis/external.metrics.k8s.io/v1beta1/namespaces/kouzoh-scenario-test-jp-dev/proxy-dynamic-min-replicas`
3. **Aggregation Layer Proxy:** The main API Server looks up its APIService table, sees that `external.metrics.k8s.io` belongs to Datadog, and forwards the request to the `datadog-cluster-agent` Pod on port 8443.
4. **Agent Processing:** The Datadog Cluster Agent receives the request. It must now translate this Kubernetes metric name into a **Datadog Query** (e.g., `avg:nginx.requests{...}`).
5. **Datadog Backend Fetch:** The Agent uses its API key to query Datadog HQ (SaaS).
6. **Response:** The value (e.g., `0.5`) is returned to the Agent, then to the API Server, and finally to the HPA Controller.

---

### **Part 3: The Problem (The "Why")**

#### **Q: What caused the "DatadogMetric not found" error?**

**A:** This was a **State Collision** issue caused by the `dcaautogen` feature.

**1. The "Autogen" Feature:**
When you create an HPA referencing an external metric *before* you create a specific `DatadogMetric` CRD, the Cluster Agent tries to be helpful. It automatically generates a `DatadogMetric` object internally to handle the request. It names these with a specific pattern: `dcaautogen-<hash>`.

**2. The Cache:**
The Cluster Agent maintains an in-memory map:

* **Key:** `external_metric_name` (e.g., `proxy-dynamic-min-replicas`)
* **Value:** `internal_object_id` (e.g., `dcaautogen-54b5...`)

**3. The Collision:**

* At some point in the past, an HPA requested this metric. The Agent generated an `autogen` mapping for it.
* Later, you deployed a **valid, manual** `DatadogMetric` object (the one we saw with `kubectl get datadogmetrics`).
* **The Bug:** The Agent's cache was "sticky." It continued to map the metric name `proxy-dynamic-min-replicas` to the old `dcaautogen` ID instead of switching to your new, manual `DatadogMetric`.
* Since the old `dcaautogen` object likely didn't exist anymore (or was invalid), the lookup failed with "DatadogMetric not found," even though the *manual* one was right there.

#### **Q: Why did `kubectl get datadogmetrics` show "Active: True"?**

**A:** Because that command only queries the **Kubernetes etcd database**.

* The `DatadogMetric` Custom Resource was valid.
* The Operator/Controller was successfully updating its status.
* However, the **Metrics Server component** (the part that answers the HPA's questions) was looking at a different (stale) reference pointer.

---

### **Part 4: The Solution (The "Fix")**

#### **Q: Why does restarting the Pod fix it?**

**A:** Restarting the `datadog-cluster-agent` pod kills the process and clears its RAM.
When the new Pod starts:

1. The memory is empty.
2. It scans the cluster for *all* existing `DatadogMetric` objects.
3. It builds a **fresh mapping table**.
4. It sees your manual `proxy-dynamic-min-replicas` object and correctly maps the name to that object ID.
5. The stale `dcaautogen` reference is gone forever.

#### **Q: How do I prevent this in the future?**

**A:**

1. **Order of Operations:** Always deploy the `DatadogMetric` CRD **before** or **at the same time** as the HPA. Do not deploy an HPA that references a metric that doesn't exist yet, or the Agent might try to "autogen" it.
2. **Disable Autogen (Optional):** If you *always* use manual `DatadogMetric` objects (which is best practice for production), you can disable the autogen feature entirely by setting the environment variable `DD_EXTERNAL_METRICS_PROVIDER_ENABLE_DATADOGMETRIC_AUTOGEN` to `false` in your Cluster Agent deployment. This prevents it from ever creating these "ghost" mappings.

### **Part 5: Verification Command Explained**

#### **Q: What did the `kubectl get --raw` command do?**

**A:** `kubectl get --raw` is the ultimate "truth serum" for Kubernetes APIs.

* Standard `kubectl get hpa` asks the HPA controller for its *status*. It tells you what the HPA *thinks* is happening (which might be "I can't fetch metrics").
* `kubectl get --raw "/apis/external..."` acts like a `curl` request directly to the API endpoint. It bypasses all controllers and caches. It forces the API server to attempt a live fetch from the Datadog Agent right now.
* If this command returns JSON, the pipe is working. If it returns an Error (as it did for you), the issue is definitely in the backend (Datadog Agent), not in the HPA configuration.
