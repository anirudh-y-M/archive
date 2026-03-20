---
title: "Summary: GKE Compute Classes"
---

> **Full notes:** [[notes/GCP/Compute_class|GKE Compute Classes - Detailed Explanation →]]

## Key Concepts

**Compute Classes** are a GKE CRD that define priority-ordered lists of node pools for workload scheduling. When a pod requests a compute class, GKE tries the highest-priority pool first and falls back down the list if resources are unavailable.

**Active Migration** (`optimizeRulePriority: true`) automatically moves pods back to higher-priority (cheaper) pools when capacity returns.

**KubeMod ModRules** automatically inject compute class selectors and tolerations into pods that don't explicitly specify one -- acts as a default assignment mechanism.

## Quick Reference

```
Pod requests compute class via nodeSelector
        |
        v
+---------------------------+
| ComputeClass CRD          |
|  priorities:               |
|   1. Spot VMs (cheapest)   |  <-- try first
|   2. On-demand VMs         |  <-- fallback
|   3. Different series Spot |  <-- last resort
+---------------------------+
        |
        v
  activeMigration moves pods
  back up when capacity returns
```

**How pods get assigned:**

| Method | How |
|--------|-----|
| Explicit | `nodeSelector: cloud.google.com/compute-class: <name>` + matching toleration |
| Automatic | KubeMod ModRules inject selector/toleration for pods without affinity rules |

**Cost strategy:** Spot T2D (cheapest) --> On-demand T2D --> Spot N2D (different availability pool)

## Key Takeaways

- Compute Classes are a **cost optimization tool** -- they encode a preference order from cheapest to most reliable node pools
- Each node pool gets a **label** and a **NoSchedule taint** matching the compute class name, ensuring pods only land on intended pools
- Active migration means you get automatic cost savings without manual intervention when spot capacity fluctuates
- KubeMod handles the "default" case so teams don't need to add compute class config to every workload
- The Services range is cluster-wide and immutable; only node and pod IPs can vary per pool
