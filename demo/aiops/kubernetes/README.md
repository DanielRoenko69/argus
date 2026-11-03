# Argus.AIOps local Kubernetes evidence lab

This lab runs a reproducible two-node Kind cluster beside the normal Argus
Docker Compose stack. It installs only the standalone `kagent-tools` MCP
server; the kagent agent controller, model configuration, UI, memory and
approval system are deliberately not installed. Argus Core remains the agent,
model, policy and audit control plane.

## Security boundary

- Kubernetes API and MCP NodePort bind to `127.0.0.1` only.
- The tool server registers only its Kubernetes provider.
- `--read-only` removes write tools at the application layer.
- Namespaced RBAC permits `get`, `list` and `watch` only.
- Kubernetes Secrets are excluded.
- Argus MCP Bundle policy and signed execution grants provide the final exact
  tool allowlist per AIOps run.

## Bootstrap

```powershell
.\scripts\bootstrap-aiops-kubernetes.ps1
```

The normal workload is healthy. Run the complete controlled incident
certification with:

```powershell
.\scripts\certify-aiops-kubernetes.ps1
```

The command applies the deliberate `payment-worker` CrashLoop, requires a real
Argus.AIOps investigation to use the governed Kubernetes MCP tools alongside
metrics, logs, traces and knowledge, and removes the failing workload in a
`finally` block. Use `-KeepIncident` only for manual debugging.

The tool server is reachable on the host at `http://127.0.0.1:18084/mcp` and
from Argus Docker containers at `http://host.docker.internal:18084/mcp`.

The normal `scripts/bootstrap-aiops-demo.ps1` flow reconciles this cluster
automatically. Use `-SkipKubernetes` only when an external Kubernetes provider
will be configured through MCP Fabric instead.

## In-cluster connector certification

The host-bound NodePort above exists only for the local Docker/Kind bridge. A
second, production-shaped release proves the deployment model used when Argus
Core runs inside the same cluster:

```powershell
.\scripts\bootstrap-aiops-kubernetes-connector.ps1
```

It creates only a `ClusterIP` service, accepts MCP traffic only from Pods with
the explicit `argus.eu/kubernetes-connector-client=true` label, uses a dedicated
ServiceAccount with a rotating projected token, and emits a machine-readable
report at `test-results/kubernetes-connector-certification.json`.

The reusable contract is
`connector-contract.in-cluster.json`; its schema is
`connector-contract.schema.json`. The certifier fails closed when the Service
is externally exposed, a NetworkPolicy does not actually select the workload,
an unrestricted ingress rule exists, an active allowed/denied Pod probe proves
that the cluster does not enforce the policy, RBAC permits mutations or Secrets, a
ClusterRoleBinding reaches the ServiceAccount, the token is long-lived, Pod
security settings regress, no ready EndpointSlice exists, or the running image
does not resolve to the expected digest.

`in-cluster-read-only` deliberately permits private HTTP for the current
provider, which has no native TLS flags. A contract may claim `production` only
with an HTTPS endpoint; TLS termination through a mesh or a dedicated proxy is
therefore the remaining transport adapter boundary.

Kind includes an nftables-based NetworkPolicy implementation, but some
Docker/WSL kernels cannot program the required nftables rules. The active probe
detects this case; merely creating a `NetworkPolicy` object is intentionally not
enough. An opt-in, iptables-based kube-router controller is checked in for this
local-lab limitation:

```powershell
.\scripts\bootstrap-aiops-kubernetes-connector.ps1 -InstallNetworkPolicyController
```

That switch is intentionally not automatic: the fallback is a persistent,
privileged `hostNetwork`/`hostPID` DaemonSet with cluster-wide read-only RBAC.
Managed production clusters should use their supported CNI policy engine and
must not install this lab fallback.

The local contract grants kube-router four seconds to synchronize labels into
its ipsets before each probe. This exception is restricted to the
`in-cluster-read-only` lab profile. A `production` contract requires zero
stabilization time so a provider cannot claim production certification while
new Pods briefly bypass policy enforcement.

Managed-cluster workload identity adapters live under `workload-identity/`.
The AKS, EKS, GKE and OpenShift adapters and their fail-closed cloud/pod
certification are implemented.

The OpenShift adapter additionally includes an apply/patch overlay in
`openshift/` for internal service-ca TLS termination without exposing a Route.

## Governed remediation connector

The local write-path prototype is a third, independent connector. Install it
after the base Kind lab:

```powershell
.\scripts\bootstrap-aiops-kubernetes-remediation.ps1
```

