---
title: "Summary: Legacy CUE Workflow & module.cue Explained"
---

> **Full notes:** [[notes/CUElang/legacy-cue-workflow-explained|Legacy CUE Workflow & module.cue Explained →]]

## Key Concepts

### Module identity (`module:`)

The `module: "github.com/kouzoh/cue"` line at the top of `module.cue` establishes the project's namespace. Every folder in the repo becomes importable relative to this path (e.g., a `blueprints/` folder is imported as `github.com/kouzoh/cue/blueprints`). This is the root identity for the entire CUE project.

### The `require` block -- pinning Go dependencies

The `require` block lists direct dependencies with exact versions, functioning like a lock file. In this legacy workflow, the listed dependencies are **Go modules** (not pure CUE modules) because upstream projects like `datadog-operator` only publish Go code, not CUE definitions.

The workflow is: `require` tells CUE which Go source version to download, then `cue get go` reads that Go source and generates `.cue` definitions into `cue.mod/gen/`. Without `require`, CUE wouldn't know which version of the Go source to fetch.

```
require block ──► cue get go downloads Go source at pinned version
                      │
                      ▼
              Generates .cue files in cue.mod/gen/
              (CUE definitions from Go structs)
```

### `@indirect()` -- transitive dependencies

Dependencies marked `@indirect()` are not imported directly in your code but are needed by one of your direct dependencies. CUE tracks them to ensure the entire dependency tree is locked and reproducible, similar to indirect entries in Go's `go.sum`.

### The `replace` block -- sub-path to module mapping

When `cue get go` generates code, it creates a single monolithic module (e.g., `k8s.io/api`) inside `gen/`. But your code imports specific sub-packages (e.g., `k8s.io/api/apps/v1`). The `replace` block acts as a redirect map:

- **Left side:** The sub-package path you want to import (`k8s.io/api/apps/v1`)
- **Right side:** The actual module where the generated code lives (`k8s.io/api`)

```
Your code imports:  k8s.io/api/apps/v1
                         │
replace block redirects  │
                         ▼
Actual module:      k8s.io/api  (contains gen/k8s.io/api/apps/v1/...)
```

### Why self-mapping fails in `replace`

Mapping a sub-path to itself (`"k8s.io/api/apps/v1": "k8s.io/api/apps/v1"`) fails because of a **module identity mismatch**. The generated code's internal identity is `module: "k8s.io/api"` (the parent module), not `k8s.io/api/apps/v1`. CUE finds the files but rejects them because the module identity on the right side doesn't match the actual identity declared in the generated code. You must always map the sub-package (content) to its parent module (container).

### `@import("go")` attribute

This attribute on a `replace` entry tells the CUE compiler that the target module was generated from Go code. The compiler then expects a Go-style folder structure (e.g., `pkg/apis/...`) rather than a standard CUE module layout.

## Quick Reference

```
module.cue structure:
┌──────────────────────────────────────────────────────┐
│  module: "github.com/kouzoh/cue"                     │  ← project identity / namespace
│                                                      │
│  require: {                                          │
│    "k8s.io/api": "v0.26.0"                           │  ← direct Go dep (pinned version)
│    "github.com/DataDog/extendeddaemonset": "v0.5.1"  │
│        @indirect()                                   │  ← transitive dep (not directly imported)
│  }                                                   │
│                                                      │
│  replace: {                                          │
│    "k8s.io/api/apps/v1": "k8s.io/api"                │  ← sub-path → parent module redirect
│        @import("go")                                 │     (Go-generated layout)
│  }                                                   │
└──────────────────────────────────────────────────────┘

Dependency flow:
  require (version pins)
      │
      ▼
  cue get go (downloads Go source, generates .cue)
      │
      ▼
  cue.mod/gen/ (generated CUE definitions)
      │
      ▼
  replace block (maps import sub-paths to actual modules in gen/)
      │
      ▼
  Your code: import "k8s.io/api/apps/v1" ──► resolves correctly
```

## Key Takeaways

- In the legacy workflow, CUE generates definitions from Go source via `cue get go` because no pure CUE modules exist for upstream projects.
- The `require` block pins the exact Go source versions to download; it's the "shopping list" for code generation.
- `@indirect()` marks transitive dependencies needed by your direct deps -- tracked for reproducibility.
- The `replace` block is essential glue: it redirects sub-package imports (e.g., `k8s.io/api/apps/v1`) to the correct parent module (e.g., `k8s.io/api`) in `gen/`.
- Never map a sub-path to itself in `replace` -- it fails because the generated code identifies as the parent module, not the sub-path.
- `@import("go")` signals Go-style package layout to the CUE compiler, affecting how it resolves folder structure.
