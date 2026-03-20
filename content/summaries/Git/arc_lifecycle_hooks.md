---
title: "Summary: ARC Kubernetes Mode - Lifecycle Hooks"
---

> **Full notes:** [[notes/Git/arc_lifecycle_hooks|ARC Kubernetes Mode - Lifecycle Hooks Deep Dive →]]

## Key Concepts

**ARC lifecycle hooks** are NOT Kubernetes `postStart`/`preStop` hooks. They are a GitHub Actions Runner feature -- Node.js scripts baked into the runner image that manage job pods via the Kubernetes API.

**The four hooks:**

| Hook | Purpose |
|------|---------|
| `prepareJob` | Create job pod, tar+stream workspace TO it |
| `runScriptStep` | Exec each `run:` step inside the job pod |
| `runContainerStep` | Run `uses: docker://` steps in the job pod |
| `cleanupJob` | Tar+stream workspace BACK, delete job pod |

**No shared volumes** between runner and job pods. Data moves via tar-over-websocket: the runner `tar`s the workspace, streams it into the job pod via `kubectl exec` (actually the K8s Node.js client), and reverses the process at cleanup.

## Quick Reference

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

**Auth chain:** Runner pod ServiceAccount --> RBAC Role (pods CRUD, pods/exec, pods/log, secrets) --> auto-mounted token --> K8s Node.js client

**Hook code location:** `/home/runner/k8s/index.js` (baked into `ghcr.io/actions/actions-runner`)

## Key Takeaways

- The runner pod orchestrates everything -- it creates, execs into, and deletes the job pod
- Data transfer is tar-over-websocket through the K8s API, no shared volumes or intermediate files on disk
- RBAC permissions are minimal: create/delete pods, exec, get logs, manage secrets
- The hooks use the `@kubernetes/client-node` npm package, not the kubectl CLI
- All hook scripts ship inside the official runner image -- nothing to build or provide yourself
