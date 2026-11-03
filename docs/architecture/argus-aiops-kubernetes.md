# Argus AIOps Kubernetes integration

Status: local evidence provider, bounded Pack-side normalization, Core topology
rendering, per-resource provenance, deliberate incident certification, the
Core-owned cluster/namespace execution-target contract, the MCP Fabric editor
and a reusable in-cluster connector certification contract are implemented.
The AKS Workload Identity, EKS Pod Identity, GKE Workload Identity Federation
and OpenShift ServiceAccount/SCC adapters and certification contracts are
implemented.

## Decision

Argus does not embed the full kagent control plane. It integrates the standalone
Apache-2.0 `kagent-tools` server as one replaceable MCP provider.

This preserves the product boundary:

- Argus Core owns users, Agents, model/runtime profiles, credentials, MCP
  Bundles, policy, execution grants, audit and traces.
- Argus AIOps owns the incident workflow and evidence artifact schema.
- kagent-tools translates read-only MCP calls into Kubernetes API reads.
- Kubernetes remains the authoritative runtime state; Argus stores bounded
  query metadata and reviewed conclusions, not a second telemetry corpus.

The full kagent controller would duplicate Core responsibilities and is not a
dependency. A future adapter may consume kagent-produced evidence, but it must
still enter through the same Bundle and grant boundary.

## Local reference architecture

```text
Argus Console
    -> Argus AIOps pack (A2A workflow)
        -> Core-selected Fabric connection + namespace
            -> signed Core execution grant with immutable resource scope
            -> Argus Core Agent runtime
                -> argus-aiops-observe MCP Bundle
                    -> Prometheus / Loki / Jaeger / Argus Observe
                    -> aiops-kubernetes remote MCP connection
                        -> kagent-tools --read-only
                            -> namespaced Kubernetes ServiceAccount
                                -> argus-demo workloads
```

The reference cluster is a reproducible two-node Kind cluster:

- cluster: `argus-aiops`
- Kubernetes: `v1.34.8`
- API endpoint: loopback `127.0.0.1:56443`
- provider namespace: `argus-aiops-system`
- observed namespace: `argus-demo`
- host MCP endpoint: `http://127.0.0.1:18084/mcp`
- Core container endpoint: `http://host.docker.internal:18084/mcp`

Kubernetes 1.34 is intentional for the current Docker Desktop/WSL cgroup-v1
host. A move to cgroup v2 should precede a Kubernetes 1.35+ upgrade.

## Security invariants

These invariants are deployment requirements, not UI promises:

1. `kagent-tools` runs with only the `k8s` provider and `--read-only`.
2. Its ServiceAccount receives namespaced Roles only; an empty namespace list
   is forbidden because the chart would otherwise create cluster-scoped RBAC.
3. Secrets are excluded and mutation verbs are denied.
4. Core's remote MCP connection is assigned to `argus-aiops-observe`.
5. Its Bundle policy is `selected`, with seven exact prefixed tool names.
6. `k8s_generate_resource` is intentionally not exposed to AIOps Agents.
7. A catalog change cannot silently widen an existing Agent's tool set.
8. Signed execution grants still constrain every Pack-initiated Agent call.
9. The workflow must select a Kubernetes target published by a backend in one
   of the selected Bundles. Core signs the resolved backend, target, cluster
   and namespace into the execution grant.
10. Core rejects Kubernetes tool calls that request all namespaces, omit the
    signed namespace or name a different namespace before provider dispatch.
11. Raw pod logs and Kubernetes YAML remain provider-owned; persisted Pack
   evidence contains bounded metadata and reviewed summaries only.
12. Core may retain a bounded, redacted tool-span preview for auditability; the
    Pack artifact stores only normalized results plus trace/span identifiers.
13. A successful connector certification is time-bounded. Core owns the
    freshness policy and rejects new AIOps execution grants for missing,
    failed or stale target evidence. An expiring certification remains usable
    but is surfaced as an operator warning.
14. Write identities are physically separate from evidence identities. The
    local connector owns only the narrow namespaced RBAC needed for scale and
    Deployment revision restoration, then applies stricter runtime workload
    allowlists.
15. Write tools live in `argus-aiops-remediate`, which is not assigned to any
    Agent. A selected policy exposes exactly `resources_scale` and
    `deployment_revision_rollback`.
16. Core requires a trusted remote catalog and an explicit
    `remediation_source_bundles` link to the incident's evidence Bundle.

## Certification lifecycle

Imported connector reports are immutable history records. Core derives their
current lifecycle from `generated_at` instead of rewriting evidence:

| State | Default age | Workflow start |
| --- | --- | --- |
| fresh | less than 120 hours | allowed |
| expiring | 120 to less than 168 hours | allowed with warning |
| stale | 168 hours or older | blocked |

