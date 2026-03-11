---
title: Private Service Connect (PSC) - Questions & Answers
---

## 1. What is Private Service Connect in GCP?
**Private Service Connect (PSC)** is a networking capability in Google Cloud that allows Virtual Private Cloud (VPC) networks to access services privately and securely.

It functions like a "secure pipe," enabling a consumer network to connect to a specific service (like a managed database, a 3rd party SaaS, or an internal API) without traversing the public internet or peering the entire network.

---

## 2. What specific problems does PSC solve?
Before PSC, connecting different VPCs usually required **VPC Peering**. PSC resolves three major limitations of peering:

* **IP Address Overlaps:** PSC works even if the consumer and producer networks use the exact same IP ranges (e.g., both use `10.0.0.0/24`). Peering fails in this scenario.
* **Security Radius:** PSC connects only to a *specific service*, whereas peering opens up connectivity to the *entire* network, which can be a security risk.
* **Operational Complexity:** It eliminates the need to coordinate IP ranges and firewall rules between different teams or organizations.

---

## 3. How does the architecture work?
PSC operates on a **Consumer-Producer** model over the Google Cloud backbone:

1.  **The Producer (Service Owner):** Publishes their service using a **Service Attachment**. This acts as the entry point or "doorbell" for the service.
2.  **The Consumer (You):** Creates a **PSC Endpoint** (a simple internal IP address like `10.0.0.5`) inside their own VPC.
3.  ** The Connection:** When the Consumer sends traffic to that local endpoint IP, Google's SDN automatically routes it privately to the Producer's service attachment.

---

## 4. How is PSC different from VPC Peering?

| Feature | Private Service Connect (PSC) | VPC Peering |
| :--- | :--- | :--- |
| **Connectivity Scope** | Connects to **one specific service port** | Connects **entire networks** |
| **IP Overlap** | **Allowed** (Ranges can conflict) | **Not Allowed** (Ranges must be unique) |
| **Traffic Flow** | Unidirectional (Consumer $\rightarrow$ Producer) | Bidirectional |
| **Transitivity** | Can be accessed from on-prem/peered networks | Not transitive by default |
| **Administration** | Independent (No coordination needed) | Requires mutual agreement on IP ranges |

---

## 5. What are the primary use cases for PSC?
* **Accessing Google APIs:** Securely connecting to services like BigQuery, Cloud Storage, or Vertex AI using private internal IPs rather than public ones.
* **Consuming SaaS:** Connecting to third-party partners (e.g., MongoDB Atlas, Snowflake, Confluent) securely within the Google network.
* **Cross-Organization Access:** Allowing different teams or acquired companies to share services without merging their networks or refactoring IP addresses.
