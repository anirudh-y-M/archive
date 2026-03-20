---
title: "Summary: Extension API Server Storage"
---

> **Full notes:** [[notes/K8s/extension_api_server_storage|Extension API Server Overview →]]

## Key Concepts

### Section 1: Core Concepts and Architecture

An **Extension API Server** (Aggregated API Server) is a separate HTTP server you develop and deploy alongside the main `kube-apiserver`. It extends the Kubernetes API by adding new API groups and resources that look like native K8s objects but are processed by your custom code. You register it using an `APIService` resource, which tells the main API server: "proxy any request matching this API group to this backend Service." The main API server acts as a gateway -- handles authentication, then tunnels the HTTP request. The main `kube-apiserver` itself uses **etcd** (a strongly consistent distributed key-value store) for all cluster state, optimized for watching changes which is key to the controller pattern.

### Section 2: The Storage Question

An extension API server is **not required** to use the main cluster's etcd. Since it's just code you write, you have full control over the storage backend. When the main API server proxies a request to your server, what you do with the data is entirely up to you.

**Can it use the main etcd?** Technically yes, but it is **strongly discouraged**. Giving an external pod direct access to core etcd (where Secrets and cluster state live) is a massive security risk. Bad queries from your extension could destabilize the entire cluster.

**Storage options (Bring Your Own Storage):**
1. **Separate etcd cluster** -- Same behavior as standard K8s resources (watches, consistency) but isolated from the main etcd.
2. **Relational databases (SQL)** -- For complex relationships, joins, referential integrity. Etcd is a key-value store and is poor at complex queries.
3. **In-memory (RAM)** -- For ephemeral or calculated data. The **Metrics Server** is the canonical example: it stores scraped CPU/memory data in RAM, and if it restarts, it just scrapes again.
4. **No storage (proxy/adapter)** -- The server translates K8s API requests into calls to a third-party API (AWS, GCP, corporate legacy API) and returns results directly.

### Section 3: CRDs vs Extension API Servers

The fundamental difference is who controls storage:

| | CRD | Extension API Server |
|---|---|---|
| **How it works** | Upload a YAML definition | Write Go/Python/Java code |
| **Storage** | Main cluster etcd (mandatory) | Developer's choice (SQL, RAM, separate etcd, external API, nothing) |
| **Max object size** | ~1.5MB (etcd limit) | Unlimited (depends on backend) |
| **Flexibility** | Zero control over storage | Infinite |
| **Complexity** | Very low | Very high |
| **Best for** | Config, operators, standard K8s patterns | Metrics, heavy data, proxying legacy systems |

**When to choose an extension API server over CRDs:** (1) You need non-etcd storage (SQL, in-memory). (2) Data is ephemeral and changes constantly (metrics) -- writing to etcd would burn out disk I/O. (3) You need custom API behavior (special verbs, non-standard patching) that declarative CRDs can't support. (4) Objects exceed etcd's ~1.5MB limit.

### Section 4: Implementation Details

The official `k8s.io/apiserver` Go library provides a framework for building extension API servers. Out of the box, it includes an **etcd adapter** and expects an etcd connection string. However, you can swap the `RESTStorage` interface to point to any backend (memory, SQL, etc.).

**Trade-offs of non-etcd storage:** You lose Kubernetes features that come free with etcd: (1) **Watch events** -- `kubectl get pods -w` works because etcd supports key watching. With PostgreSQL, you must implement your own change notification mechanism to push updates. (2) **Resource versions / optimistic locking** -- Kubernetes uses resource versions to prevent write conflicts. With a custom backend, you must implement this concurrency control yourself.

## Quick Reference

```
kubectl get myresource
       │
       ▼
  kube-apiserver
       │ looks up APIService for "my-group"
       ▼
  Aggregation Layer → proxy request to extension-api-server Service
       │
       ▼
  Extension API Server (your code)
       │
       ▼
  Storage backend (your choice):
  ┌──────────┬──────────┬──────────┬──────────────┐
  │ Separate │   SQL    │   RAM    │ External API  │
  │  etcd    │ (Postgres│ (Metrics │ (proxy to     │
  │          │  MySQL)  │  Server) │  AWS/GCP/etc) │
  └──────────┴──────────┴──────────┴──────────────┘
```

| Feature | etcd (default) | SQL | In-Memory |
|---|---|---|---|
| Watch support | Built-in | Must implement | Must implement |
| Resource versions | Built-in | Must implement | Must implement |
| Persistence | Yes (disk) | Yes (disk) | No (lost on restart) |
| Complex queries | Poor (key-value) | Excellent (joins, indexes) | Depends |
| Operational overhead | Deploy etcd cluster | Deploy DB | None |

## Key Takeaways

- Extension API servers give full control over storage -- the main use case is when CRDs' etcd-only constraint is a limitation
- Never connect an extension API server to the main cluster's etcd (security risk + stability risk); use a separate etcd instance if you want etcd semantics
- The Metrics Server is the canonical example of an extension API server with in-memory storage -- ephemeral data that doesn't need persistence
- The `k8s.io/apiserver` library defaults to etcd, but the `RESTStorage` interface can be swapped to point anywhere
- Non-etcd backends lose Watch and resource version support for free -- you must implement change notification and optimistic locking yourself
- Choose CRDs for 90% of use cases; choose extension API servers only when you need custom storage, ephemeral data, objects >1.5MB, or complex API behavior
- CRDs are configuration-driven (YAML); extension API servers are code-driven (Go/Python/Java)
