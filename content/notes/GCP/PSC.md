---
title: 🏗️ Architecture Overview - The PSC "Bridge"
---

Private Service Connect allows you to access a service (like Vertex AI Vector Search) as if it were sitting on your own local network.

```
resource "google_compute_address" "similar_looks_image_mebedding_v1_endpoint_psc" {

  project      = module.mercari-recommend-jp.gcp_project_id

  name         = "similar-looks-image-mebedding-v1-endpoint-psc"

  region       = "asia-northeast1"

  subnetwork   = "projects/kouzoh-shared-vpc-host-dev/regions/asia-northeast1/subnetworks/mercari-recommend-jp-dev-tokyo"

  address_type = "INTERNAL"

}



resource "google_compute_forwarding_rule" "similar_looks_image_mebedding_v1_endpoint_psc" {

  project = module.mercari-recommend-jp.gcp_project_id

  name    = "similar-looks-image-mebedding-v1-endpoint-psc"



  # $ gcloud ai index-endpoints describe 9087912204312772608 \

  #   --project mercari-recommend-jp-dev \

  #   --format="value(deployedIndexes.privateEndpoints.serviceAttachment)" \

  #   --region asia-northeast1

  # Using endpoint [https://asia-northeast1-aiplatform.googleapis.com/]

  # projects/cb214676415cd4228-tp/regions/asia-northeast1/serviceAttachments/sa-gkedpm-969ffd9cc50b094210c04a96ae743f

  target                = "projects/cb214676415cd4228-tp/regions/asia-northeast1/serviceAttachments/sa-gkedpm-969ffd9cc50b094210c04a96ae743f"

  region                = "asia-northeast1"

  load_balancing_scheme = ""

  network               = "projects/kouzoh-shared-vpc-host-dev/global/networks/shared-vpc-network-default"

  ip_address            = google_compute_address.similar_looks_image_mebedding_v1_endpoint_psc.id

}
```

### 1. The Reserved Address (`google_compute_address`)

This resource is the **Internal IP Reservation**.

- **Significance of `subnetwork`:** By specifying the subnetwork, you are telling GCP to "carve out" an IP from the specific CIDR range of that subnet. Because this is a **Shared VPC**, the subnet usually lives in a "Host Project," while your resource lives in a "Service Project." This ensures that the IP address is valid and routable for all VMs or GKE pods using that Shared VPC.
- **Significance of `INTERNAL`:** This flag is critical. It ensures the IP address is non-routable over the public internet. It exists only within the "walls" of your VPC.

### 2. The Forwarding Rule (`google_compute_forwarding_rule`)

This is the **Connection Logic**. It is the most complex piece of the puzzle.

- **`target` (The Service Attachment):** This is the URI of the Vertex AI backend. Notice the project ID `cb2...-tp`. This is a Google-managed "Tenant Project." You are essentially saying: _"Take any traffic hitting my local IP and tunnel it into this Google-owned backend."_
- **`load_balancing_scheme = ""`:** In standard Load Balancers, you'd see `INTERNAL`. For PSC, an empty string signifies that this isn't a "balancing" tool, but a **direct endpoint connection** (a 1:1 NAT mapping).
- **`ip_address`:** By pointing this to your `google_compute_address.id`, you are anchoring the rule to that specific IP. If you hit that IP, the rule "wakes up" and processes the request.

---

## ❓ Why is the `network` field mandatory?

This is the most common point of confusion. If you have the `subnetwork` in the Address resource, why do you need the `network` in the Forwarding Rule?

**1. Routing Context**
Internal IPs (like `10.x.x.x`) are not unique across all of Google Cloud; they are only unique **within your VPC**. Without the `network` field, the Forwarding Rule wouldn't know which private network's routing table it belongs to. It effectively "advertises" the endpoint to your VPC's internal router.

**2. Shared VPC Requirements**
Because you are using a Shared VPC (`kouzoh-shared-vpc-host-dev`), the network is managed centrally. By explicitly mentioning the network, you ensure the endpoint is visible to the entire VPC, allowing resources in _other_ service projects to potentially use this same AI endpoint if firewall rules allow it.

---

## 🌐 Adding the "Friendly Name": Private DNS

To avoid hardcoding an IP like `10.50.0.5` in your app code, you should wrap this in a Private DNS Zone.

```hcl
# 1. Create a Private DNS Zone linked to your Shared VPC
resource "google_dns_managed_zone" "vertex_psc_dns_zone" {
  project     = module.mercari-recommend-jp.gcp_project_id
  name        = "vertex-ai-internal-zone"
  dns_name    = "vertex-ai.internal."
  visibility  = "private"

  private_visibility_config {
    networks {
      network_url = "https://www.googleapis.com/compute/v1/projects/kouzoh-shared-vpc-host-dev/global/networks/shared-vpc-network-default"
    }
  }
}

# 2. Map the 'image-embedding' name to the PSC IP address
resource "google_dns_record_set" "vertex_psc_dns_record" {
  project      = module.mercari-recommend-jp.gcp_project_id
  name         = "image-embedding.${google_dns_managed_zone.vertex_psc_dns_zone.dns_name}"
  managed_zone = google_dns_managed_zone.vertex_psc_dns_zone.name
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.similar_looks_image_mebedding_v1_endpoint_psc.address]
}

```

---

## 📝 Detailed Flow Summary

| Step               | Action                                              | Logic                                                                                   |
| ------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **1. Request**     | Your App calls `image-embedding.vertex-ai.internal` | App uses a readable hostname.                                                           |
| **2. DNS**         | Cloud DNS returns `10.x.x.x`                        | DNS resolves the name to your reserved PSC IP.                                          |
| **3. VPC Routing** | Traffic hits the **Forwarding Rule**                | The rule is "listening" on that IP within the `network`.                                |
| **4. Tunneling**   | Encapsulation                                       | The Forwarding Rule wraps the packet and sends it to the `target` (Service Attachment). |
| **5. Processing**  | Vertex AI responds                                  | The AI engine processes the embedding and sends it back through the private tunnel.     |

---

## ⚠️ Important Significance

- **Security:** Traffic never enters the public internet, so it is immune to internet-based DDoS or snooping.
- **Performance:** Traffic moves across Google’s dedicated fiber backbone, offering the lowest possible latency between your app and the AI model.
- **Compliance:** Many industries (like Fintech or Healthcare) require that data never leave a private network. This setup satisfies those "Private Link" requirements.