The policy is configured on Argus Core with
`KUBERNETES_CERTIFICATION_WARNING_AGE_HOURS`,
`KUBERNETES_CERTIFICATION_MAX_AGE_HOURS` and
`KUBERNETES_CERTIFICATION_ENFORCE_AIOPS`. The Console shows the latest state,
expiry time and the last ten reports for each governed target. A2A preflight
returns Core-owned target-readiness evidence, while grant issuance repeats the
check server-side so a Pack cannot bypass it.

Re-certification remains an external operator or cluster automation concern.
The implemented `argus-kubernetes-certifier` CronJob runs the connector
contract every six hours and imports the normalized report through
`POST /api/certifications/kubernetes`. That endpoint accepts only an API key
whose allowlist explicitly contains
`system.kubernetes-certification.import`; an unscoped default-allow key is
rejected. Core therefore does not need long-lived cluster credentials merely
to schedule a check. Collection failures become bounded failed reports so the
Console history and Kubernetes Job status expose the same failure.

The bootstrap certifies the following authorization matrix:

| Request | Expected |
| --- | --- |
| get pods in `argus-demo` | allow |
| delete pods in `argus-demo` | deny |
| get secrets in `argus-demo` | deny |
| get pods in `kube-system` | deny |

## Evidence mapping in Argus AIOps

Kubernetes calls must be classified by their operational meaning instead of
placing every call in one generic runtime lane:

| Tool family | Evidence lane | Typical correlation key |
| --- | --- | --- |
| get resources, describe, resource YAML | topology | namespace + workload/service |
| get events, cluster configuration | runtime | namespace + involved object |
| get pod logs | logs | namespace + pod/container |

The researcher should first resolve Deployments, Services and Pods for the
incident service, then inspect recent Events, and only then fetch bounded logs
from matching Pods. It must not enumerate unrelated namespaces.

The Pack evidence artifact should add normalized Kubernetes evidence rather
than persisting raw command output:

```ts
type KubernetesEvidence = {
  namespace: string;
  resources: Array<{
    kind: 'Deployment' | 'Service' | 'Pod';
    name: string;
    status: string;
    owner?: string;
    labels: Record<string, string>;
    provenance: {
      toolName: string;
      toolCallId?: string;
      traceId?: string;
      spanId?: string;
    };
  }>;
  edges: Array<{
    from: string;
    to: string;
    relation: 'selects' | 'owns' | 'depends-on';
  }>;
  events: Array<{
    timestamp: string;
    type: string;
    reason: string;
    object: string;
    message: string;
    provenance: {
      toolName: string;
      toolCallId?: string;
      traceId?: string;
      spanId?: string;
    };
  }>;
};
```

All arrays require strict count and string-size bounds before persistence.

## Native alert handoff

Argus Observe incidents provide an explicit `Run Argus AIOps` handoff into the
governed investigation dialog. The handoff transfers only bounded incident
context through the Console route: incident ID, title, summary, severity,
service, source and correlation window.

The Console then proposes, but does not silently execute, the least-privilege
configuration available to the current operator:

- a Bundle satisfying the workflow's required capability categories;
- a valid, currently certified Kubernetes target when the selected Bundle
  requires one;
- the target namespace and environment covered by that certification.

The operator must still review the prefilled context and explicitly start the
workflow. Core repeats authorization, target certification and execution-grant
checks server-side, so editing the URL cannot broaden the effective scope.

After a successful start, Core persists the native incident, Pack, Agent, A2A
task and root-trace relationship. The Alert investigation view refreshes the
current Pack task, retains the latest known state if the Pack is temporarily
unavailable, and links directly to both the Pack-owned evidence and the
Core-owned trace. Only the bounded reviewer synthesis and lifecycle metadata
are copied back; the full investigation artifact remains owned by Argus AIOps.

## Delivery phases

### Phase 1 - local provider boundary (complete)

- provision the pinned Kind cluster;
- deploy healthy `checkout-api` and `catalog-api` workloads;
- deploy the standalone read-only Kubernetes MCP;
- register it in MCP Fabric and the AIOps Observe Bundle;
- verify positive and negative RBAC;
- verify the Kubernetes call through Core's Bundle endpoint.

### Phase 2 - pack-native evidence and provenance (complete)

- expand the researcher prompt with namespace- and service-bounded queries;
- render a small Service -> Deployment -> Pod topology in the existing run
  evidence panel;
- classify Kubernetes calls into topology, runtime and logs in the Pack;
- normalize bounded Kubernetes resource and Event results in the Pack;
- filter Events by current resource UID and incident window;
- retain only normalized metadata in the Pack artifact;
- carry the contributing tool-call, Agent trace and exact Core span identifiers
  through the signed Pack call;
- deep-link every normalized resource and Event to its persisted Core tool
  span through the existing `?span=` run inspector.

