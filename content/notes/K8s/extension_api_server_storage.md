---
title: Extension API Server Overview
---

### **Section 1: Core Concepts & Architecture**

#### **Q1: What exactly is an "External API Server" in the context of Kubernetes?**

**Answer:**
An External API Server (often called an Aggregated API Server) is a separate HTTP server that you develop and deploy, which runs _alongside_ the main Kubernetes API server. It extends the Kubernetes API by adding new API groups and resources that look and feel like native Kubernetes objects (e.g., Pods, Services) but are processed by your custom code rather than the core Kubernetes logic.

#### **Q2: How does the main Kubernetes API server know about this external server?**

**Answer:**
It uses the **Aggregation Layer**. You register your external server using a specific Kubernetes resource called an `APIService`.

- **The Mechanism:** When you create an `APIService` object, you tell the main API server: _"If anyone asks for `/apis/my-extension.group/v1`, please forward (proxy) that request to this specific Service running in the cluster."_
- **The Result:** The main API server acts as a gateway. It handles authentication (usually) and then simply tunnels the HTTP request to your external server.

#### **Q3: What is the default storage for the main Kubernetes API Server?**

**Answer:**
The main Kubernetes API server uses **etcd**.

- **Etcd:** A strongly consistent, distributed key-value store.
- **Why:** Kubernetes relies on etcd for all cluster state data because it guarantees that once a write is confirmed, it is persisted across the cluster. It is optimized for watching changes (key to the controller pattern).

---

### **Section 2: The Storage Question (The Core of Our Discussion)**

#### **Q4: Does an External API Server store its objects in the main cluster's etcd?**

**Answer:**
**No, it is not required to.** This is the critical distinction.
Because the External API Server is just a piece of software you write, you have full control over the "backend." When the main API server proxies a request (e.g., `POST /apis/my-group/v1/my-resource`) to your server, your code receives the JSON body. What you do with that data is entirely up to you.

#### **Q5: Can an External API Server use the main cluster's etcd if it wants to?**

**Answer:**
Technically, yes, but it is **strongly discouraged** and often architecturally difficult.

- **Security:** Giving an external pod direct access to the core etcd (where Secrets and core cluster state live) is a massive security risk.
- **Stability:** If your extension spams etcd with bad queries, you could bring down the entire cluster.
- **Standard Pattern:** If you want etcd-like storage, you usually deploy a **separate, dedicated etcd instance** just for your API server.

#### **Q6: If not the main etcd, where can an External API Server store data?**

**Answer:**
It allows for "Bring Your Own Storage" (BYOS). Common options include:

1. **A Separate Etcd Cluster:** If you want the same behavior as standard K8s resources (watches, consistency) but want isolation.
2. **Relational Databases (SQL):** If your objects have complex relationships, require joins, or need strict referential integrity (e.g., PostgreSQL, MySQL). Etcd is a key-value store and is poor at complex queries; an External API server allows you to bypass this limitation.
3. **In-Memory (RAM):** For data that is calculated on the fly or doesn't need to persist if the pod restarts.

- _Example:_ The **Metrics Server**. It scrapes node CPU/Memory usage and stores it in RAM. If the metrics server restarts, it just scrapes them again. It doesn't need a database.

4. **No Storage (Proxy/Adapter):** The server might simply translate the K8s API request into a call to a third-party API (like AWS, Google Cloud, or a legacy corporate API) and return the result.

---

### **Section 3: Comparison - CRDs vs. External API Servers**

#### **Q7: How does this differ from Custom Resource Definitions (CRDs)?**

**Answer:**
The difference is fundamental to how data is managed:

- **CRDs (Configuration driven):**
- **How it works:** You upload a YAML definition (`CustomResourceDefinition`).
- **Storage:** Kubernetes **automatically** handles the storage for you. It strictly stores the JSON/YAML data in the **main cluster's etcd**.
- **Flexibility:** You have **zero** control over storage. You cannot use SQL. You cannot use an external API. It _must_ be etcd.

- **External API Server (Code driven):**
- **How it works:** You write Go/Python/Java code to handle HTTP requests.
- **Storage:** You handle the storage logic.
- **Flexibility:** Infinite. You can store data in a text file, a blockchain, a database, or nowhere at all.

#### **Q8: Why would I choose an External API Server over a CRD?**

**Answer:**
You choose the External API Server (Aggregation) path specifically when CRDs hit their limits:

1. **Storage constraints:** You need to store data in a legacy SQL database, or the data is too large for etcd (etcd has a limit of ~1.5MB per object).
2. **Ephemeral Data:** You have data (like metrics) that changes constantly and shouldn't be written to disk (etcd) to avoid burning out the disk I/O.
3. **Complex Validation/Behavior:** You need very specific API behavior (like special verbs or non-standard patching strategies) that declarative CRDs cannot support.

---

### **Section 4: Implementation Details**

#### **Q9: If I use the `k8s.io/apiserver` library to build my extension, doesn't it default to etcd?**

**Answer:**
Yes.

- Most developers build External API Servers using the official Kubernetes library (`k8s.io/apiserver`).
- This library provides a framework that "looks" like the standard K8s API server.
- Out of the box, this library includes an **etcd adapter**. If you use the default setup, it will ask for an etcd connection string.
- **However**, you can swap out the `RESTStorage` interface in that library to point to anything else (memory, SQL, etc.).

#### **Q10: What are the downsides of using an External API Server with non-etcd storage?**

**Answer:**
If you switch to SQL or In-Memory, you lose some "magic" features that Kubernetes provides for free when using etcd:

- **Watch Events:** `kubectl get pods -w` works because etcd supports "watching" keys. If you use PostgreSQL, you have to implement a mechanism to notify the API server when rows change so it can push updates to the user. This is hard to implement manually.
- **Resource Versions:** Kubernetes relies on optimistic locking (resource versions) to prevent write conflicts. You must implement this logic yourself if you use a custom backend.

---

### **Summary Table: The "Storage" Perspective**

| Feature                   | **CRD**                                  | **External API Server**                       |
| ------------------------- | ---------------------------------------- | --------------------------------------------- |
| **Primary Storage**       | Main Cluster Etcd (Mandatory)            | Developer Choice (SQL, Memory, Separate Etcd) |
| **Who writes the bytes?** | Kube-APIServer                           | Your Custom Binary                            |
| **Max Object Size**       | ~1.5MB (Etcd limit)                      | Unlimited (Depends on your backend)           |
| **Complexity**            | Very Low                                 | Very High                                     |
| **Ideal Use Case**        | config, operators, standard k8s patterns | Metrics, heavy data, proxying legacy systems  |

### **Next Step**

Would you like to see a **diagram** of the request flow, showing how `kubectl` talks to the main API server and how that request gets routed to a custom External API Server with a SQL backend?
