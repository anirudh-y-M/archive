---
title: "Summary: Observability Hacks"
---

> **Full notes:** [[notes/O11y/observability-hacks|Observability Hacks →]]

## Key Concepts

### Docker Binary Wrapper

When you can't identify which Docker builds generate specific traffic but know it's coming from `docker build` steps, wrap the Docker binary to log CI context. Rename the real binary to `docker.original`, drop a shell script at `/usr/bin/docker` that logs a JSON line (repo, workflow, job, run ID, command) to `/var/log/docker-wrapper.jsonl`, then `exec`s the real binary. The wrapper is fully transparent -- `exec` replaces the shell process, so exit codes, stdout, and stderr pass through unchanged.

Logging destinations: file (scrape with Fluent Bit), Cloud Logging (`gcloud logging write`), or PubSub-to-BigQuery for structured querying. Limitations: only captures outer CLI invocations (not what happens inside `RUN` steps), doesn't cover DinD daemon pulls, and must be baked into the runner image. Best for answering "which repo/workflow is running Docker builds?" with zero risk and no proxy infrastructure.

### MITM Proxy on CI Runners (Lab Only)

For full HTTP-level visibility of CI runner traffic, deploy mitmproxy as a DaemonSet. The setup includes: (1) cert-manager for the MITM CA certificate, (2) mitmproxy DaemonSet running `mitmdump` with a Python addon that logs requests as JSON (masking `Authorization` headers), (3) runner pod patches that inject the CA cert into the trust store and set `HTTPS_PROXY`.

This gives full L7 visibility per request: method, URL, status code, user-agent, content length, timestamp. It is **lab-only** because auth headers are visible in proxy memory (even with log masking), TLS termination requires injecting a custom CA into every runner pod, DinD sidecars don't inherit the runner's proxy config or trust store, and mitmproxy is single-threaded Python that won't scale to production traffic.

### Golden Images via GAR Virtual Repository

The core problem: `FROM golang:1.24-bookworm` pulls a stock image where git has default settings (no `proactiveAuth`, generic user-agent). When builds run `go mod download`, git sends unauthenticated requests, gets 401s, then retries with credentials. At scale, these 401s trigger GitHub's anti-abuse system. Runner-level git config does **not** propagate into Docker build containers.

The fix: build custom base images with `proactiveAuth=auto` and a custom user-agent baked in. Distribute them transparently via a **GAR virtual repository** -- a single endpoint that routes pulls across multiple backing repos by priority:

```
Virtual repo (mirror endpoint)
  ├── Priority 1: golden-images (patched base images)
  └── Priority 2: dockerhub-cache (pull-through for Docker Hub)
```

`FROM golang:1.24-bookworm` checks golden-images first; if the tag exists, it's served. Otherwise falls through to Docker Hub. No Dockerfile or workflow changes needed -- the mirror is configured at the Docker daemon level via `--registry-mirror`.

**Gotchas:** Docker's mirror protocol prepends `library/` to official images, so golden images must be pushed under `library/golang` (not just `golang`). Digest-pinned images (`FROM img@sha256:...`) bypass the mirror entirely because they resolve by content hash -- the golden image has a different digest, so pinned Dockerfiles always get the original.

**Observability:** Golden images set a user-agent with a `proactive` tag. In HTTP logs: `git/2.39.5` = stock image (still 401s), `git/2.39.5 proactive` = golden image (no 401s). This tells you exactly how much traffic has been migrated.

### Squid CONNECT Proxy (No TLS Termination)

A lighter alternative to mitmproxy when you only need domain-level visibility. Squid in CONNECT mode tunnels encrypted connections without terminating TLS -- you see destination `host:port` and byte counts, but not request paths, headers, or bodies. No custom CA or trust store injection needed.

Deployment: Squid DaemonSet on port 3128, DinD daemon configured via `daemon.json` proxies, runner env vars for non-Docker traffic. Important: set `GIT_HTTP_VERSION=HTTP/1.1` because HTTP/2 multiplexing doesn't work through CONNECT proxies.

Logs can be enriched with Kubernetes pod metadata using Squid's **external ACL helpers** -- a subprocess that receives the client IP per request and queries the K8s API to resolve source pod IPs to pod names/annotations. This tags each log line with runner identity for workflow correlation. Safe to leave running longer-term since it never sees plaintext credentials.

### Docker Event Streaming

`docker events --format json` emits a JSON line for every container, image, network, and volume lifecycle event. Run it as a background process from a **runner pre-job hook**, tag each event with GitHub Actions context (workflow, repo, run ID), and forward to a metrics backend via UDP (StatsD/DogStatsD). Non-blocking, auto-terminates when the runner pod dies at job end.

Answers: which images are pulled most frequently, how many containers per job, which workflows are heaviest Docker users, whether image pulls are failing or timing out.

## Quick Reference

| Technique | Visibility level | TLS termination? | Production safe? | Deployment |
|-----------|-----------------|-------------------|-----------------|------------|
| Docker wrapper | CLI invocation only | No | Yes | Runner image |
| MITM proxy | Full L7 (URLs, headers, status) | Yes (custom CA) | No (lab only) | DaemonSet + cert-manager |
| GAR golden images | User-agent tagging | No | Yes | Docker daemon mirror flag |
| Squid CONNECT | Host + bytes | No | Yes (dev/lab) | DaemonSet + env vars |
| Docker events | Container/image lifecycle | No | Yes | Pre-job hook |

```
Problem: Docker builds generate unauthenticated 401s to GitHub at scale

Runner config ──────╳───── Docker build container
(proactiveAuth,           (isolated, stock git config,
 custom user-agent)        no credential helpers)

Fix: Golden base image with git config baked in
     ↓
GAR Virtual Repo (--registry-mirror on dockerd)
  Priority 1: golden-images repo  ← patched images served first
  Priority 2: dockerhub-cache     ← fallback to Docker Hub

Tag-based pull  → resolved by priority, golden wins
Digest-pinned   → bypasses mirror, gets original image
library/ prefix → required for official images in golden repo


Squid CONNECT proxy (no TLS break):
  Runner/DinD ──► Squid (port 3128) ──► github.com
                    │
                    ▼
              Log: host, bytes, pod metadata
              (no paths, no headers, no bodies)
```

## Key Takeaways

- Runner-level git config does NOT propagate into Docker build containers or DinD sidecars -- each `docker build` starts fresh with stock settings.
- The Docker binary wrapper is the cheapest, zero-risk option for correlating Docker CLI invocations to CI context.
- MITM proxy gives the most detail (full L7) but is lab-only due to credential exposure, CA injection requirements, DinD incompatibility, and Python single-threaded performance.
- Golden images + GAR virtual repos fix the root cause (unauthenticated 401s) without changing Dockerfiles or workflows; the mirror is configured at the daemon level.
- Push golden images under `library/` prefix; digest-pinned images bypass the mirror by design.
- Squid CONNECT is a safe middle ground: host-level visibility without TLS termination, enrichable with K8s pod metadata via external ACL helpers.
- Docker event streaming via pre-job hooks is a low-overhead way to get fleet-wide container/image lifecycle metrics via StatsD.
