---
title: Understanding Self-Signed Certificates: A Comprehensive Guide
---

This document summarizes the cryptographic process of creating and verifying self-signed certificates.

---

### **Q1: In a self-signed certificate, which key signs the Certificate Signing Request (CSR)?**

**Answer:** The **Private Key** of the entity (the server or individual) is used to sign the data that becomes the certificate.

In a traditional setup involving a Certificate Authority (CA), you would send your CSR to the CA, and they would sign it with *their* private key. In a **self-signed** scenario, you act as your own authority, using your own private key to "vouch" for the public key contained within the certificate.

#### **Example: The Process in OpenSSL**

When you run a command to generate a self-signed certificate, you are essentially combining the creation of a key, a request, and the signing into one step:

```bash
# Generating a private key and a self-signed certificate in one go
openssl req -x509 -newkey rsa:4096 -keyout my_private_key.pem -out my_certificate.pem -days 365 -nodes

```

* **`-newkey rsa:4096`**: Creates the Private Key.
* **`-x509`**: Tells OpenSSL to output a self-signed certificate instead of a certificate request.
* **The Signature**: OpenSSL uses the `my_private_key.pem` it just generated to digitally sign the `my_certificate.pem`.

---

### **Q2: How does the certificate verify itself?**

**Answer:** A self-signed certificate verifies itself through a mathematical loop. It contains the **Public Key** that corresponds exactly to the **Private Key** used to sign it.

To verify the certificate, a client (like a browser) performs the following logic:

1. **Check Issuer/Subject:** It notices that the "Issuer" (who signed it) and the "Subject" (who it is for) are identical.
2. **Extract Public Key:** It pulls the Public Key out of the certificate data.
3. **Validate Signature:** It uses that Public Key to decrypt/verify the digital signature attached to the certificate.

If the signature is valid, the math proves that the certificate has not been altered since it was signed by the owner of the matching Private Key.

#### **Example: Inspecting the "Self-Verification"**

You can see this loop by inspecting a certificate's details:

```bash
openssl x509 -in my_certificate.pem -text -noout

```

Look for:

* **Subject:** `CN=MyLocalServer`
* **Issuer:** `CN=MyLocalServer`  *(These being the same confirms it is self-signed)*
* **Subject Public Key Info:** The actual key used for verification.

---

### **Q3: If the math works, why do browsers show a "Not Secure" warning?**

**Answer:** There is a fundamental difference between **Cryptographic Integrity** and **Identity Trust**.

* **Cryptographic Integrity (Success):** The self-verification proves that the certificate wasn't tampered with and that the person who produced the Public Key also holds the Private Key. The math is perfect.
* **Identity Trust (Failure):** A browser has no way of knowing *who* actually created that key pair. Anyone can create a self-signed certificate claiming to be "https://www.google.com/search?q=google.com".

Because the certificate is not signed by a "Root Authority" already trusted in the browser's pre-installed list (the Root Store), the browser warns the user: *"I can verify the math, but I cannot verify the identity of the person behind the math."*

---

### **Q4: Summary Table of the Lifecycle**

| Phase | Component Used | Action |
| --- | --- | --- |
| **Generation** | RSA/ECC Algorithm | Create a Private/Public key pair. |
| **Creation** | Private Key | Sign the identity data and Public Key to create the `.crt` file. |
| **Verification** | Public Key (inside the cert) | Used by the client to verify the signature on the same cert. |
| **Validation** | Root Store / Trust Anchor | Client checks if a known, trusted third party (CA) signed the cert. |

---

### **Practical Example: Verifying a file manually**

If you have a certificate and want to check its signature using its own internal public key manually via command line:

```bash
openssl verify -CAfile my_certificate.pem my_certificate.pem

```

* **`-CAfile`**: Here, we are telling the tool to use `my_certificate.pem` as the "trusted authority" to check itself. If it returns `OK`, the self-signature is mathematically valid.
