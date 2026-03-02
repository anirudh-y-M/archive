## Section 1: Architecture & Physical Setup

### Q: What is the physical setup created when I deploy a Service and Ingress in GKE?

**A:** When you apply your Kubernetes manifests using **Container Native Load Balancing**, the following infrastructure chain is provisioned:

1. **The Pod:** Your application container starts and receives an ephemeral IP (e.g., `10.4.1.5`) directly inside the VPC network.
2. **The Service (NEGs):** GKE creates a **Network Endpoint Group (NEG)**. This is a dynamic registry that tracks the IP addresses of your Pods. It allows the load balancer to target Pods directly, bypassing the traditional NodePort/iptables logic.
3. **The Ingress (GLB):** The GKE Ingress Controller provisions a **Google Global HTTPS Load Balancer**.
* **Frontend:** Binds to a static global Anycast IP.
* **Backend:** Binds to the NEG (your specific pods).


4. **Certificates:** Two layers of TLS are used.
* **Edge Certificate:** Managed by Cloudflare (terminates TLS for the user).
* **Origin Certificate:** A Google Managed Certificate attached to the GLB (terminates TLS from Cloudflare).



### Q: List every point of Load Balancing and NAT involved in this architecture.

**A:**

* **Cloudflare (L7):** Uses **GSLB / Anycast** to route users to the nearest Edge data center.
* **Google Edge (L3/L4):** Uses **Anycast** and **Maglev** (Google's software LB) to distribute packets from the fiber backbone to thousands of Google Front End (GFE) servers.
* **Google GLB (L7):** An HTTP(S) Proxy that terminates TLS and routes to specific Regions/Zones based on latency and capacity.
* **VPC Network (L3):** Uses SDN Routing to send packets from GFE to the specific Node.
* **Cloud NAT (L3):** Used for **Outbound** traffic only (if a pod calls an external API), mapping the Pod IP to a shared public Static IP.

---

## Section 2: The Packet Flow (The "Double Anycast" Journey)

### Q: Trace a request from a user in Paris to a Pod in the USA. How does networking work start-to-finish?

**A:** The journey involves 5 distinct legs with two TLS terminations and two Anycast hops.

**Leg 1: User to Cloudflare (The First Anycast)**

* **DNS:** The user resolves `www.yourdomain.com` to a Cloudflare IP.
* **Anycast:** The user connects to the physically closest Cloudflare Data Center (likely in Paris).
* **TLS Termination #1:** Cloudflare decrypts the packet using the Edge Certificate. WAF and Cache rules are applied.

**Leg 2: Cloudflare to Google (The Second Anycast)**

* **Re-Encryption:** Cloudflare re-encrypts the packet using the Google Origin Certificate.
* **The Jump:** Cloudflare targets your Google Static IP. Because Google *also* uses Anycast, Cloudflare connects to Google's network immediately in Paris (via Direct Peering), rather than traversing the public internet to the US.

**Leg 3: Google Edge to the Load Balancer**

* **Google Front End (GFE):** The packet hits Google's network at the closest Point of Presence (PoP).
* **TLS Termination #2:** The Google GLB decrypts the packet.
* **Global Routing:** The GLB checks the **NEG**. It sees pods are only available in `us-central1`.
* **Transport:** The packet travels over Google's private global fiber backbone from Europe to the US.

**Leg 4: GLB to the Pod (Container Native Mode)**

* **Delivery:** The GLB sends the packet directly to the Pod IP (`10.4.1.5`).
* **No NAT:** In Container Native mode, **no Destination NAT (DNAT)** occurs on the Node. The packet is delivered straight to the Pod's network namespace.

**Leg 5: The Return Path**

* The Pod generates a response. The VPC tracks the connection state and routes the packet back through the exact same path: Pod  Google Backbone  Google Edge (Paris)  Cloudflare (Paris)  User.

---

## Section 3: Terraform & Implementation

### Q: What is the `google_compute_global_address` Terraform resource?

**A:** This resource reserves a permanent **Static IP address** within Google Cloud. It ensures that if you delete and recreate your Load Balancer, you do not lose your IP address.

**Terraform Code:**

```hcl
resource "google_compute_global_address" "ingress_ip" {
  name = "my-global-ingress-ip"
  # Implicitly global for this resource type
}

```

### Q: How is this Terraform resource connected to GKE and the GLB?

**A:** The connection is made using a specific **Kubernetes Annotation** in your Ingress YAML. This annotation tells the Ingress Controller to use the existing reserved IP instead of creating a new random one.

**Ingress YAML:**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  annotations:
    # This string must match the 'name' in your Terraform
    kubernetes.io/ingress.global-static-ip-name: "my-global-ingress-ip"
spec:
  rules:
  - host: www.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-service
            port:
              number: 80

```

### Q: Which IP do I register to my domain address?

**A:**

1. **At the Registrar (GoDaddy/Namecheap):** You do **not** enter an IP here. You point the **Nameservers** to Cloudflare (e.g., `ns1.cloudflare.com`).
2. **At Cloudflare (DNS Dashboard):** This is where you use the Terraform IP.
* Create an **A Record**.
* **Name:** `www`
* **Content:** The IP address from `google_compute_global_address` (e.g., `34.98.10.5`).
* **Proxy Status:** **Proxied** (Orange Cloud).



---

## Section 4: Security & "Spoofing"

### Q: Can I trick Cloudflare by setting up my own server with the same Static IP?

**A:** **No.** This is prevented by **BGP Routing** and **RPKI**.

* **BGP Propagation:** Google (ASN 15169) announces ownership of the IP block containing your Static IP to the global internet.
* **RPKI (Resource Public Key Infrastructure):** Google cryptographically signs a **Route Origin Authorization (ROA)**. This is a "digital passport" that tells the world only Google is allowed to announce these IPs.
* **The Result:** If you configure the IP on a rogue server, upstream routers (ISPs) will reject your announcement because it lacks the valid cryptographic signature.

### Q: Can I generate a fake certificate (CSR) if I don't own the domain?

**A:** **No.** Public Certificate Authorities (CAs) enforce **Domain Validation (DV)**.

* You can create a CSR claiming to be `yourdomain.com`.
* However, the CA will require proof of ownership (DNS challenge or HTTP challenge). Since you cannot modify the DNS records (locked at Cloudflare) or the server files (locked at Google), the CA will refuse to sign the certificate.

---

## Section 5: "Direct-to-Google" (Removing Cloudflare)

### Q: What happens to the operation and flow if I eliminate Cloudflare?

**A:** The architecture changes from a "Double Anycast" proxy setup to a **Direct Exposure** setup.

**1. The New Packet Flow:**

* **User  Google:** The user resolves `www.yourdomain.com` directly to your Google Static IP (`34.98.10.5`).
* **Connection:** The user connects directly to the Google Front End (GFE). The "mask" is gone; the user knows your true backend IP.
* **TLS Termination:** Google terminates the TLS immediately using the Google Managed Certificate.

**2. Operational Changes (Your New To-Do List):**

* **DNS:** You must move DNS management to a provider like Google Cloud DNS. Create an A Record pointing directly to your IP.
* **Security:** You lose Cloudflare's WAF. You must enable **Google Cloud Armor** on your GLB to provide DDoS protection and filtering.
* **Certificates:** You rely solely on the Google Managed Certificate. You must ensure it is `ACTIVE` and valid, as it is now the only line of defense for encryption.

### Q: Comparison: With vs. Without Cloudflare

| Feature | With Cloudflare | Without Cloudflare |
| --- | --- | --- |
| **Visible IP** | Cloudflare Anycast IP (Privacy) | Google Static IP (Public) |
| **DDoS Protection** | Cloudflare Edge | **Google Cloud Armor** (Must be enabled) |
| **Latency** | Extremely Low (Double Private Fiber) | Very Low (Google Private Fiber) |
| **SSL Management** | Dual (Edge + Origin) | Single (Google Managed) |
| **Cost** | Cloudflare + GCP | GCP Only (Armor costs extra) |
