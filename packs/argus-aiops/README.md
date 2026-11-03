# Argus AIOps

Evidence-first incident investigation Solution Pack for Argus Core.

Argus AIOps correlates existing monitoring, logging, tracing, runtime topology
and runbook systems. It is not another Elasticsearch, Prometheus or SIEM data
store. Providers retain raw telemetry; the Pack coordinates scoped read-only
queries and produces a bounded, reviewer-validated incident record.

Argus Core remains the single authority for agents, models, credentials, MCP
bundles, execution targets, approvals, mutation connectors, audit and
cross-system observability.

## Current vertical slice

Pack version `0.2.0` implements `incident-investigation`:

```text
Incident intake
   → exact service/environment/time scope
   → researcher: provider and Kubernetes evidence
   → knowledge: runbooks and incident history
   → reviewer: causal-claim validation
   → structured diagnosis and recommended actions
   → Core-owned proposals and optional governed remediation
```

The workflow currently requires:

- a `metrics` bundle capability;
- a `runtime` bundle capability;
- a Core-signed Kubernetes execution target.

Logs, traces, topology, repository/change, RAG and incident-management sources
are recommended evidence lanes when installed. Missing or empty provider data
is recorded as an evidence gap, never invented.

## Evidence contract

Three logical Core Agents participate:

| Role | Responsibility | Mutation allowed |
|---|---|---:|
| `aiops-researcher` | bounded metrics, logs, traces and runtime queries | no |
| `aiops-knowledge` | runbooks, architecture and incident history | no |
| `aiops-reviewer` | validates causal claims and emits strict JSON diagnosis | no |

The concrete model and runtime profile are assigned in Argus Core. The Pack
only invokes an Agent role present in the signed execution grant.

For Kubernetes-scoped incidents, the workflow now fails closed unless it
obtains normalizable Kubernetes resource evidence. Core limits large provider
results before they re-enter the Agent context; Kubernetes List responses stay
valid JSON and include projection metadata. The Pack persists normalized
resource/event evidence and provenance, not raw telemetry corpora.

Reviewer output distinguishes:

- `confirmed` — causal claim supported by supplied evidence;
- `suspected` — leading hypothesis with unresolved gaps;
- `inconclusive` — evidence is insufficient;
- `refuted` — supplied evidence contradicts the hypothesis.

Malformed reviewer output becomes an explicit partial/inconclusive result.

## Read path versus remediation path

The Pack is read-only. It never receives the remediation connector and never
executes a Kubernetes mutation.

```text
Argus AIOps investigation (observe bundle, read-only)
        │ reviewed recommended action
        ▼
Argus Core remediation lifecycle
  1. persist proposal and source fingerprint
  2. require human proposal decision
  3. resolve a server-side allowlisted adapter
  4. create immutable plan + plan hash
  5. require approval of that exact hash
  6. dispatch through a separate remediation bundle
  7. monitor post-change health and retain rollback evidence
```

Changing the evidence, target, tool arguments or adapter invalidates the
approved plan. A read-only bundle cannot be reused as a write capability.

## Runtime contract

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | liveness |
| `GET /readyz` | persistence/runtime readiness |
| `GET /.well-known/argus-solution-pack.yaml` | `argus.eu/v1alpha1` pack manifest |
| `GET /.well-known/agent-card.json` | A2A workflow catalog |
| `POST /message:send` | start a signed investigation |
| `GET /tasks/:taskId` | read durable task state |
| `POST /tasks/:taskId:cancel` | cancel an investigation |

Workflow start without a valid Core execution grant is rejected. The resource
scope in the request must match the scope signed by Core.

## Local stack with Argus Core

The complete demo includes Core, this Pack, Prometheus, Loki, Jaeger, Kind,
`kagent-tools`, a demo workload and a separate remediation connector.

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-aiops-demo.ps1
```

Open:

- AIOps Pack: <http://localhost:3000/solutions/argus.aiops>
- Alerts/incidents: <http://localhost:3000/observe/alerts>
- MCP Fabric: <http://localhost:3000/mcp-fabric>
- Prometheus: <http://127.0.0.1:9090>
- Loki: <http://127.0.0.1:3101>
- Jaeger: <http://127.0.0.1:16686>

### Controlled deployment-regression demo

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-aiops-deployment-regression-demo.ps1
```

The script:

1. records the healthy `checkout-api` Deployment revision;
2. injects an unready pod template while old healthy Pods keep serving;
3. starts the governed investigation;
4. waits for reviewer-validated evidence and a Core proposal;
5. stops at the human approval/immutable-plan gates;
6. verifies the executed recovery;
7. restores the baseline automatically if the scenario fails or times out.

This is a regression lab, not a production deployment command.

## Standalone development

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

Run the Pack with Pack-local PostgreSQL:

```powershell
docker compose up --build --wait
curl.exe http://localhost:2030/healthz
curl.exe http://localhost:2030/.well-known/argus-solution-pack.yaml
```

The standalone stack defaults to Core at
`http://host.docker.internal:3000`. Discovery and health work independently;
an investigation still requires a reachable Core, configured Agents, bundles,
providers and a valid signed grant.

Stop it with `docker compose down`. Add `--volumes` only when Pack-local A2A
task data may be discarded.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | Pack HTTP port, default `2030` |
| `POSTGRES_CONNECTION_URL` | Pack-owned A2A task persistence |
| `ARGUS_URL` | Core API origin |
| `ARGUS_CORE_AGENT_TIMEOUT_MS` | bounded Core Agent request timeout |
| `ARGUS_A2A_PUBLIC_URL` | Pack origin advertised to Core |
| `ARGUS_PACK_DISCOVERY_TOKEN_FILE` | optional discovery bearer-token file |

Provider credentials are intentionally absent: they belong to Core credential
profiles and the installed MCP backends.

## Supported provider model

The Pack contract is provider-neutral. The current local certification path
uses Prometheus, Loki, Jaeger and Kubernetes. The manifest can accept other
metrics/log/tracing/runtime systems through Core adapters and bundles, but an
adapter is not considered supported merely because its provider name exists in
the manifest; it must pass connection, schema, scope and evidence tests.

## Safety properties

- bounded correlation window and exact environment/resource scope;
- read-only researcher and knowledge identities;
- mandatory Kubernetes evidence for Kubernetes incidents;
- causal claims reviewed separately from evidence collection;
- no raw telemetry persistence in Pack task artifacts;
- no provider credentials or write connector in the Pack;
- fail-closed behavior on malformed output, missing grants or missing evidence;
- Core-owned approvals, immutable plan hashes and post-change monitoring.

Argus AIOps is an advanced prototype. It is not yet a replacement for a mature
observability platform, on-call process or independently certified production
automation system.
