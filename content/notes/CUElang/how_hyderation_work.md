---
title: CUE Language: Questions & Answers
---

## Q1: Why does `cue export ./kit/microservices/kouzoh-pubsub-pusher-jp/...` fail but `cue export ./kit/microservices/kouzoh-pubsub-pusher-jp/development/citadel-2g-dev-tokyo-01/...` succeed?

### How `cue export` with `...` works

The `...` glob pattern tells CUE to find and evaluate **every directory** containing `.cue` files as a **separate, independent package instance**. It does NOT merge parent directory files into child directories. Each directory is evaluated completely on its own.

### What CUE evaluates

When you run `cue export ./kit/microservices/kouzoh-pubsub-pusher-jp/...`, CUE discovers and independently evaluates these 5 package instances:

| # | Directory | Files | Outcome |
|---|-----------|-------|---------|
| 1 | `kouzoh-pubsub-pusher-jp/` | `kubernetes.cue`, `butler.cue`, `rbac.cue` | **FAILS** — incomplete values |
| 2 | `kouzoh-pubsub-pusher-jp/development/` | `cdconfiguration.cue`, `echo.cue`, `hpaconfig.cue`, `kubernetes.cue` | **FAILS** — incomplete values |
| 3 | `kouzoh-pubsub-pusher-jp/development/citadel-2g-dev-tokyo-01/` | `kubernetes.cue` | **PASSES** |
| 4 | `kouzoh-pubsub-pusher-jp/production/` | `cdconfiguration.cue`, `hpaconfig.cue`, `kubernetes.cue` | **FAILS** — incomplete values |
| 5 | `kouzoh-pubsub-pusher-jp/production/citadel-2g-prod-tokyo-01/` | `kubernetes.cue` | **PASSES** |

If **any single instance** fails, the entire `cue export` command fails.

> Note: Files starting with `.` (like `.development.cue`, `.production.cue`) are ignored by CUE by default. These are just anchor/marker files with comments and no package declaration.

### Why the upper-level directories are incomplete

The directory structure is designed as a **layered overlay** — each level adds more concrete values to the `Meta` struct:

- **Root** sets only `Meta.serviceID`:
  ```cue
  // kouzoh-pubsub-pusher-jp/kubernetes.cue
  Meta: {
      serviceID: "kouzoh-pubsub-pusher-jp"
  }
  ```

- **Environment** adds `Meta.environment`:
  ```cue
  // development/kubernetes.cue
  Meta: environment: "development"
  ```

- **Cluster** adds `Meta.region`:
  ```cue
  // development/citadel-2g-dev-tokyo-01/kubernetes.cue
  Meta: region: "tokyo"
  ```

However, the root and environment files **reference** fields that aren't defined at their level:

- `Meta.data` — used in `kubernetes.cue`, `rbac.cue` for metadata on all resources
- `Meta.clusterName` — used in `kubernetes.cue` for env vars like `CLUSTER_NAME`
- `Meta.env` — used in `kubernetes.cue` for GCP service account email construction
- `Meta.namespace` — used in `rbac.cue` for RoleBinding subjects

These fields are derived from the combination of `serviceID` + `environment` + `region` by the kit schema (`kit.#Application`). When a directory is evaluated standalone, those references remain **abstract/non-concrete**. `cue export` requires all values to be fully concrete JSON — it cannot export incomplete values, so it errors out.

### Why the cluster directory succeeds

`development/citadel-2g-dev-tokyo-01/kubernetes.cue` contains only:

```cue
package kubernetes

Meta: region: "tokyo"
```

This is a fully concrete, self-contained value with zero references to anything undefined. It exports cleanly to `{"Meta": {"region": "tokyo"}}`.

### Why the scoped command succeeds

`cue export ./kit/microservices/kouzoh-pubsub-pusher-jp/development/citadel-2g-dev-tokyo-01/...` only scans the `citadel-2g-dev-tokyo-01/` subtree. There's only one directory with `.cue` files there (itself), and its values are fully concrete. No incomplete parent directories are evaluated.

### The intended usage

This overlay structure is designed to be consumed by a build tool (the kouzoh/cue kit toolchain) that **merges all three levels** (root + environment + cluster) into a single instance before evaluating. Running raw `cue export` at the root with `...` evaluates each level in isolation, which was never the intended use.

---

## Q2: How do imports work in CUE? Why can't I use relative paths like `./path/to/package`?

