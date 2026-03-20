---
title: "Summary: GKE Compute Classes"
---

> **Full notes:** [[notes/GCP/Compute_class|GKE Compute Classes - Detailed Explanation →]]

## Key Concepts

### What Are Compute Classes?

Compute Classes are a GKE Custom Resource (CRD) that define priority-ordered sets of node pools with autoscaling settings. A ComputeClass spec declares priority-based node pool selection, fallback behavior when preferred resources are unavailable, and active migration to automatically move workloads to higher-priority nodes when capacity returns. When a pod selects a ComputeClass via `nodeSelector` with `cloud.google.com/compute-class`, GKE walks the priority list top-to-bottom, scheduling on the highest-priority pool available and falling back as needed.

### Cluster Implementation (citadel-dev Example)

The `citadel-2g-dev-tokyo-01` cluster defines three custom ComputeClasses:

| ComputeClass | Workload Type | Priority 1 (Cheapest) | Priority 2 (Fallback) | Priority 3 (Last Resort) |
|---|---|---|---|---|
| `citadel-default-cc` | Shared | t2d-32 Spot (2 pools) | t2d-32 On-demand | n2d-32 Spot |
| `citadel-mercari-api-cc` | Mercari API | t2d-16 Spot (2 pools) | t2d-32 On-demand | n2d-32 Spot |
| `citadel-mercari-eaas-cc` | Elasticsearch | t2d-32 Spot | t2d-32 On-demand | n2d-64 Spot |

Each node pool carries a **label** (`cloud.google.com/compute-class: <name>`) and a **NoSchedule taint** matching the compute class name, ensuring only pods that tolerate the taint land on those nodes. The API and EaaS pools also carry additional taints like `node-pool-id` and `machine-series` for further isolation. All three classes set `activeMigration.optimizeRulePriority: true` to auto-migrate pods back to cheaper pools when spot capacity recovers.

### How Workloads Use Compute Classes

**Method 1 -- Explicit Node Selector:** Workloads set `nodeSelector: cloud.google.com/compute-class: <name>` and a matching `NoSchedule` toleration in their pod spec. Example: Elasticsearch workloads explicitly select `citadel-mercari-eaas-cc`.

**Method 2 -- Automatic Assignment via KubeMod:** KubeMod ModRules automatically inject compute class selectors and tolerations into pods that lack them. For `citadel-default-cc`, four ModRules cover cases: no affinity at all, affinity but no nodeAffinity, nodeAffinity but no required rules, and only availability-type affinity. For `citadel-mercari-api-cc`, two ModRules match pods with nodeAffinity or nodeSelector targeting `d-mercari-api`.

### Cost Optimization Strategy

The priority system encodes a cost ladder: Spot T2D VMs first (cheapest), On-demand T2D second (reliable fallback), Spot N2D third (different availability pool as a last resort). Active migration ensures workloads drift back to cheaper tiers automatically without manual intervention.

### Architecture

```
                    citadel-2g-dev-tokyo-01
                              |
         +--------------------+--------------------+
         |                    |                    |
  citadel-default-cc   citadel-mercari-api-cc  citadel-mercari-eaas-cc
   (Shared Pools)        (Dedicated API)        (Elasticsearch)
         |                    |                    |
  P1: t2d Spot         P1: t2d-16 Spot      P1: t2d-32 Spot
  P2: t2d On-demand    P2: t2d-32 OD        P2: t2d-32 OD
  P3: n2d Spot         P3: n2d-32 Spot      P3: n2d-64 Spot
```

## Quick Reference

| Component | Location |
|-----------|----------|
| Node Pool Definitions | `microservices-terraform/.../terragrunt.hcl` |
| ComputeClass CRDs | `microservices-kubernetes/.../ComputeClass/` |
| KubeMod ModRules | `microservices-kubernetes/.../ModRule/` |
| ES Compute Class Config | `kit/pkg/elasticsearch/elasticsearch-spec.cue` |

**Pod assignment flow:**

| Method | How |
|--------|-----|
| Explicit | `nodeSelector: cloud.google.com/compute-class: <name>` + matching toleration |
| Automatic | KubeMod ModRules inject selector/toleration for pods without affinity rules |

## Key Takeaways

- Compute Classes are a **cost optimization tool** -- they encode a preference order from cheapest to most reliable node pools
- Each node pool gets a **label** and a **NoSchedule taint** matching the compute class name, ensuring pods only land on intended pools
- Active migration means automatic cost savings without manual intervention when spot capacity fluctuates
- KubeMod handles the "default" case so teams don't need to add compute class config to every workload
- Dedicated pools (API, EaaS) carry extra taints for workload isolation beyond just the compute class
- The microservices-ci repo has no compute class configs -- CI/CD pipelines apply the Terraform and K8s manifests that contain the definitions
