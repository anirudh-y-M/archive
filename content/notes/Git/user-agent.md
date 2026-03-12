---
title: GitHub API 401s - Go-http-client & OIDC
---

## HTTP Networking: The `Go-http-client/2.0` User-Agent

When auditing GitHub Actions logs or API access logs, you may encounter the `Go-http-client/2.0` string. This is not a security warning, but rather a default identification header sent by specific software.

### What is a User-Agent?

A **User-Agent (UA)** is a request header that acts as a "digital ID card" for software. It tells the server (GitHub) which browser, operating system, or library is making the call.

---

### Anatomy of `Go-http-client/2.0`

In the context of GitHub Actions, this specific string reveals the underlying technology used in your workflow:

* **Go:** The programming language used to write the tool.
* **http-client:** The standard `net/http` library within Go.
* **2.0:** Indicates the request is likely using **HTTP/2**.

#### Why is it appearing in GitHub Actions?

Since GitHub’s own infrastructure is heavily built on Go, many common triggers for this UA include:

1. **The GitHub CLI (`gh`):** When running `gh api`, the CLI may default to this UA if not overridden.
2. **Official Actions:** Actions like `actions/checkout` or `actions/upload-artifact` are often compiled Go binaries.
3. **Custom Binaries:** Any custom Go tool or third-party binary (like Terraform or Hugo) executed in your `run` steps.

---

### Best Practices & GitHub Policy

While technically valid, using the default Go User-Agent is generally discouraged for API integrations.

> 📝 **GitHub Documentation states:** "We request that you use your GitHub username, or the name of your application, for the User-Agent header value. This allows us to contact you if there are problems."

#### The Risks of Generic UAs

* **Rate Limiting:** If GitHub sees a spike in errors from `Go-http-client/2.0`, it might apply broader rate limits to that "group" to protect the API.
* **Debugging Difficulty:** Without a unique UA, you cannot distinguish between your custom script and a standard GitHub Action in your audit logs.

---

### Implementation: Setting a Custom UA in Go

If you are writing a Go tool to interact with GitHub, you should override the default behavior to be "good citizens" of the API.

```go
// Creating a new request
req, err := http.NewRequest("GET", "https://api.github.com/user", nil)

// Setting a custom User-Agent to identify your tool/workflow
req.Header.Set("User-Agent", "My-GitHub-Migration-Script/v1.1 (Contact: @user)")

client := &http.Client{}
resp, err := client.Do(req)

```

---

### Summary Checklist

| Component | Default Value | Recommended Value |
| --- | --- | --- |
| **User-Agent** | `Go-http-client/2.0` | `AppName/Version (GitHubUsername)` |
| **Impact** | Harder to debug/trace | Faster troubleshooting by GitHub |
| **Reason** | Language standard library | API Best Practices |

---

**See Also:**

- [GitHub API: User-Agent Requirements](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#user-agent-required)
- [Go `net/http` Documentation](https://pkg.go.dev/net/http)
- [[notes/AuthNZ/github-actions-token-anatomy|GitHub Actions Token Anatomy]] — GITHUB_TOKEN vs OIDC JWT, opaque vs structured tokens
- [[notes/Git/git-proactiveauth|Git proactiveAuth]] — avoiding 401s with credential helpers