It builds a small, workload-scoped MCP server from the checked-in
`remediation-connector/` package. Its namespaced ServiceAccount may read
Deployments and their owned ReplicaSet history, patch Deployments, and get or
patch the `Deployment` and `StatefulSet` scale subresources in `argus-demo`.
Runtime namespace and workload allowlists restrict those permissions further
to `argus-demo/checkout-api`. It cannot delete Pods, read Secrets, update whole
Deployments or cross namespaces.

The provider publishes only `resources_scale` and
`deployment_revision_rollback`. Argus places both in a separate
`argus-aiops-remediate` Bundle with an exact selected-tool policy. No Agent owns
that Bundle. Core also requires an explicit link back to the incident's
evidence Bundle, a trusted catalog fingerprint, fresh certification, a
successful read-only validation and a hash-bound human approval before
dispatch. A recommendation is write-eligible only when its Core-normalized
`executionIntent` binds one registered adapter to the exact target:
`kubernetes.scale.v1` binds workload kind, name and desired replicas, while
`kubernetes.deployment-revision-rollback.v1` binds a Deployment, name and
retained target revision. A plain diagnosis or inspect action can never be
promoted into a mutation.

For this Docker/Kind lab, Core joins the private `kind` Docker network and
reaches `argus-aiops-control-plane:30085`. That NodePort has no Kind
`extraPortMapping`, so it is not published on the Windows host. Production
deployments should use the already certified in-cluster `ClusterIP` pattern.
When rebuilding Core manually, keep the overlay active so the private route is
retained:

```powershell
docker compose -f docker-compose.yml -f compose.aiops-demo.yml up -d --build mcp-server
```

After a verified change, Core schedules a persistent post-change read. Drift
is displayed in Native Alerts as a separate, hash-bound rollback proposal.
Connector errors are retained as `check_failed` and never authorize writes.
An operator must approve the exact rollback hash before Core restores and
verifies the adapter-owned previous state: either the replica count or the
Deployment pod-template fingerprint.

After an administrator has reviewed and trusted the discovered catalog
fingerprint in MCP Fabric, run the real local certification cycle with:

```powershell
.\scripts\verify-aiops-kubernetes-remediation.ps1
```

For the browser-driven operator demo, add an idempotent, explicitly bound
`checkout-api -> 3 replicas` proposal to the latest completed demo incident:

```powershell
docker compose exec -T mcp-server npm run seed:aiops-remediation
```

It checks that the Bundle exposes exactly the prefixed scale and revision tools,
scales `checkout-api` by one replica, verifies it, restores a retained
Deployment revision by its canonical pod-template fingerprint, restores the
original template, and finally restores and verifies the exact previous replica
count. Each revision patch includes a Kubernetes `resourceVersion` test and is
retried only while the expected current fingerprint still matches. Per-call
timeouts and bounded provider retries are backed by an independent PowerShell
`finally` guard that reapplies the checked-in healthy Deployment and restores
its scale if the MCP process is interrupted.

## Guided bad-deployment story

The complete operator demo starts from a healthy `checkout-api`, records its
retained Deployment revision, and injects a new pod template whose process stays
alive but never serves the configured readiness probe:

```powershell
.\scripts\run-aiops-deployment-regression-demo.ps1
```

Kubernetes keeps the existing ready Pods in service while the new revision is
visibly unavailable. The runner launches the real read-only Argus.AIOps Agent
investigation and prints the resulting Native Alerts URL. In that view, approve
the Core-normalized revision proposal, create its immutable plan, approve the
exact plan hash, and execute it. The runner observes cluster recovery but marks
the incident recovered only when Core has persisted a `verified` revision plan.

If investigation, approval or verification fails, the PowerShell `finally`
guard restores the recorded healthy revision through the operator context.
`-KeepIncidentOnFailure` is an explicit debugging escape hatch; it should not be
used for an unattended demo.

## Scheduled re-certification

The external certifier can run as a Kubernetes CronJob without giving Argus
Core cluster credentials. Create a dedicated Argus API key with:

- scope: `agents` or `both`;
- allowed tools: exactly `system.kubernetes-certification.import`;
- no Agent, Bundle or MCP tool access.

Save that key in a local file which is not committed, then install the runner:

```powershell
.\scripts\bootstrap-kubernetes-certification-cronjob.ps1 `
  -ApiKeyFile C:\secure\argus-certifier.key `
  -RunNow
```

The bootstrap builds and loads `argus-kubernetes-certifier:local`, creates a
namespaced Secret from the file, installs bounded review RBAC and schedules a
run every six hours. The runner uses a one-hour projected ServiceAccount token,
uploads only normalized report evidence and exits non-zero after importing a
failed report so Kubernetes and Argus both retain the failure signal.

The checked-in CronJob is the generic Kubernetes/Kind baseline. Managed-cloud
contracts additionally require a runner image containing the matching `az`,
`aws` or `gcloud` CLI and its workload identity; they use the same Core import
endpoint and report contract.
