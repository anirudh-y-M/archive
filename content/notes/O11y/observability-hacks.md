---
title: Observability Hacks
---

## Docker Binary Wrapper

When you can't identify which Docker builds are generating specific traffic (e.g., unauthenticated 401s to GitHub), but you know it's coming from `docker build` steps — wrap the Docker binary to log CI context before every invocation.

### How it works

On the runner image, rename the real binary and drop a shell wrapper in its place:

```bash
mv /usr/bin/docker /usr/bin/docker.original

cat > /usr/bin/docker << 'WRAPPER'
#!/bin/sh
# Log CI context for every docker invocation
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"repo\":\"${GITHUB_REPOSITORY}\",\"workflow\":\"${GITHUB_WORKFLOW}\",\"job\":\"${GITHUB_JOB}\",\"run_id\":\"${GITHUB_RUN_ID}\",\"cmd\":\"$1\"}" \
  >> /var/log/docker-wrapper.jsonl 2>/dev/null || true
exec /usr/bin/docker.original "$@"
WRAPPER
chmod +x /usr/bin/docker
```

Every `docker build`, `docker pull`, `docker push` etc. gets a log line with the GitHub Actions context. The wrapper is transparent — `exec` replaces the shell process with the real binary, so exit codes, stdout, stderr all pass through unchanged.

### Where to log

- **File** (`/var/log/docker-wrapper.jsonl`) — simplest, scrape with Fluent Bit or similar
- **Cloud Logging** — pipe to `gcloud logging write` instead of a file (adds latency per invocation)
- **PubSub → BQ** — for structured querying at scale

### Limitations

- Only captures the outer `docker` CLI invocation, not what happens inside the build (e.g., `RUN go mod download` inside a Dockerfile)
- DinD (Docker-in-Docker) runners have a separate Docker daemon in a sidecar — the wrapper only covers the client binary on the runner, not the daemon's own pulls
- Needs to be baked into the runner image or injected via an init container

### When to use

Good for answering "which repo/workflow is running Docker builds?" when you have no other way to correlate traffic. Cheap, zero-risk, no TLS termination or proxy infrastructure needed.

## MITM Proxy on CI Runners

For full HTTP-level visibility (status codes, URLs, headers, response times) of traffic from CI runners to GitHub, deploy an intercepting proxy.

### Implementation

A lab-only mitmproxy setup deploys:

1. **cert-manager** issuer + certificate for the MITM CA (self-signed root → leaf cert for the proxy)
2. **mitmproxy DaemonSet** — one pod per node, runs `mitmdump` with a Python addon that logs requests as JSON (masking `Authorization` headers)
3. **Runner pod patches** — injects the CA cert into the runner trust store and sets `HTTPS_PROXY` pointing to the mitmproxy pod on the same node

### What you get

Full L7 visibility per request:

| Field | Example |
|-------|---------|
| method | `GET` |
| url | `https://github.com/org/some-repo.git/info/refs?service=git-upload-pack` |
| status | `401` |
| user_agent | `git/2.39.5` |
| content_length | `0` |
| timestamp | `2026-02-26T06:12:34Z` |

This is the same level of detail GitHub provides in their support CSVs — but self-hosted and real-time.

### Why it's lab-only

- **Auth headers are visible** — even with masking in logs, the proxy process sees tokens in memory. Anyone who can exec into the pod can read them.
- **TLS termination required** — the proxy generates fake certs for github.com. Requires injecting a custom CA into every runner pod's trust store.
- **DinD incompatible** — Docker-in-Docker runners run a separate Docker daemon in a sidecar container. That sidecar makes its own HTTPS connections (for `docker pull`, registry auth, etc.) and doesn't inherit the runner's `HTTPS_PROXY` or CA trust store. You'd need to separately configure the DinD sidecar, which is fragile.
- **Performance risk** — mitmproxy is single-threaded Python. Fine for a lab cluster with low traffic, but not suitable for production runner pools.

### When to use

