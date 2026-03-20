---
title: "Summary: ARC Kubernetes Mode - Lifecycle Hooks"
---

> **Full notes:** [[notes/Git/arc_lifecycle_hooks|ARC Kubernetes Mode - Lifecycle Hooks Deep Dive →]]

## Key Concepts

### What "Lifecycle Hooks" Means Here

These are NOT Kubernetes `postStart`/`preStop` hooks. They are a **GitHub Actions Runner feature** -- an internal plugin system called "container hooks." At specific points in a job's lifecycle, the runner agent calls Node.js scripts (`index.js`) baked into the runner image.

| Hook | When It Fires | What It Does |
|------|--------------|--------------|
| `prepareJob` | Before any step runs | Creates the job pod, tar+streams workspace TO it |
| `runScriptStep` | For each `run:` step | Execs the script inside a container in the job pod |
| `runContainerStep` | For each `uses: docker://` step | Runs a container step in the job pod |
| `cleanupJob` | After all steps | Tar+streams workspace BACK, deletes the job pod |

### API Access and Authentication

The **runner pod's** service account provides all K8s API access. The ServiceAccount (created by the Helm chart) has a Role with permissions to create/delete pods, create pods/exec, get pods/log, and manage secrets. The auto-mounted token at `/var/run/secrets/kubernetes.io/serviceaccount/token` authenticates calls. The hook scripts use the `@kubernetes/client-node` npm package (not the kubectl CLI) to talk to the K8s API programmatically.

### How Data Moves Between Pods (No Shared Volumes)

There is **no shared volume** -- two pods with `emptyDir` cannot see each other's data. Instead, data moves via tar-over-websocket through the K8s API:

**prepareJob (Runner --> Job Pod):** Runner creates the job pod via `POST /api/v1/pods`, waits for it to reach Running, then execs `tar xzf -` in the job pod and streams the workspace archive over the websocket stdin. The job pod extracts it into `_work/`.

**runScriptStep:** Runner execs each `run:` step inside the job pod via `POST /pods/{job-pod}/exec`, streams stdout/stderr back, and uploads logs to the GitHub API.

**cleanupJob (Job Pod --> Runner):** Runner execs `tar czf -` in the job pod, streams the workspace archive back to itself via websocket stdout, extracts locally, then deletes the job pod. After that, the runner uploads artifacts/cache to GitHub from its local `_work/`.

```
Runner Pod                        Job Pod
  |                                  |
  |-- prepareJob: create pod ------->|
  |-- tar czf - | tar xzf - ------->|  (workspace transfer)
  |                                  |
  |-- runScriptStep: exec ---------->|  (each run: step)
  |<--- stdout/stderr ---------------|
  |                                  |
  |<-- tar czf - | tar xzf - -------|  (workspace back)
  |-- cleanupJob: delete pod ------->X
```

### The Tar Pipe Explained

Conceptually equivalent to `kubectl exec runner-pod -- tar czf - -C /home/runner/_work . | kubectl exec -i job-pod -- tar xzf - -C /home/runner/_work`. The left side creates a gzip tar of `_work/` and streams it to stdout (`f -` means stdout). The pipe feeds stdout as stdin to the right side. The right side extracts from stdin (`f -` means stdin) into `_work/`. The `-i` flag on `kubectl exec` is critical -- without it, the tar stream cannot enter the pod. No intermediate file ever lands on disk; it is a pure streaming copy through the K8s API websocket.

### RBAC Permissions

The Helm chart creates a Role for the runner's ServiceAccount with minimal permissions:

| Resource | Verbs |
|----------|-------|
| `pods` | create, delete, get, list, watch |
| `pods/exec` | create |
| `pods/log` | get |
| `secrets` | create, delete, get |

### Where the Hook Code Lives

Inside the runner image at `/home/runner/k8s/`: `index.js` (entry point, `ACTIONS_RUNNER_CONTAINER_HOOKS` points here), `prepareJob.js`, `runScriptStep.js`, `runContainerStep.js`, `cleanupJob.js`, and `lifecycle-hooks/container-hook-template.yaml` (pod spec template). All baked into `ghcr.io/actions/actions-runner` -- nothing to build or provide yourself.

## Quick Reference

**Auth chain:** Runner pod ServiceAccount --> RBAC Role --> auto-mounted token --> `@kubernetes/client-node` npm package --> K8s API

**Data transfer:** tar gzip stream over K8s API websocket (no shared volumes, no intermediate files on disk)

**Hook code:** `/home/runner/k8s/index.js` (baked into official runner image)

## Key Takeaways

- The runner pod orchestrates everything -- it creates, execs into, and deletes the job pod
- Data transfer is tar-over-websocket through the K8s API, no shared volumes or intermediate files on disk
- RBAC permissions are minimal: create/delete pods, exec, get logs, manage secrets
- The hooks use `@kubernetes/client-node` npm package, not the kubectl CLI binary
- All hook scripts ship inside the official runner image -- nothing to build or provide yourself
- The `-i` flag on exec is critical for the tar stream to enter the receiving pod
