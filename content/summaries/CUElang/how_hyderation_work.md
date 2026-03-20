---
title: "Summary: CUE Language - Questions & Answers"
---

> **Full notes:** [[notes/CUElang/how_hyderation_work|CUE Language - Questions & Answers →]]

## Key Concepts

### Why `cue export ./path/...` fails but `cue export ./path/subdir/...` succeeds

The `...` glob makes CUE discover and evaluate every directory containing `.cue` files as a **separate, independent package instance** -- it does NOT merge parent directory files into children. If any single instance has non-concrete (incomplete) values, the entire command fails.

In a typical layered overlay structure, the root directory only defines `serviceID`, the environment level adds `environment`, and the cluster level adds `region`. Upper-level directories reference fields (like `Meta.data`, `Meta.clusterName`, `Meta.namespace`) that are only derived once all three levels are merged by the build tool. Evaluated in isolation, those references remain abstract, and `cue export` rejects them.

The cluster-level directory (e.g., `citadel-2g-dev-tokyo-01/`) succeeds because its `.cue` file contains only a fully concrete value (`Meta: region: "tokyo"`) with zero unresolved references. Scoping the `...` to that subtree avoids evaluating any incomplete parent directories.

| # | Directory level | Standalone export | Why |
|---|----------------|-------------------|-----|
| 1 | Root (`kouzoh-pubsub-pusher-jp/`) | FAILS | References `Meta.data`, `Meta.clusterName` etc. -- undefined at this level |
| 2 | Environment (`development/`) | FAILS | Still missing cluster-level fields |
| 3 | Cluster (`development/citadel-2g-dev-tokyo-01/`) | PASSES | Fully concrete `Meta: region: "tokyo"` |

> Files starting with `.` (like `.development.cue`) are ignored by CUE's package loader -- they are anchor/marker files, not evaluated.

### How imports work in CUE

CUE does **not** support relative imports (`./some/path`). All import paths must be fully qualified using the module name from `cue.mod/module.cue`. When the directory name differs from the `package` declaration inside the `.cue` files, you must append `:packagename` to the import path.

```
Import path formula:
"<module>/<path-to-dir>:<package-if-differs-from-dirname>"

Example:
"github.com/kouzoh/microservices-kubernetes/kit/.../citadel-2g-dev-tokyo-01:kubernetes"
                                                                             ^^^^^^^^^^
                                                     directory name ≠ package name, so :kubernetes required
```

### Self-imports are impossible

All `.cue` files in the same directory with the same `package` declaration are part of the **same package instance** -- they are unified automatically. A package cannot import itself; doing so creates a circular import. The importing file must live in a **different directory** with a different package name.

### Hidden / private identifiers

Identifiers starting with `_` (e.g., `_Labels`, `_Butler`, `_config`) are hidden: excluded from `cue export` output and inaccessible from outside the package. Similarly, files starting with `.` or `_` are ignored by the package loader entirely.

### `cue export` vs `cue eval`

| Behavior | `cue export` | `cue eval` |
|----------|-------------|-----------|
| Output format | JSON (default) or YAML | CUE syntax |
| Requires concrete values | **Yes** -- all values must be fully resolved | **No** -- can show incomplete/abstract values |
| Hidden fields (`_foo`) | Excluded | Excluded (unless `--all` flag) |
| Use case | Generating final config output | Debugging / inspecting partial evaluation |

Use `cue eval` to debug when `cue export` fails -- it shows which fields remain abstract.

## Quick Reference

```
Directory overlay merge (done by build tool, NOT by raw cue export):

  root/kubernetes.cue          ─┐
  root/dev/kubernetes.cue       ├──► merged single instance ──► cue export ✓
  root/dev/cluster/kubernetes.cue─┘

  root/kubernetes.cue   alone  ──► cue export ✗ (incomplete Meta fields)


Self-import (FAILS):
  dir/test.cue (package kubernetes) ──import──► dir/kubernetes.cue (package kubernetes)
  Same package instance ──► circular import error

Cross-directory import (WORKS):
  script/test/test.cue (package test) ──import──► dir/kubernetes.cue (package kubernetes)
  Different package instances ──► OK
```

## Key Takeaways

- The `...` glob makes CUE evaluate each directory independently -- it does not inherit or merge parent files into child directories.
- Upper-level directories fail `cue export` because they reference fields only fully defined when all layers are merged by the build tool.
- Scoping the command to the cluster-level subtree avoids evaluating incomplete parent directories.
- CUE has no relative imports; always use fully-qualified module paths and append `:pkg` when directory name differs from package name.
- A CUE package cannot import itself -- files in the same directory with the same package declaration are automatically unified.
- Hidden fields (`_foo`) are excluded from export; dot-files (`.foo.cue`) are ignored by the package loader.
- Use `cue eval` (not `cue export`) to debug incomplete values and inspect partially-resolved state.