Useful for short-term debugging in a lab/dev cluster when you need to see exactly what HTTP requests runners are making and what responses they get. Not for production.

## Golden Images via GAR Virtual Repository

When the problem is inside Docker builds (e.g., `RUN go mod download` generating unauthenticated 401s), you can't fix it by configuring the runner — the build container is isolated. Instead, bake the fix into the base image and distribute it transparently via a registry mirror.

### The problem with Docker builds

A Dockerfile like `FROM golang:1.24-bookworm` pulls a stock image from Docker Hub. Inside that image, git has default settings — no `proactiveAuth`, no credential helper, generic user-agent. When the build runs `go mod download`, git sends an unauthenticated request to GitHub, gets a 401, then retries with credentials. At scale (hundreds of concurrent builds), these 401s trigger GitHub's anti-abuse system.

The runner's git config (`proactiveAuth`, custom user-agent, credential helpers) does **not** propagate into Docker build containers or DinD sidecars. Each `docker build` starts fresh.

### Golden base images

Build custom versions of commonly-used base images with git config baked in:

- `proactiveAuth=auto` — send credentials on first request, skip the 401
- URL-scoped user-agent with a `proactive` tag — identifies golden image traffic in logs
- Credential helper setup if needed

Example for `golang:1.24-bookworm`:

```dockerfile
FROM golang:1.24-bookworm
RUN git config --system http.https://github.com/your-org/.proactiveAuth auto \
 && git config --system http.https://github.com/your-org/.userAgent \
      "git/$(git --version | awk '{print $3}') proactive"
```

### GAR virtual repository — transparent distribution

The key insight: you don't need to change any Dockerfiles. GAR (Google Artifact Registry) supports **virtual repositories** — a single endpoint that routes pulls across multiple backing repos by priority:

```
Virtual repo (mirror endpoint)
  ├── Priority 1: golden-images (standard GAR repo with patched images)
  └── Priority 2: dockerhub-cache (pull-through remote repo for Docker Hub)
```

When a Dockerfile says `FROM golang:1.24-bookworm`:

1. Docker daemon asks the mirror (virtual repo) for `library/golang:1.24-bookworm`
2. Virtual repo checks golden-images first (priority 1) — if the tag exists there, it's served
3. If not, falls through to dockerhub-cache (priority 2) — pulls from Docker Hub, caches, and serves

This means:
- **No Dockerfile changes** — `FROM golang:1.24-bookworm` resolves to the golden image silently
- **No workflow changes** — the mirror is configured at the Docker daemon level
- **Graceful fallback** — images without a golden version fall through to Docker Hub as normal

### How the mirror is configured

The `--registry-mirror` flag is a **Docker daemon (`dockerd`) flag**, set on the DinD sidecar's startup args in Kubernetes:

```yaml
# In the AutoscalingRunnerSet DinD sidecar spec
containers:
  - name: dind
    args:
      - dockerd
      - --registry-mirror=https://<region>-docker.pkg.dev/<project>/<virtual-repo>
```

### Gotcha: `library/` prefix

Docker's mirror protocol prepends `library/` to official images. `FROM golang:1.24-bookworm` becomes a request for `library/golang:1.24-bookworm` at the mirror. Golden images must be pushed under `library/golang` (not just `golang`) in the GAR standard repo, or they won't be found.

### Digest-pinned images bypass the mirror

- **Tag-based** (`FROM golang:1.24-bookworm`) → resolved by priority, golden image wins
- **Digest-pinned** (`FROM golang@sha256:abc...`) → content-addressed, resolves to the exact image matching that hash regardless of priority. Since golden images have different content (and therefore different digests), a pinned Dockerfile will never accidentally get the golden image

This is safe — teams that pin digests made an explicit choice and won't be surprised by a different image.

### Observability from golden images

Golden images set a URL-scoped user-agent with a `proactive` tag. In GitHub's HTTP logs, you can distinguish:

- `git/2.39.5` — stock Bookworm image (not golden, still generating 401s)
- `git/2.39.5 proactive` — golden image (proactiveAuth enabled, no 401s)