### Phase 3 - deliberate incident certification (complete locally)

- apply `incident-workload.yaml` to create a controlled CrashLoop;
- start an AIOps investigation scoped to `payment-worker` / `argus-demo`;
- require the researcher to observe the failing Pod, Events and bounded logs;
- require the reviewer to distinguish observed failure from inferred cause;
- verify persisted evidence, trace/log links, Bundle scope and audit records;
- remove the incident workload after certification.

The executable gate is `scripts/certify-aiops-kubernetes.ps1`. Completion
requires a reviewed task, collected metrics/logs/traces/knowledge, at least one
`aiops_kubernetes_*` Researcher call, normalized resources/edges/Events, a
persisted Core span for every resource/Event provenance reference, zero
workspace calls and a terminal Agent response. Cleanup runs even when the
workflow fails.

### Phase 4 - production connector (in-cluster baseline implemented locally)

- support and certify an in-cluster `ClusterIP` Service endpoint without the
  local NodePort (complete in the Kind reference cluster);
- bind one connection to explicit tenant/cluster/namespace scope (complete for
  the local reference connector);
- expose only a safe target inventory from private Fabric backend config;
- configure, validate and remove that safe target inventory through the MCP
  Fabric Connection Wizard without exposing or replacing provider credentials;
- require the Console to select a target before workflow start;
- persist and sign the exact target into the short-lived execution grant;
- enforce the namespace again at Core tool-dispatch time;
- use a dedicated ServiceAccount with an automatically rotating projected
  token, and certify that no legacy token Secret or ClusterRoleBinding reaches
  it (complete);
- require a NetworkPolicy that actually selects the provider Pod and restricts
  the MCP port to an explicit Core client selector, plus an active positive and
  negative Pod probe that proves the cluster networking plugin enforces it
  (contract complete; the current Docker/WSL Kind kernel needs the explicit
  local kube-router fallback);
- require TLS for the `production` certification profile; the current provider
  needs a service-mesh or proxy adapter because it exposes no native TLS flags;
- certify AKS OIDC, the exact federated ServiceAccount subject, managed identity
  IDs and admission-webhook token injection without changing the Pack contract
  (implemented; cloud API authorization remains provider-specific);
- certify EKS Pod Identity Agent readiness, unique association, injected
  container credentials and an IAM trust policy restricted by cluster,
  namespace and ServiceAccount tags (implemented);
- certify GKE workload pool and metadata-server readiness, exact
  ServiceAccount UID principal, IAM roles, keyless credentials and metadata
  egress (implemented);
- certify OpenShift ClusterVersion health, actual restricted SCC admission,
  dangerous SCC denial, internal service-ca TLS and absence of OAuth/Route
  exposure through the same connector contract (implemented);
- add write remediation only as a separate high-risk connector and selected
  Bundle policy with mandatory evidence validation, hash-bound second approval,
  verification and rollback evidence (Core lifecycle plus local scale and
  Deployment revision adapters complete).

## Governed write adapter

Core deliberately does not turn the read-only `aiops-kubernetes` connection
into a mutation channel. Two write adapters are registered:

- `kubernetes.scale.v1` accepts only the exact `resources_scale` contract:
  `apiVersion`, `kind` and `name` are required strings; `namespace` is a string;
  and optional `scale` is numeric;
- `kubernetes.deployment-revision-rollback.v1` accepts only the exact
  `deployment_revision_rollback` contract. Reads return a bounded revision and
  canonical pod-template fingerprint history. A write must supply the target
  revision, the approved current fingerprint and the approved target
  fingerprint.

Tools with similar names but different schemas are rejected. The custom
revision connector restores only a retained Deployment pod template. It does
not expose generic manifest apply, delete, exec or arbitrary patch operations.

The mutation connection must be separate and opt in through private backend
configuration:

```json
{
  "governed_write": true,
  "remediation_target_id": "argus-aiops-kind",
  "remediation_source_bundles": ["argus-aiops-observe"],
  "execution_namespaces": ["argus-demo"]
}
```

It belongs to a dedicated remediation Bundle and has a `selected` Bundle x
Connection tool policy that explicitly includes only its prefixed scale and
revision tools. The private `remediation_source_bundles` allowlist must
name one of the incident's evidence Bundles, and the remote catalog must be
trusted. An unscoped, `all` or merely name-compatible connection is not
eligible. The incident's original read connector must also retain a current
passing certification.

The enforced lifecycle is:

1. Core accepts a write path only when the normalized reviewer recommendation
   contains a strict `executionIntent` for a registered adapter, including the
   exact workload and either desired replica count or retained target revision.
   Diagnostic recommendations have no intent and remain read-only;
2. approve the reviewer recommendation and its displayed intent;
3. run a successful read-only evidence validation;
4. read and normalize the current adapter-owned state;
5. persist an immutable before/after preview, exact write, verification and
   rollback arguments, and the canonical SHA-256 plan hash;
