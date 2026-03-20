---
title: "Summary: CUE Language - Questions & Answers"
---

> **Full notes:** [[notes/CUElang/how_hyderation_work|CUE Language - Questions & Answers →]]

## Key Concepts

**`cue export` with `...` glob** evaluates every directory containing `.cue` files as an independent package instance. It does not merge parent files into child directories. If any single instance has incomplete (non-concrete) values, the entire command fails.

**Layered overlay pattern** -- the directory tree is designed so root sets `serviceID`, environment level adds `environment`, cluster level adds `region`. A build tool merges all layers together before evaluation. Running raw `cue export` at the root evaluates each layer in isolation, which breaks.

**Module-qualified imports** -- CUE has no relative imports. All import paths start with the module name from `cue.mod/module.cue`. When the directory name differs from the `package` declaration, append `:packagename`.

**No self-imports** -- all `.cue` files in the same directory with the same package declaration are automatically unified. A package cannot import itself.

**Hidden identifiers** -- names starting with `_` are private and excluded from `cue export` output. Files starting with `.` or `_` are ignored by the package loader.

## Quick Reference

| Command | Requires concrete values? | Output format |
|---------|--------------------------|---------------|
| `cue export` | Yes | JSON / YAML |
| `cue eval` | No | CUE syntax |

```
Directory overlay merge (done by build tool, NOT by raw cue export):

  root/kubernetes.cue          ─┐
  root/dev/kubernetes.cue       ├──► merged single instance ──► cue export ✓
  root/dev/cluster/kubernetes.cue─┘

  root/kubernetes.cue   alone  ──► cue export ✗ (incomplete Meta fields)
```

**Import path formula:**
```
"<module>/<path-to-dir>:<package-if-differs-from-dirname>"
```

## Key Takeaways

- The `...` glob makes CUE evaluate each directory independently -- it does not inherit parent files.
- Upper-level directories fail `cue export` because they reference fields only defined at deeper layers.
- Always use fully-qualified module paths for imports; append `:pkg` when directory name differs from the package name.
- Use `cue eval` (not `cue export`) to debug incomplete values.
- Hidden fields (`_foo`) and dot-files (`.foo.cue`) are invisible to export and the package loader respectively.
