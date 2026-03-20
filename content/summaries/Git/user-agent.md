---
title: "Summary: GitHub API User-Agent Best Practices"
---

> **Full notes:** [[notes/Git/user-agent|GitHub API 401s - Go-http-client & OIDC →]]

## Key Concepts

### What is a User-Agent?

A User-Agent (UA) is an HTTP request header that acts as a "digital ID card" for software. It tells the server (GitHub) which browser, OS, or library is making the call. In the context of GitHub Actions and API access, the UA string helps identify the tool or integration making requests.

### Anatomy of `Go-http-client/2.0`

This is the default User-Agent sent by Go's standard `net/http` library. **Go** = the programming language, **http-client** = the standard `net/http` library, **2.0** = indicates the request is likely using HTTP/2. It appears in GitHub Actions logs because much of GitHub's infrastructure and tooling is built in Go.

### Why It Appears in GitHub Actions

Common triggers for this UA string in CI environments: the **GitHub CLI (`gh`)** when running `gh api` (if UA isn't overridden), **official Actions** like `actions/checkout` or `actions/upload-artifact` (compiled Go binaries), and **custom binaries** or third-party tools like Terraform or Hugo executed in `run:` steps.

### Best Practices and GitHub Policy

GitHub's documentation explicitly requests that you use your GitHub username or application name as the User-Agent header value, so they can contact you if problems arise. While the default Go UA is technically valid, using it is discouraged for API integrations.

**Risks of generic UAs:** GitHub may apply broader rate limits to the `Go-http-client/2.0` "group" during error spikes, affecting all users sharing that UA. Without a unique UA, you also cannot distinguish your custom scripts from standard GitHub Actions in audit logs, making debugging significantly harder.

### Setting a Custom UA in Go

```go
req, err := http.NewRequest("GET", "https://api.github.com/user", nil)
req.Header.Set("User-Agent", "My-GitHub-Migration-Script/v1.1 (Contact: @user)")
client := &http.Client{}
resp, err := client.Do(req)
```

## Quick Reference

| Aspect | Default | Recommended |
|--------|---------|-------------|
| **User-Agent** | `Go-http-client/2.0` | `AppName/Version (GitHubUsername)` |
| **Debugging** | Can't distinguish your tool from other Go clients | Clear identification in audit logs |
| **Rate limiting** | Risk of group throttling during error spikes | Isolated rate limit bucket |
| **Impact** | Harder to debug/trace | Faster troubleshooting by GitHub support |

**Common sources of `Go-http-client/2.0` in CI:**
- `gh` CLI
- `actions/checkout`, `actions/upload-artifact` (compiled Go binaries)
- Custom Go binaries (Terraform, Hugo, etc.)

## Key Takeaways

- Always set a descriptive User-Agent when calling the GitHub API from custom tools
- The default Go UA is technically valid but makes troubleshooting and rate limit isolation harder
- GitHub explicitly requests identifiable UAs in their API documentation -- it is a stated best practice, not just a suggestion
- In CI environments, multiple tools may share the same generic UA -- custom UAs help distinguish them in audit and access logs
- The `2.0` in `Go-http-client/2.0` indicates HTTP/2, not the version of the Go library
