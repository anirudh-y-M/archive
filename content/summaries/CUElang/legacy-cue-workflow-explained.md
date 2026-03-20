---
title: "Summary: Legacy CUE Workflow & module.cue Explained"
---

> **Full notes:** [[notes/CUElang/legacy-cue-workflow-explained|Legacy CUE Workflow & module.cue Explained →]]

## Key Concepts

**`module` declaration** -- sets the project's namespace. Everything in the repo is importable relative to this path (e.g., `github.com/kouzoh/cue/blueprints`).

**`require` block** -- pins direct dependencies to exact versions, like a lock file. In this legacy workflow, the dependencies are Go modules (not pure CUE modules) because the upstream projects only publish Go code.

**`cue get go`** -- generates CUE definitions from Go structs. The `require` block tells CUE which Go source version to download; the command then produces `.cue` files in `cue.mod/gen/`.

**`@indirect()` attribute** -- marks transitive dependencies. You don't import these directly, but one of your direct dependencies needs them.

**`replace` block** -- maps specific import sub-paths to their parent module. Needed because `cue get go` generates a monolithic module (e.g., `k8s.io/api`), but you import sub-packages (e.g., `k8s.io/api/apps/v1`).

**`@import("go")` attribute** -- tells CUE the target module was generated from Go code, so expect a Go-style folder layout.

## Quick Reference

```
module.cue structure:
┌───────────────────────────────────────────────┐
│  module: "github.com/kouzoh/cue"              │  ← project identity
│                                               │
│  require: {                                   │
│    "k8s.io/api": "v0.26.0"                    │  ← Go dep versions
│    "some/transitive": "v1.0" @indirect()      │  ← transitive dep
│  }                                            │
│                                               │
│  replace: {                                   │
│    "k8s.io/api/apps/v1": "k8s.io/api"         │  ← sub-path → module
│        @import("go")                          │     redirect
│  }                                            │
└───────────────────────────────────────────────┘
```

**Why self-mapping fails:** `replace: { "k8s.io/api/apps/v1": "k8s.io/api/apps/v1" }` causes a module identity mismatch -- the generated code's internal ID is `k8s.io/api`, not the sub-path.

## Key Takeaways

- In the legacy workflow, CUE generates definitions from Go source via `cue get go` because no pure CUE modules exist for those projects.
- The `replace` block is essential glue: it redirects sub-package imports to the correct parent module in `gen/`.
- Never map a sub-path to itself in `replace` -- it fails due to module identity mismatch.
- `@indirect()` deps are transitive; they exist for reproducibility of the full dependency tree.
- `@import("go")` signals Go-style package layout to the CUE compiler.
