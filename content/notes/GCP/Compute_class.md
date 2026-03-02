## GKE Compute Classes: Detailed Explanation

### What Are Compute Classes?

GKE Compute Classes are a Kubernetes Custom Resource (CRD) that define sets of node attributes and autoscaling settings. They provide a declarative way to configure infrastructure options for workloads, allowing GKE cluster autoscaling to create nodes with specific characteristics based on workload requirements.

A ComputeClass is essentially a Kubernetes API object that specifies:
- **Priority-based node pool selection**: Define multiple node pools in order of preference
- **Fallback behavior**: When preferred resources are unavailable, GKE falls back to the next priority
- **Active migration**: Automatically migrate workloads to higher-priority nodes when they become available

### How Compute Classes Work

When a Pod selects a ComputeClass (via `nodeSelector` with `cloud.google.com/compute-class`), GKE:
1. Looks at the ComputeClass's priority list
2. Attempts to schedule the Pod on the highest-priority node pool
3. Falls back to lower-priority pools if the preferred ones are unavailable
4. With `activeMigration.optimizeRulePriority: true`, GKE will eventually migrate Pods to higher-priority nodes when they become available

---

## Implementation in Your citadel-dev Cluster

Your cluster `citadel-2g-dev-tokyo-01` has **three custom ComputeClasses** defined:

### 1. `citadel-default-cc` (Default/Shared Workloads)

**ComputeClass Definition** (<ref_snippet file="/home/ubuntu/repos/microservices-kubernetes/manifests/microservices-platform/mercari-citadel-jp/development/citadel-2g-dev-tokyo-01/ComputeClass/citadel-default-cc.yaml" lines="1-14" />):

```yaml
apiVersion: cloud.google.com/v1
kind: ComputeClass
metadata:
  name: citadel-default-cc
spec:
  activeMigration:
    optimizeRulePriority: true
  priorities:
    - nodepools: ["s-t2d-32-cc-01-v1", "s-t2d-32-cc-01-cidr2-v1"]  # t2d spot (cheapest)
    - nodepools: ["s-t2d-32-ondemand-cc-01-v1"]                     # t2d on-demand (fallback)
    - nodepools: ["s-n2d-32-cc-01-v1"]                              # n2d spot (last resort)
```

**Associated Node Pools** (from <ref_snippet file="/home/ubuntu/repos/microservices-terraform/terraform/microservices-platform/development/cluster-citadel-2g/regions/tokyo/cluster/terragrunt.hcl" lines="564-608" />):

| Node Pool | Machine Type | Availability | Max Nodes |
|-----------|--------------|--------------|-----------|
| s-t2d-32-cc-01-v1 | t2d-standard-32 | Spot | 200 |
| s-t2d-32-cc-01-cidr2-v1 | t2d-standard-32 | Spot | 200 |
| s-t2d-32-ondemand-cc-01-v1 | t2d-standard-32 | On-demand | 200 |
| s-n2d-32-cc-01-v1 | n2d-standard-32 | Spot | 200 |

Each node pool has:
- **Label**: `cloud.google.com/compute-class: citadel-default-cc`
- **Taint**: `cloud.google.com/compute-class=citadel-default-cc:NoSchedule`

---

### 2. `citadel-mercari-api-cc` (Mercari API Workloads)

**ComputeClass Definition** (<ref_snippet file="/home/ubuntu/repos/microservices-kubernetes/manifests/microservices-platform/mercari-citadel-jp/development/citadel-2g-dev-tokyo-01/ComputeClass/citadel-mercari-api-cc.yaml" lines="1-14" />):

```yaml
apiVersion: cloud.google.com/v1
kind: ComputeClass
metadata:
  name: citadel-mercari-api-cc
spec:
  activeMigration:
    optimizeRulePriority: true
  priorities:
    - nodepools: ["d-mercari-api-t2d-16-cc-02", "d-mercari-api-t2d-16-cc-02-cidr2"]  # t2d-16 spot
    - nodepools: ["d-mercari-api-t2d-32-ondemand-cc-01"]                              # t2d-32 on-demand
    - nodepools: ["d-mercari-api-n2d-32-cc-01"]                                       # n2d-32 spot
```