6. approve or reject that exact hash in a second operator decision;
7. atomically claim and execute only the approved plan version;
8. query the state again and mark the remediation verified only when the
   approved desired state is observed;
9. otherwise restore the previous adapter state and verify the rollback. A
   failed rollback is retained as a manual-intervention state;
10. after a successful verification, persist a delayed post-change monitor
    with a separate SHA-256 hash over the immutable rollback arguments;
11. before every delayed read or rollback, revalidate the exact Bundle,
    connector policy, remote catalog and current connector certification;
12. retain `healthy`, `check_failed` or `regression_detected` evidence. A read
    failure never authorizes a mutation;
13. expose a detected regression as a new rollback proposal bound to the
    stored hash and require an explicit operator decision;
14. execute only the approved monitor version and rollback hash, then verify
    the original adapter state and retain the complete terminal evidence.

The Core worker also reconciles verified plans that are missing their monitor,
for example after a process interruption between provider verification and
monitor persistence. The insert is idempotent per plan. Existing terminal
plans are therefore picked up safely after an upgrade without changing their
immutable write or rollback arguments. Timing is controlled by
`AIOPS_POST_CHANGE_MONITOR_DELAY_SEC` (default 300) and
`AIOPS_POST_CHANGE_MONITOR_POLL_SEC` (default 30).

The scale adapter supports `Deployment` and `StatefulSet`, one incident
namespace and 1-50 desired replicas. The revision adapter supports only
`Deployment` and only revisions already retained as owned ReplicaSets. Both are
restricted to configured namespace/workload allowlists. Arbitrary manifests,
deletes, pod exec, scale-to-zero and user-supplied templates remain outside the
registry.

### Adapter registry and admission contract

Remediation adapters are registered in Core and selected by their explicit,
versioned `adapterKey`; a workflow, HTTP caller or similarly named MCP tool
cannot create an implicit mutation path. The Console submits the key returned
by Core, the API validates it, and the executor resolves it again before plan
creation, execution, delayed observation and rollback. An unknown or persisted
legacy key fails before a database lookup or provider call.

Every admitted adapter must declare and enforce all of the following:

- a bounded execution-intent parser and a versioned adapter key;
- one exact provider tool and input-schema fingerprint;
- a target-scoped, selected Bundle policy on a separate governed-write
  connection;
- an immutable before/after preview and canonical plan hash;
- hash-bound human approval, with separation of duties in production;
- deterministic read-after-write verification;
- a bounded restoration operation whose result can also be verified;
- persistent post-change monitoring and a separately approved drift rollback.

The registry exposes these controls with each candidate (`riskLevel`, approval,
verification, rollback, post-change monitoring and production separation of
duties), so the Console can show the effective safety contract rather than
guessing it from a tool name.

Change plans persist the adapter-owned `adapterState` as an immutable JSON
object with a numeric `schemaVersion`. The state is included in the canonical
plan hash and is normalized again before every mutation. Delayed checks retain
their normalized `observedState` separately. `previous_replicas`,
`desired_replicas` and `observed_replicas` remain nullable compatibility
projections for the scale UI; authorization and state comparison no longer
trust those columns. Migration 182 backfills existing scale plans and monitors
without changing their stored approval hashes.

The second adapter is the previously planned narrow Deployment-revision
rollback primitive, backed by its own provider contract, namespaced RBAC and
runtime workload allowlist. The connector normalizes pod templates, removes the
controller-generated `pod-template-hash`, and compares canonical SHA-256
fingerprints. Mutation uses an atomic `resourceVersion` test and bounded retries
that fail closed as soon as the current fingerprint differs from the approved
state. A generic `resources_create_or_update` tool remains ineligible. A rollout
restart is also not registered: it is one-way and cannot satisfy the current
verified-restore lifecycle. Supporting one-way actions would require a separate
lifecycle and policy model rather than weakening this contract.

For a target whose environment is exactly `production`, the operator who
created the plan cannot provide either the second change approval or a later
regression rollback approval. Local and demo targets retain a single-operator
path so the reference environment remains usable.

## Operator commands

```powershell
.\scripts\bootstrap-aiops-kubernetes.ps1
.\scripts\bootstrap-aiops-kubernetes-connector.ps1
.\scripts\bootstrap-aiops-kubernetes-remediation.ps1
.\scripts\verify-aiops-kubernetes-remediation.ps1
.\scripts\bootstrap-aiops-demo.ps1
.\scripts\certify-aiops-kubernetes.ps1
docker compose exec -T mcp-server npm run seed:aiops-remediation
```

The bootstrap commands are idempotent. The certification command creates the
incident temporarily and removes it automatically unless `-KeepIncident` is
specified.
