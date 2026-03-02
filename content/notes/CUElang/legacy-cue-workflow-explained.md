

# Legacy CUE Workflow & module.cue Explained

This document explains the structure and logic behind the `module.cue` file in older CUE workflows, specifically focusing on how CUE handles dependencies generated from Go code (`cue get go`).

### Q1: What is the purpose of the `module: "..."` line at the top?

**Answer:**
This defines the **Module Identity**.

```cue
module: "github.com/kouzoh/cue"

```

It establishes the namespace for your project. Any file you create inside this directory structure is importable relative to this path. For example, if you create a folder named `blueprints`, its import path becomes `github.com/kouzoh/cue/blueprints`.

### Q2: What is the `require` block for?

**Answer:**
The `require` block lists your direct dependencies and their specific versions.

```cue
require: {
  "github.com/DataDog/datadog-operator": "v0.8.4"
  "github.com/argoproj/argo-rollouts":   "v1.8.0"
  // ...
}

```

It ensures that everyone working on the project uses the exact same version of external libraries.

### Q3: Why are Go modules listed in `require` if there are no "Pure CUE" modules for them?

**Answer:**
Because CUE treats the **Go source code** as the "Raw Ingredients."

In this legacy workflow, projects like `datadog-operator` do not publish CUE files; they only publish Go code. To use them in CUE, your local CUE tool must **generate** definitions from their Go structs.

1. **The Shopping List:** The `require` block tells CUE exactly which version of the Go source code to download from the internet (e.g., `v0.8.4`).
2. **The Generation:** The `cue get go` command uses this downloaded source code to generate the CUE files found in your `cue.mod/gen/` folder.

Without the `require` block, CUE wouldn't know which version of the Go source code to fetch, and therefore couldn't generate the definitions.

### Q4: What does the `@indirect()` attribute mean?

**Answer:**
This indicates a **transitive dependency**.

```cue
"github.com/DataDog/extendeddaemonset": "v0.5.1..." @indirect()

```

You don't import this module directly in your code, but one of your direct dependencies (like `datadog-operator`) needs it to work. CUE tracks it here to ensure the entire dependency tree is locked and reproducible.

### Q5: What is the large `replace` block at the bottom?

**Answer:**
This block is the **"Glue"** that maps import paths to the actual generated code.

```cue
replace: {
  "k8s.io/api/apps/v1": "k8s.io/api" @import("go")
}

```

When you run `cue get go`, CUE generates a massive monolithic module (e.g., `k8s.io/api`) inside your `gen/` folder. However, in your code, you want to import specific sub-packages (e.g., `k8s.io/api/apps/v1`).

The `replace` block acts as a redirect map:

- **Left Side (The Ask):** `k8s.io/api/apps/v1` (The specific package you want).
- **Right Side (The Answer):** `k8s.io/api` (The actual module where the code lives).

**Analogy:**
It is like a robot looking for milk.

- You tell the robot: "Go to the **Milk Store**." (Importing `apps/v1`)
- The `replace` block tells the robot: "When you look for the **Milk Store**, go to the **Supermarket** (`k8s.io/api`) instead, because the milk is inside aisle 1."

### Q6: I see the generated files in `gen/k8s.io/api/apps/v1`. Why can't I map the import directly to itself?

**Example of failure:**

```cue
replace: {
  "k8s.io/api/apps/v1": "k8s.io/api/apps/v1" @import("go") // THIS FAILS
}

```

**Answer:**
This fails due to a **Module Identity Mismatch**.

1. **The Expectation:** When you put `k8s.io/api/apps/v1` on the right side of the `replace` block, you are telling CUE to look for a module that officially identifies itself as `module: "k8s.io/api/apps/v1"`.
2. **The Reality:** The generated code in that folder was born from the `k8s.io/api` Go module. Therefore, its internal ID card says `module: "k8s.io/api"`.
3. **The Crash:** CUE finds the files but rejects them because the name on the ID card (`k8s.io/api`) does not match the name you requested (`k8s.io/api/apps/v1`).

You must always map the **Package** (Content) to the **Module** (Container).

### Q7: What does `@import("go")` do?

**Answer:**
It tells CUE that the target module was created by converting Go code. This hints to the compiler that it should expect a folder structure that mirrors Go packages (e.g., `pkg/apis/...`) rather than a standard CUE module layout.
