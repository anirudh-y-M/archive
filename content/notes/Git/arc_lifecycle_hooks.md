---
title: ARC Kubernetes Mode — Lifecycle Hooks Deep Dive
---

## What "Lifecycle Hooks" Means Here

It is NOT Kubernetes lifecycle hooks (`postStart`/`preStop`). It is a **GitHub Actions Runner feature** — the runner agent has an internal plugin system called **"container hooks"**. At specific points in a job's lifecycle, the runner agent calls out to a **Node.js script** (`index.js`) that ships inside the runner image.

The hook points are:

| Hook | When it fires |
|---|---|
| `prepareJob` | Before any step runs — create the job pod, transfer workspace TO it |
| `runScriptStep` | For each `run:` step — exec the script inside a container in the job pod |
| `runContainerStep` | For each `uses: docker://` step — run a container step in the job pod |
| `cleanupJob` | After all steps — transfer workspace BACK, delete the job pod |

## Whose kubectl / API Access Is This?

The **runner pod's** service account. Here's the chain:

```
Runner Pod
├── has a ServiceAccount (created by the Helm chart)
├── ServiceAccount has a Role with permissions to:
│   - create/delete pods
│   - create/delete secrets
│   - exec into pods
│   - get pod logs
├── The k8s API token is auto-mounted at
│   /var/run/secrets/kubernetes.io/serviceaccount/token
└── The index.js hook script uses the @kubernetes/client-node
    npm package (NOT kubectl CLI) to talk to the k8s API
```

So it's not literally the `kubectl` binary — it's the **Kubernetes Node.js client** inside the hook script, authenticated via the runner pod's **service account token**. Same mechanism as kubectl, just programmatic.

## How Data Actually Moves Between Pods

There is **no shared volume**. Two pods with `emptyDir` can't see each other's data. So the hooks do this:

### Step 1: `prepareJob` — Runner to Job Pod

```
Runner Pod                          K8s API                         Job Pod
    |                                  |                               |
    |  1. POST /api/v1/pods            |                               |
    |  (create job pod from template)  |                               |
    |--------------------------------->|                               |
    |                                  |---- schedules & starts ------>|
    |                                  |                               |
    |  2. Wait for pod phase=Running   |                               |
    |--------------------------------->|                               |
    |                                  |                               |
    |  3. POST /api/v1/pods/{job-pod}/exec                             |
    |     command: ["tar", "xzf", "-", "-C", "/home/runner/_work"]     |
    |--------------------------------->|---- exec into job pod ------->|
    |                                  |                               |
    |  4. Stream tar archive via       |                               |
    |     websocket stdin              |                               |
    |     (runner reads its local      |                               |
    |      _work/, tars it in memory,  |                               |
    |      pipes into the exec stdin)  |                               |
    |--------------------------------->|------ tar extracts ---------> |
    |                                  |                               |
    |                                  |              _work/ now exists |
```

### Step 2: `runScriptStep` — Execute Steps

```
Runner Pod                          K8s API                         Job Pod
    |                                  |                               |
    |  POST /api/v1/pods/{job-pod}/exec                                |
    |  command: ["sh", "-c", "<step script>"]                          |
    |--------------------------------->|---- exec --------------------->|
    |                                  |                               |
    |  Stream stdout/stderr back       |                               |
    |<---------------------------------|<------------------------------|
    |                                  |                               |
    |  (runner agent captures this     |                               |
    |   and uploads to GitHub API)     |                               |
```

### Step 3: `cleanupJob` — Job Pod to Runner

```
Runner Pod                          K8s API                         Job Pod
    |                                  |                               |
    |  POST /api/v1/pods/{job-pod}/exec                                |
    |  command: ["tar", "czf", "-", "-C", "/home/runner/_work", "."]   |
    |--------------------------------->|---- exec into job pod ------->|
    |                                  |                               |
    |  Stream tar archive back via     |         tar creates archive   |
    |  websocket stdout                |              streams to stdout|
    |<---------------------------------|<------------------------------|
    |                                  |                               |
    |  (runner extracts to its own     |                               |
    |   local _work/ emptyDir)         |                               |
    |                                  |                               |
    |  DELETE /api/v1/pods/{job-pod}   |                               |
    |--------------------------------->|---- deletes ---------------->X
    |                                  |
    |  (runner uploads artifacts/      |
    |   cache to GitHub from its       |
    |   local _work/)                  |
```

## The Tar Pipe — How Pod-to-Pod Copy Works

Conceptually equivalent to:

```bash
kubectl exec runner-pod -- tar czf - -C /home/runner/_work . \
  | kubectl exec -i job-pod -- tar xzf - -C /home/runner/_work
```

### Left Side — The Sender (runner pod)

```
kubectl exec runner-pod -- tar czf - -C /home/runner/_work .
```

| Flag | Meaning |
|---|---|
| `c` | **c**reate an archive |
| `z` | compress with **gz**ip |
| `f -` | write the archive to **stdout** (not a file) — `-` means stdout |
| `-C /home/runner/_work` | **c**hange directory to `_work/` first |
| `.` | archive everything in current directory |

"Tar up everything in `_work/`, gzip it, and stream it to stdout."

### The Pipe `|`

Takes the **stdout** of the left command and feeds it as **stdin** to the right command. The tar archive bytes flow through this pipe.

### Right Side — The Receiver (job pod)

```
kubectl exec -i job-pod -- tar xzf - -C /home/runner/_work
```

| Flag | Meaning |
|---|---|
| `x` | e**x**tract an archive |
| `z` | decompress **gz**ip |
| `f -` | read the archive from **stdin** — `-` means stdin |
| `-C /home/runner/_work` | extract into this directory |
| `-i` | pass stdin through to the pod (critical — without it the tar stream can't enter) |

"Read a gzipped tar from stdin and extract it into `_work/`."

### Visual

```
runner-pod                          job-pod
+-------------+                    +-------------+
| _work/      |                    | _work/      |
|  +-- repo/  |  tar+gzip stream   |  (empty)    |
|  +-- tool/  | ==================>|             |
|  +-- ...    |  via k8s API       |             |
|             |  websocket         |             |
|  tar czf -  |--------------------| tar xzf -   |
|  (stdout)   |     pipe/stdin     |  (stdin)    |
+-------------+                    +-------------+

                 AFTER:
                                   +-------------+
                                   | _work/      |
                                   |  +-- repo/  |
                                   |  +-- tool/  |
                                   |  +-- ...    |
                                   +-------------+
```

It's essentially **copying a directory from one pod to another** without needing a shared volume — just streaming bytes through the Kubernetes API. No intermediate file ever lands on disk.

## The RBAC That Makes This Possible

The Helm chart creates this Role for the runner's ServiceAccount:

```yaml
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["create", "delete", "get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]       # needed for exec into job pod
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]          # needed to stream step logs
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create", "delete", "get"]  # for passing secrets to job pod
```

## Where the Hook Code Lives

Inside the runner image at:

```
/home/runner/k8s/
+-- index.js              <-- entry point, ACTIONS_RUNNER_CONTAINER_HOOKS points here
+-- prepareJob.js         <-- creates job pod, transfers workspace
+-- runScriptStep.js      <-- execs step scripts in job pod
+-- runContainerStep.js   <-- runs container action steps
+-- cleanupJob.js         <-- transfers workspace back, deletes job pod
+-- lifecycle-hooks/
    +-- container-hook-template.yaml  <-- pod spec template for job pods
```

This is all **baked into `ghcr.io/actions/actions-runner`** — you don't need to build or provide these files.