This tells you exactly how much of your traffic has been migrated.

## Squid CONNECT Proxy (No TLS Termination)

A lighter alternative to mitmproxy when you only need domain-level visibility (which hosts, how many bytes) without seeing full URLs or response codes.

### How it works

Squid in CONNECT mode tunnels encrypted connections without terminating TLS. You see destination host:port and byte counts, but not request paths, headers, or bodies. No custom CA needed, no trust store injection.

### Deployment on K8s CI runners

1. **Squid DaemonSet** — one pod per node in the runner namespace, port 3128
2. **DinD daemon config** — patch the sidecar's `daemon.json` to route Docker traffic through it:

```json
{
  "proxies": {
    "http-proxy": "http://squid:3128",
    "https-proxy": "http://squid:3128",
    "no-proxy": "localhost,127.0.0.1,.svc.cluster.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
  }
}
```

3. **Runner env vars** — set `http_proxy`/`https_proxy`/`no_proxy` on runner containers for non-Docker traffic (git, curl)
4. **Git caveat** — set `GIT_HTTP_VERSION=HTTP/1.1` because HTTP/2 multiplexing doesn't work through CONNECT proxies

### Enriching logs with K8s pod metadata

Squid supports [external ACL helpers](http://www.squid-cache.org/Doc/config/external_acl_type/) — a subprocess that receives the client IP per request and returns metadata to embed in logs. Write a helper that queries the K8s API to resolve source pod IPs to pod names/annotations:

```
external_acl_type podmeta ttl=5 children-max=20 %SRC /opt/squid/podmeta-helper.pl
acl podmeta external podmeta

logformat connect_bytes {"ts":"%ts","client_ip":"%>a","authority":"%ru","bytes_up":"%>st","bytes_down":"%<st","podmeta":%'ea}
access_log stdio:/dev/stdout connect_bytes
```

This gives per-request logs tagged with runner identity — correlate back to workflows.

### When to use

Good for dev/lab when you want to validate registry mirror traffic patterns without the operational overhead of TLS termination. Unlike mitmproxy, it's safe to leave running longer-term since it never sees plaintext credentials.

## Docker Event Streaming

Stream Docker daemon lifecycle events to a metrics backend for real-time visibility into what containers and images are used during CI jobs.

### How it works

`docker events --format json` emits a JSON line for every container, image, network, and volume event. Run it as a background process, tag each event with CI context, and forward to a metrics backend via UDP.

```python
proc = subprocess.Popen(
    ["docker", "events", "--format", "{{json .}}"],
    stdout=subprocess.PIPE
)
for line in proc.stdout:
    event = json.loads(line)
    tags = [
        f"event_type:{event['Type']}",    # container, image, network, volume
        f"action:{event['Action']}",       # pull, create, start, stop, die, etc.
        f"workflow:{os.environ.get('GITHUB_WORKFLOW', '')}",
        f"repo:{os.environ.get('GITHUB_REPOSITORY', '')}",
        f"run_id:{os.environ.get('GITHUB_RUN_ID', '')}",
    ]
    send_statsd_counter("docker.events", tags)
```

### Deployment as a pre-job hook

Launch as a background process from a [runner pre-job hook](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/running-scripts-before-or-after-a-job). It starts when the job begins and naturally terminates when the runner pod dies at job end.

- **UDP** (StatsD/DogStatsD) — non-blocking, no performance impact on the job
- **Auto-discovery** — resolve the metrics agent host from the Kubernetes downward API or a known service DNS name

### What it answers

- Which images are pulled most frequently across the fleet?
- How many containers does an average job create?
- Which workflows are the heaviest Docker users?
- Are image pulls failing or timing out?

## See also

- [[notes/proxies-and-tls-termination]] — background on proxy types, TLS termination, Envoy, mitmproxy, Athens
- [[notes/git-proactiveauth]] — the proactiveAuth fix that eliminates the 401s these hacks help debug