**Associated Node Pools** (from <ref_snippet file="/home/ubuntu/repos/microservices-terraform/terraform/microservices-platform/development/cluster-citadel-2g/regions/tokyo/cluster/terragrunt.hcl" lines="1751-1979" />):

| Node Pool | Machine Type | Availability | Max Nodes | Special Features |
|-----------|--------------|--------------|-----------|------------------|
| d-mercari-api-t2d-16-cc-02 | t2d-standard-16 | Spot | 51 | DB access tags |
| d-mercari-api-t2d-16-cc-02-cidr2 | t2d-standard-16 | Spot | 51 | Secondary CIDR |
| d-mercari-api-t2d-32-ondemand-cc-01 | t2d-standard-32 | On-demand | 51 | DB access tags |
| d-mercari-api-n2d-32-cc-01 | n2d-standard-32 | Spot | 51 | DB access tags |

These dedicated node pools have additional taints for `node-pool-id=d-mercari-api` and `machine-series=t2d`.

---

### 3. `citadel-mercari-eaas-cc` (Elasticsearch-as-a-Service Workloads)

**ComputeClass Definition** (<ref_snippet file="/home/ubuntu/repos/microservices-kubernetes/manifests/microservices-platform/mercari-citadel-jp/development/citadel-2g-dev-tokyo-01/ComputeClass/citadel-mercari-eaas-cc.yaml" lines="1-14" />):

```yaml
apiVersion: cloud.google.com/v1
kind: ComputeClass
metadata:
  name: citadel-mercari-eaas-cc
spec:
  activeMigration:
    optimizeRulePriority: true
  priorities:
    - nodepools: ["d-mercari-eaas-t2d-32-cc-01"]           # t2d-32 spot
    - nodepools: ["d-mercari-eaas-t2d-32-ondemand-cc-01"]  # t2d-32 on-demand
    - nodepools: ["d-mercari-eaas-n2d-32-cc-01"]           # n2d-64 spot
```

**Associated Node Pools** (from <ref_snippet file="/home/ubuntu/repos/microservices-terraform/terraform/microservices-platform/development/cluster-citadel-2g/regions/tokyo/cluster/terragrunt.hcl" lines="1981-2116" />):

| Node Pool | Machine Type | Availability | Max Nodes | Zones |
|-----------|--------------|--------------|-----------|-------|
| d-mercari-eaas-t2d-32-cc-01 | t2d-standard-32 | Spot | 100 | Multi-zone (a,b,c) |
| d-mercari-eaas-t2d-32-ondemand-cc-01 | t2d-standard-32 | On-demand | 50 | Multi-zone (a,b,c) |
| d-mercari-eaas-n2d-32-cc-01 | n2d-standard-64 | Spot | 50 | Multi-zone (a,b,c) |

---

## How Workloads Use Compute Classes

### Method 1: Explicit Node Selector

Workloads can explicitly select a compute class in their Pod spec:

```yaml
spec:
  nodeSelector:
    cloud.google.com/compute-class: citadel-mercari-eaas-cc
  tolerations:
    - key: "cloud.google.com/compute-class"
      operator: "Equal"
      value: "citadel-mercari-eaas-cc"
      effect: "NoSchedule"
```

**Example**: Elasticsearch workloads (<ref_snippet file="/home/ubuntu/repos/microservices-kubernetes/.hydrated/microservices/mercari-eaas-jp/development/citadel-2g-dev-tokyo-01/elasticsearch-product-search/manifest.yaml" lines="594-602" />)

---

### Method 2: Automatic Assignment via KubeMod

Your cluster uses **KubeMod ModRules** to automatically inject compute class selectors and tolerations into Pods that don't explicitly specify them. This is a key part of the implementation.

**ModRules for `citadel-default-cc`** (<ref_file file="/home/ubuntu/repos/microservices-kubernetes/manifests/microservices-platform/kubemod-system/development/citadel-2g-dev-tokyo-01/ModRule" />):