### CUE uses module-qualified import paths

CUE does **not** support relative imports (e.g., `./some/path`). All import paths must be fully qualified using the module name defined in `cue.mod/module.cue`.

For this repository, the module is:

```cue
// cue.mod/module.cue
module: "github.com/kouzoh/microservices-kubernetes"
```

So to import a package at `kit/microservices/kouzoh-pubsub-pusher-jp/development/citadel-2g-dev-tokyo-01/`, the import path is:

```
"github.com/kouzoh/microservices-kubernetes/kit/microservices/kouzoh-pubsub-pusher-jp/development/citadel-2g-dev-tokyo-01"
```

### The `:package` qualifier

When the **directory name** does not match the **package name** declared inside the `.cue` files, you must append `:packagename` to the import path.

In this case:
- Directory name: `citadel-2g-dev-tokyo-01`
- Package declaration inside files: `package kubernetes`

These don't match, so you must write:

```
"github.com/kouzoh/microservices-kubernetes/kit/microservices/kouzoh-pubsub-pusher-jp/development/citadel-2g-dev-tokyo-01:kubernetes"
```

### Wrong vs. correct import

**Wrong** (relative path, no package qualifier):
```cue
import (
    test "./kit/microservices/kouzoh-pubsub-pusher-jp/development/citadel-2g-dev-tokyo-01/kubernetes"
)
```

**Correct** (full module path, with `:kubernetes` qualifier):
```cue
import (
    test "github.com/kouzoh/microservices-kubernetes/kit/microservices/kouzoh-pubsub-pusher-jp/development/citadel-2g-dev-tokyo-01:kubernetes"
)
```

---

## Q3: Can a CUE file import the package from its own directory?

**No.** A CUE package cannot import itself.

In CUE, all `.cue` files in the **same directory** with the **same `package` declaration** are part of the **same package instance**. They are unified together automatically — there is no concept of one file importing another file within the same package.

### Example of the problem

If you have this file inside `citadel-2g-dev-tokyo-01/`:

```cue
// citadel-2g-dev-tokyo-01/test.cue
package kubernetes

import (
    test "github.com/kouzoh/microservices-kubernetes/kit/microservices/kouzoh-pubsub-pusher-jp/development/citadel-2g-dev-tokyo-01:kubernetes"
)

result: test.Meta
```

This fails because:
1. `test.cue` declares `package kubernetes`
2. `kubernetes.cue` in the same directory also declares `package kubernetes`
3. They are part of the **same** package instance
4. The import tries to import that same instance — a circular/self-import

### Solution

The importing file must be in a **different directory**. For example:

```
script/kit/test/test.cue        <-- importing package (package test)
kit/microservices/.../citadel-2g-dev-tokyo-01/kubernetes.cue  <-- imported package (package kubernetes)
```

```cue
// script/kit/test/test.cue
package test

import (
    k "github.com/kouzoh/microservices-kubernetes/kit/microservices/kouzoh-pubsub-pusher-jp/development/citadel-2g-dev-tokyo-01:kubernetes"
)

result: k.Meta
```

Then run:
```sh
cue export ./script/kit/test/
```

Output:
```json
{"result": {"region": "tokyo"}}
```

---

## Q4: What are hidden/private identifiers in CUE?

Identifiers starting with `_` (underscore) are **hidden** (private) in CUE. They are not included in `cue export` output and are not accessible from outside the package.

Examples from this codebase:

```cue
_Labels: { ... }    // hidden, not exported
_Butler: { ... }    // hidden, not exported
_config: { ... }    // hidden, not exported
```

Similarly, files starting with `.` or `_` are ignored by CUE's package loader:

```
.development.cue    // ignored by CUE
.production.cue     // ignored by CUE
```

---

## Q5: How does `cue export` differ from `cue eval`?

| Behavior | `cue export` | `cue eval` |
|----------|-------------|-----------|
| Output format | JSON (default) or YAML | CUE syntax |
| Requires concrete values | **Yes** — all values must be fully resolved | **No** — can show incomplete/abstract values |
| Hidden fields (`_foo`) | Excluded | Excluded (unless `--all` flag) |
| Use case | Generating final config output | Debugging/inspecting CUE evaluation |

If `cue export` fails due to incomplete values, you can use `cue eval` to inspect what the partially-resolved state looks like and identify which fields remain abstract.
