---
title: "Summary: Observability Hacks"
---

> **Full notes:** [[notes/O11y/observability-hacks|Observability Hacks →]]

## Key Concepts

**Docker binary wrapper** -- rename the real Docker binary and drop a shell script in its place that logs CI context (repo, workflow, job, run ID) for every invocation, then `exec`s the real binary. Zero-risk, transparent, good for answering "which repo is running Docker builds?"

**MITM proxy (lab only)** -- deploy mitmproxy as a DaemonSet to get full L7 visibility (URLs, status codes, headers) of CI runner traffic. Requires TLS termination and CA injection into runner pods. Not safe for production because auth tokens are visible in proxy memory.

**Golden images via GAR virtual repo** -- bake git config (`proactiveAuth=auto`, custom user-agent) into base images to eliminate 401s from `go mod download` inside Docker builds. Distribute transparently using a GAR virtual repository that prioritizes golden images over Docker Hub fallback. No Dockerfile changes needed.

**Squid CONNECT proxy** -- lighter alternative to MITM. Tunnels TLS without terminating it. You see destination host and byte counts but not paths/headers. Safe for longer-term use since it never sees plaintext credentials.

**Docker event streaming** -- stream `docker events` as a background process in CI jobs, tag with GitHub Actions context, forward to StatsD/DogStatsD. Answers questions like which images are pulled most, which workflows are heaviest Docker users.

## Quick Reference

| Technique | Visibility level | TLS termination? | Production safe? |
|-----------|-----------------|-------------------|-----------------|
| Docker wrapper | CLI invocation only | No | Yes |
| MITM proxy | Full L7 (URLs, headers, status) | Yes | No (lab only) |
| GAR golden images | User-agent tagging | No | Yes |
| Squid CONNECT | Host + bytes | No | Yes (dev/lab) |
| Docker events | Container/image lifecycle | No | Yes |

```
Problem: Docker builds generate 401s to GitHub at scale

Runner config ──────╳───── Docker build container
(proactiveAuth)          (isolated, stock git config)

Fix: Golden base image with git config baked in
     ↓
GAR Virtual Repo
  Priority 1: golden-images repo  ← patched images served first
  Priority 2: dockerhub-cache     ← fallback to Docker Hub
```

**Gotcha:** Docker mirror protocol prepends `library/` to official images. Push golden images under `library/golang`, not `golang`.

**Gotcha:** Digest-pinned images (`FROM img@sha256:...`) bypass the mirror entirely -- they resolve by content hash.

## Key Takeaways

- Runner-level git config does NOT propagate into Docker build containers or DinD sidecars.
- Golden images + GAR virtual repos fix the root cause (401s) without changing any Dockerfiles or workflows.
- MITM proxy gives the most detail but is only safe in lab environments due to credential exposure.
- Squid CONNECT proxy is a safe middle ground: host-level visibility without TLS termination.
- Docker event streaming via pre-job hooks is a low-overhead way to get fleet-wide container usage metrics.