| ModRule | Condition | Action |
|---------|-----------|--------|
| `citadel-default-cc-no-affinity` | Pod has no affinity AND no nodeSelector | Add `citadel-default-cc` selector + toleration |
| `citadel-default-cc-no-node-affinity` | Pod has affinity but no nodeAffinity AND no nodeSelector | Add `citadel-default-cc` selector + toleration |
| `citadel-default-cc-no-required-node-affinity` | Pod has nodeAffinity but no required rules AND no nodeSelector | Add `citadel-default-cc` selector + toleration |
| `citadel-default-cc-has-required-butler-affinity` | Pod has only availability affinity (spot/ondemand) | Add `citadel-default-cc` selector + toleration |

**ModRules for `citadel-mercari-api-cc`**:

| ModRule | Condition | Action |
|---------|-----------|--------|
| `citadel-mercari-api-cc-has-nodeaffinity` | Pod has nodeAffinity for `d-mercari-api` | Add `citadel-mercari-api-cc` selector + toleration |
| `citadel-mercari-api-cc-has-nodeselector` | Pod has nodeSelector for `d-mercari-api` | Add `citadel-mercari-api-cc` selector + toleration |

---

## Cost Optimization Strategy

The compute class priority system implements a **cost optimization strategy**:

1. **First Priority (Cheapest)**: Spot VMs with T2D machine series
2. **Second Priority (Fallback)**: On-demand VMs (for when Spot is unavailable)
3. **Third Priority (Last Resort)**: N2D machine series (different availability pool)

With `activeMigration.optimizeRulePriority: true`, when Spot VMs become available again, GKE will automatically migrate workloads back to the cheaper option.

---

## Architecture Summary

```
                    ┌─────────────────────────────────────────────────────────────┐
                    │                    citadel-2g-dev-tokyo-01                  │
                    └─────────────────────────────────────────────────────────────┘
                                                │
           ┌────────────────────────────────────┼────────────────────────────────────┐
           │                                    │                                    │
           ▼                                    ▼                                    ▼
┌─────────────────────┐            ┌─────────────────────┐            ┌─────────────────────┐
│  citadel-default-cc │            │citadel-mercari-api-cc│           │citadel-mercari-eaas-cc│
│   (Shared Pools)    │            │  (Dedicated API)    │            │   (Elasticsearch)   │
└─────────────────────┘            └─────────────────────┘            └─────────────────────┘
         │                                    │                                    │
         ▼                                    ▼                                    ▼
┌─────────────────────┐            ┌─────────────────────┐            ┌─────────────────────┐
│ Priority 1: t2d Spot│            │ Priority 1: t2d-16  │            │ Priority 1: t2d-32  │
│ Priority 2: t2d OD  │            │ Priority 2: t2d-32  │            │ Priority 2: t2d-32  │
│ Priority 3: n2d Spot│            │ Priority 3: n2d-32  │            │ Priority 3: n2d-64  │
└─────────────────────┘            └─────────────────────┘            └─────────────────────┘
```

---

## Key Files Reference

| Component | Location |
|-----------|----------|
| Node Pool Definitions | <ref_file file="/home/ubuntu/repos/microservices-terraform/terraform/microservices-platform/development/cluster-citadel-2g/regions/tokyo/cluster/terragrunt.hcl" /> |
| ComputeClass CRDs | <ref_file file="/home/ubuntu/repos/microservices-kubernetes/manifests/microservices-platform/mercari-citadel-jp/development/citadel-2g-dev-tokyo-01/ComputeClass" /> |
| KubeMod ModRules | <ref_file file="/home/ubuntu/repos/microservices-kubernetes/manifests/microservices-platform/kubemod-system/development/citadel-2g-dev-tokyo-01/ModRule" /> |
| Elasticsearch Compute Class Config | <ref_snippet file="/home/ubuntu/repos/microservices-kubernetes/kit/pkg/elasticsearch/elasticsearch-spec.cue" lines="59-61" /> |

The microservices-ci repo does not contain any compute class specific configurations - the CI/CD pipelines apply the Terraform and Kubernetes manifests that contain the compute class definitions.
