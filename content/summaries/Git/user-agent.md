---
title: "Summary: GitHub API User-Agent Best Practices"
---

> **Full notes:** [[notes/Git/user-agent|GitHub API 401s - Go-http-client & OIDC →]]

## Key Concepts

**`Go-http-client/2.0`** is the default User-Agent string sent by Go's `net/http` library. The `2.0` indicates HTTP/2. It shows up in GitHub Actions logs because many GitHub tools (CLI, official actions, custom binaries) are written in Go.

**Why it matters:** GitHub recommends setting a custom UA with your app name or GitHub username. Generic UAs make debugging harder and may attract broader rate limits during error spikes.

## Quick Reference

| Aspect | Default | Recommended |
|--------|---------|-------------|
| **User-Agent** | `Go-http-client/2.0` | `AppName/Version (GitHubUsername)` |
| **Debugging** | Can't distinguish your tool from other Go clients | Clear identification in audit logs |
| **Rate limiting** | Risk of group throttling | Isolated rate limit bucket |

**Setting a custom UA in Go:**

```go
req.Header.Set("User-Agent", "My-App/v1.0 (@username)")
```

**Common sources of `Go-http-client/2.0` in CI:**
- `gh` CLI
- `actions/checkout`, `actions/upload-artifact`
- Custom Go binaries (Terraform, Hugo, etc.)

## Key Takeaways

- Always set a descriptive User-Agent when calling the GitHub API from custom tools
- The default Go UA is valid but makes troubleshooting and rate limit isolation harder
- GitHub explicitly requests identifiable UAs in their API documentation
- In CI environments, multiple tools may share the same generic UA -- custom UAs help distinguish them in logs
