---
title: "Summary: Extension API Server Storage"
---

> **Full notes:** [[notes/K8s/extension_api_server_storage|Extension API Server Overview →]]

## Key Concepts

**Extension API Server** (Aggregated API Server) -- A separate HTTP server you deploy alongside the main K8s API server. Registered via an `APIService` resource, the main API server proxies matching requests to it. Looks like native K8s to clients.

**Bring Your Own Storage** -- Unlike CRDs (which must use etcd), an extension API server can store data anywhere: separate etcd, SQL database, in-memory, or nowhere (just proxy to an external API). You write the code, you choose the backend.

**CRDs vs Extension API Servers** -- CRDs are simple (just YAML) but locked to etcd with a ~1.5MB object limit. Extension API servers are complex (write code) but offer unlimited flexibility in storage, validation, and API behavior.

**Metrics Server example** -- Stores scraped CPU/memory data in RAM. No persistence needed -- if it restarts, it just scrapes again. This is a textbook use of in-memory storage in an extension API server.

## Quick Reference

```
kubectl get myresource
       │
       ▼
  kube-apiserver
       │ looks up APIService
       ▼
  "my-group" → proxy to extension-api-server Service
       │
       ▼
  Extension API Server (your code)
       │
       ▼
  Storage: etcd / SQL / RAM / external API / nothing
```

| | CRD | Extension API Server |
|---|---|---|
| Storage | Main etcd (mandatory) | Developer's choice |
| Max object size | ~1.5MB (etcd limit) | Unlimited |
| Complexity | Low (YAML only) | High (write code) |
| Watch support | Free (etcd built-in) | Must implement yourself if not using etcd |
| Best for | Config, operators | Metrics, heavy data, legacy proxying |

**Trade-offs of non-etcd storage:**
- Lose native Watch support (must implement change notification yourself)
- Lose automatic resource version / optimistic locking (must implement yourself)

## Key Takeaways

- Extension API servers give full control over storage -- the main use case is when CRDs' etcd-only constraint is a limitation
- Never connect an extension API server to the main cluster's etcd (security risk + stability risk)
- The `k8s.io/apiserver` library defaults to etcd, but you can swap the `RESTStorage` interface to point anywhere
- Choose CRDs for 90% of use cases; choose extension API servers only when you need custom storage, ephemeral data, or complex API behavior
- The Metrics Server is the canonical example of an extension API server with in-memory storage
