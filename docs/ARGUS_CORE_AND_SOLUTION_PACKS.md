# Argus Core and Solution Packs

> Status: beta. The manifest contract, discovery, the A2A client, signed
> execution grants and the three packs in `packs/` are implemented. The
> contracts are versioned `v1alpha1` and are not yet a stable public API.

Argus is built as one platform plus installable Solution Packs:

| Package ID | Name | Role |
|---|---|---|
| `argus.core` | Argus Core | The platform and the only authority for identity, SSO/RBAC, agents, MCP bundles, execution grants, approvals, credential references, audit and observability. |
| `argus.dev` | Argus Dev | Governed software-delivery workflows built on LangGraph (`packs/argus-dev`). |
| `argus.aiops` | Argus AIOps | Evidence-first, read-only incident investigation (`packs/argus-aiops`). |
| `argus.hermes` | Argus Hermes | Runtime bridge to Hermes agent services (`packs/argus-hermes`). |

The dotted ID is the stable technical identifier used in manifests,
configuration and grants; the console shows the display names.

An empty agent builder expects a team to already know which agents, skills,
tools, knowledge sources, credentials and permission boundaries it needs. A
Solution Pack ships a reviewable, adaptable starting point for one domain
instead. A pack may run its own domain runtime (for example LangGraph), but it
stays a satellite of Core and never becomes a second governance, identity or
credential authority.

## Authority boundary

**Core owns** users, SSO, RBAC, API keys and service principals; agent
definitions and the assignment of logical roles to concrete model/runtime
profiles; MCP Fabric, bundles and tool policies; credential profiles and
secret references; human approvals, audit records and cross-pack traces; and
the issuing and verification of execution grants.

**A pack owns** its workflow definitions, state machines, checkpoints and task
persistence, plus domain logic and evidence formatting.

Consequences:

- A pack never introduces its own authentication, credential, approval or
  audit authority, never owns Core tables and never runs Core migrations.
- All tool calls go through Core bundles and the shared hook chain; risky
  writes remain subject to Core approval and audit.
- A pack only calls the Core agents and bundles bound into the signed
  execution grant for a run. It cannot add scope.
- Provider credentials are absent from pack configuration. They live in Core
  credential profiles and the installed MCP backends.
- Model and runtime choices are made in Core. A pack cannot replace them or
  silently fall back to another runtime.

## Deployment model

```text
argus-core repository
  ├─ Core image: identity, policy, MCP Fabric, credentials, RAG, audit
  └─ packs/
       ├─ argus-dev     → argus-dev image     LangGraph delivery workflows, A2A agent
       ├─ argus-aiops   → argus-aiops image   incident investigation, A2A agent
       └─ argus-hermes  → argus-hermes image  Hermes runtime adapter

Core ──(authenticated pack contract: manifest, health, A2A, runtime adapter)──▶ pack
```

Each pack is a separately versioned container image. Core reaches it only over
HTTP at an operator-configured origin.

## Discovery

Core learns about packs from configuration, not from the network:

```env
ARGUS_SOLUTION_PACK_ENDPOINTS=argus.dev=http://argus-dev:2025,argus.aiops=http://argus-aiops:2030,argus.hermes=http://argus-hermes:2040
ARGUS_SOLUTION_PACK_TOKEN_FILES=argus.hermes=/run/secrets/argus-hermes-discovery-token
ARGUS_SOLUTION_PACK_REFRESH_SEC=60
ARGUS_SOLUTION_PACK_DISCOVERY_TIMEOUT_MS=5000
ARGUS_CORE_VERSION=1.0.0
```

- `ARGUS_SOLUTION_PACK_ENDPOINTS` is a comma-separated `packId=origin` map (at
  most 32 entries). Each endpoint must be a bare HTTP(S) origin without path,
  query, fragment or embedded credentials. Plain HTTP is accepted only for
  loopback, private-network, Compose service and cluster-local hosts;
  link-local and cloud metadata addresses are rejected.
- `ARGUS_SOLUTION_PACK_TOKEN_FILES` maps pack IDs to **absolute file paths**
  inside the Core container, never to token values. Core reads the file
  (maximum 8 KiB, single line) and sends it as `Authorization: Bearer <token>`
  for discovery and A2A calls.

Kubernetes deployments use the same logical configuration via ConfigMap/Helm
values and mounted secrets. The endpoint is only a bootstrap. On each refresh
Core:

1. fetches `/.well-known/argus-solution-pack.yaml` (redirects are not followed;
   maximum 512 KiB);
2. validates it against the strict `argus.eu/v1alpha1` schema;
3. checks that `metadata.id` matches the configured pack ID;
4. checks `spec.requires.core` against `ARGUS_CORE_VERSION` (exact version or
   `>=` minimum);
5. probes the manifest-declared `healthPath` and `readinessPath`.

| State | Meaning |
|---|---|
| `not_checked` | Configured, not yet probed. |
| `ready` | Valid, compatible manifest; health and readiness succeeded. |
| `degraded` | Valid, compatible manifest; a health or readiness probe failed. |
| `unreachable` | Manifest request failed or the service credential was unreadable. |
| `invalid` | The manifest failed schema validation. |
| `incompatible` | Manifest ID mismatch or unsupported Core version. |

Only `ready` packs can be invoked over A2A. The registry is held in memory per
replica and persisted in PostgreSQL (`argus_solution_pack_installations`) as
installation evidence. When the observed version changes, the previous version
and manifest are kept as the basis for diff and rollback requests.

## Manifest contract (`argus.eu/v1alpha1`)

Example, abridged from Argus AIOps:

```yaml
apiVersion: argus.eu/v1alpha1
kind: SolutionPack
metadata:
  id: argus.aiops
  version: 0.2.0
  displayName: Argus AIOps
spec:
  delivery:
    type: container
    protocol: argus-pack-v1alpha1
    healthPath: /healthz
    readinessPath: /readyz
  requires:
    core: ">=1.0.0"
    capabilities: [agent.invoke, metrics.query, runtime.read, logs.query]
    credentials:
      - id: telemetry
        accepts: [prometheus, grafana, opensearch, elastic]
      - id: incident-management
        accepts: [pagerduty, servicenow, jira]
        optional: true
  components:
    agents:
      - id: incident-orchestrator
        runtime: a2a
        skills: [incident-triage, signal-correlation]
        bundles: [aiops-observe]
        credentials: [telemetry, incident-management]
        coreAgents: [aiops-researcher, aiops-knowledge, aiops-reviewer]
        a2aAgentCardPath: /.well-known/agent-card.json
    skills: [incident-triage, signal-correlation]
    bundles: [aiops-observe]
    workflows: [incident-investigation]
    knowledgeSources: [operations-runbooks]
    dashboards: [operations-overview, incident-review]
    policies: [read-only-observation]
  readiness:
    smokeTests: [manifest-contract, a2a-contract, task-persistence]
```

`components` may also contain `runtimeAdapters` (see below). Core enforces:

- unknown fields are rejected at every level; duplicate IDs in any list are
  rejected; IDs are stable lowercase identifiers and versions are semver;
- agents may reference only skills, bundles and credential requirements
  declared in the same manifest;
- `runtime: a2a` agents must declare `a2aAgentCardPath`, other runtimes must not;
- every service path is relative to the configured endpoint: it starts with
  `/` and contains no `//` prefix, scheme, `..`, query, fragment, backslash or
  encoded separator;
- `readiness.smokeTests` has at least one entry.

Manifests reference capability contracts, not a single vendor: an agent that
needs `metrics.query` can be served by any provider that offers it through a
Core bundle. A provider name in `accepts` does not by itself mean the provider
is supported; it still has to pass connection, scope and evidence checks.

## A2A boundary

Inside a pack the domain framework is used natively (Argus Dev uses LangGraph).
A2A is used only at the service boundary between Core and a pack container; it
does not replace LangGraph or MCP.

- Core is a validating HTTP+JSON A2A v1 client (`src/a2a/client.ts`). It loads
  the agent card from the manifest-declared path and requires an `HTTP+JSON`
  interface with protocol version `1.0` whose URL equals the configured pack
  origin. Cards pointing elsewhere are rejected rather than followed.
- Agent cards never contain secrets; they may advertise a bearer scheme for
  the service credential.
- Each invocation gets a fresh Core root trace ID and `traceparent`, correlated
  with the A2A task/context IDs and the pack's internal thread IDs.
- Tool calls by remote agents still go through MCP Fabric.

Pack-side endpoints: `GET <a2aAgentCardPath>` (agent card with typed workflow
catalog), `POST /message:send`, `GET /tasks/:taskId` and
`POST /tasks/:taskId:cancel`. Core exposes them to platform admins only through
its own routes, holding the service credential itself:

- `GET  /api/admin/solution-packs/:packId/agents/:agentId/a2a/card`
- `POST /api/admin/solution-packs/:packId/agents/:agentId/a2a/message`
- `GET  /api/admin/solution-packs/:packId/agents/:agentId/a2a/tasks[/:taskId]`
- `POST /api/admin/solution-packs/:packId/agents/:agentId/a2a/tasks/:taskId/cancel`

### Preflight and start

Messages carry an `operation`: `workflow.preflight` or `workflow.start`
(`coding.preflight` / `coding.start` remain compatibility aliases).

- A preflight includes the selected bundle IDs. Core checks them against the
  caller's allowed bundles and resolves provider-neutral capability categories
  from the actual MCP Fabric contents: `repository`, `repository-checkout`,
  `ci`, `rag`, `security`, `workspace`, `metrics`, `logs`, `traces`,
  `topology`, `runtime`, `incident`.
- `repository-checkout` is satisfied only by a connection with a concrete
  provider, owner and repository. For Argus Dev, Core requires exactly one
  concrete checkout target before preflight or start.
- The result is passed to the pack as a `bundle-capability-preflight` artifact
  and stored with the A2A task.
- `workflow.start` repeats the checks. If a required category is missing, Core
  issues no grant and nothing is dispatched. Starts are refused when grant
  issuing is unavailable.

Human approvals always run through Core: Core writes approval evidence and
telemetry before resuming the pack workflow, and A2A follow-up messages cannot
bypass this gate.

## Execution grants

Every writing pack task gets its own technical identity: a Core-signed,
short-lived `eg_v1` grant (HMAC-SHA256). Core sends it with the start message;
the pack presents it back to Core for agent, MCP and credential requests. A
grant immutably binds:

- issuer `argus.core`, audience (pack ID) and pack agent;
- principal (user, API key or service) and tenant/workspace keys;
- allowed Core agent IDs and names, MCP bundle IDs and optional tool names;
- A2A message ID and root trace ID;
- optional workspace root/access, Kubernetes resource scope and runtime
  selection evidence;
- policy version (`mcp-bundle-v1`), issue time and expiry.

Default and maximum lifetime is 60 minutes, enough for one complete governed
run. Each grant is recorded in `argus_execution_grants` with a root trace. On
use, Core re-verifies signature, lifetime, the grant record's active status and
the requested agent, bundle, trace and scope. A pack may forward a grant and
narrow its tool list for a worker, but cannot mint grants or widen scope. Grant
tokens are kept out of workflow state, A2A artifacts and telemetry; the
non-secret grant ID is retained as evidence.

The signing key never leaves Core:

```env
ARGUS_EXECUTION_GRANT_SECRET_FILE=/run/secrets/argus-execution-grant-signing-key
# or, for local tests only (at least 32 bytes):
ARGUS_EXECUTION_GRANT_SECRET=...
```

Setting both is a configuration error. If neither is set, Core derives a
separate signing key from `SESSION_SECRET` by HMAC domain separation, so a
fresh self-hosted install works without a fixed default key. Production
deployments should use the file variant so the key can be rotated
independently.

## Runtime adapters

A `runtimeAdapter` is neither an MCP bundle nor an A2A agent. It describes a
pack-owned bridge to the environment where an agent's execution loop runs.
Core validates and inventories the declaration but never executes anything
from the manifest.

```yaml
runtimeAdapters:
  - id: hermes-http
    runtime: hermes
    protocol: argus-runtime-v1alpha1
    endpoint: /runtime/v1
    modes: [attached, managed]
    capabilities: [health, runs, events-sse, cancel, approval]
```

Declared capabilities are a ceiling. The pack reports what is live through
`GET <endpoint>/adapters/<id>/capabilities` and `.../status`. Core calls only
these declared relative paths with its own service token, bounds response size
and rejects mismatched adapter identities, modes or capabilities. Responses
contain no upstream URL, credentials or tool output, and browsers never receive
pack credentials or a free-form runtime URL. Admin routes live under
`/api/admin/solution-packs/:packId/runtime-adapters/:adapterId/` (`capabilities`,
`status`, `attached-runs`, `runs`, plus per-run status, stop/cancel and events).

- **Attached** mode connects an existing Hermes API service and is labelled
  `External / attested`: that service and its native tools stay outside Argus
  governance. It never receives a Core runtime MCP lease or MCP Fabric
  credentials and is never a fallback for a managed run.
- **Managed** mode runs an isolated runner per run. Core binds each run to an
  `argus_runtime_mcp_leases` row (run, active grant ID, pack, adapter, Core
  agent, root trace); the bearer grant itself is not stored. Only an active
  managed lease with matching grant and trace may use `/mcp/runtime/<leaseId>`,
  which exposes only the dynamic and remote MCP tools of the granted bundles.

Managed runs are opt-in and fail closed. Core coordinates them only when both
values are set explicitly:

```env
# Internal Core origin reachable by the per-run MCP auth proxy
# (no path, query or credentials; never a browser-derived host).
ARGUS_RUNTIME_MCP_ORIGIN=http://mcp-server:3000
# Bundle IDs an operator has reviewed as read-only. There is no default.
ARGUS_MANAGED_RUNTIME_READ_ONLY_BUNDLE_IDS=3,7
```

Otherwise Core reports `managed_runtime_orchestration_unavailable`. Core also
requires a managed adapter whose live capabilities include `runs` and
`mcp-fabric`. Principal, lease, trace and Core origin come from Core context,
never from the browser. Run events are returned as a bounded, schema-validated
Core snapshot, not as raw native event streams. On the pack side, managed
Hermes additionally needs a separately deployed `runnerd` broker; without it
the pack answers managed starts with `MANAGED_RUNNER_NOT_PROVISIONED` (see
[packs/argus-hermes/README.md](../packs/argus-hermes/README.md)).

## Pack lifecycle, diff and rollback

Platform admin routes:

- `GET /api/admin/solution-packs` — registry and discovery evidence
- `POST /api/admin/solution-packs/refresh` — refresh all packs now
- `GET /api/admin/solution-packs/:packId/diff` — diff against the previous manifest
- `GET /api/admin/solution-packs/:packId/rollback-requests?limit=20`
- `POST /api/admin/solution-packs/:packId/rollback` — create a rollback request

Developers get a read-only pack list via `GET /api/ui/solution-packs`; the
console renders each pack at `/solutions/<packId>`.

Core never mutates containers or cluster resources itself. A rollback request
is stored in `argus_solution_pack_rollback_requests` as `pending` with target
version, manifest snapshot, source revision, user and reason. An external
deployment controller applies it through internal routes protected by the
`X-Workspace-Secret` header (not browser SSO):

- `GET /api/internal/solution-packs/rollback-requests?status=pending&limit=20`
- `POST .../rollback-requests/:requestId/claim` with `{ "workerId", "leaseSeconds" }`
- `POST .../rollback-requests/:requestId/result` with
  `{ "workerId", "status": "applied" | "failed", "error" }`

Claiming is atomic (`pending` → `accepted`). A claim lease defaults to 300
seconds (range 30–3600); after expiry another worker may claim it, and results
must carry the claiming worker ID. `src/solutionPacks/reconcilerClient.ts` is a
provider-neutral client for polling, claiming and reporting; applying the
target image stays a controller callback (Compose, Kubernetes, Helm or another
orchestrator). `/api/internal/*` must stay cluster-internal and must not be
published through an ingress.

## The packs

**Argus Dev** (`packs/argus-dev`, manifest `0.4.0`) owns the LangGraph state
machines and checkpoints for governed delivery. One A2A agent,
`coding-orchestrator`, uses the Core roles `planner`, `knowledge`, `coder`,
`reviewer` and `researcher`. Its catalog, embedded in the agent card and
rendered by the console, contains `ticket-to-pull-request`,
`pull-request-review`, `ci-failure-recovery`, `security-remediation`,
`release-notes` and `backlog-grooming` (shown as Backlog Planning). External CI
stays provider-owned; the pack creates the branch/PR handoff, records the
external run identity and resumes when the provider reports a result. Code
approval and PR creation are separate human gates; neither authorizes a merge.
Cancellation is cooperative (`canceling`, then `canceled`); external writes
already performed are not rolled back. See
[packs/argus-dev/README.md](../packs/argus-dev/README.md) and
[docs/architecture/argus-langgraph-runtime.md](architecture/argus-langgraph-runtime.md).

**Argus AIOps** (`packs/argus-aiops`, manifest `0.2.0`) runs the read-only
`incident-investigation` workflow through one A2A agent,
`incident-orchestrator`, with the Core roles `aiops-researcher`,
`aiops-knowledge` and `aiops-reviewer`. It requires `metrics` and `runtime`
bundle capabilities and a Core-signed Kubernetes execution target; the
request's resource scope must match the grant. The reviewer classifies causal
claims as `confirmed`, `suspected`, `inconclusive` or `refuted`; missing data
is recorded as an evidence gap, and only normalized evidence and provenance are
stored. The pack never executes mutations: recommended actions enter Core's
remediation lifecycle (proposal decision, allow-listed adapter, immutable plan
hash, approval of that exact plan, a separate remediation bundle, post-change
monitoring). Native alert rules can optionally start an automatic read-only
investigation, capped by `NATIVE_ALERT_AIOPS_MAX_CONCURRENT` (default 3). See
[packs/argus-aiops/README.md](../packs/argus-aiops/README.md) and
[docs/architecture/argus-aiops-kubernetes.md](architecture/argus-aiops-kubernetes.md).

**Argus Hermes** (`packs/argus-hermes`, manifest `0.1.0`) is a runtime bridge,
not an MCP backend: no A2A agents, one adapter `hermes-http` with `attached`
and `managed` modes. Attached mode performs a pinned handshake against the
Hermes API and reports degraded on a different release or incompatible
capability shape. Only `/healthz` is unauthenticated; all other endpoints
require the discovery bearer token. The Hermes API key is mounted only into the
pack and is never returned to Core or the browser. See
[packs/argus-hermes/README.md](../packs/argus-hermes/README.md).

| Pack | Container port | Default host port | Discovery token in default overlay |
|---|---|---|---|
| `argus.dev` | 2025 | 2026 | not configured |
| `argus.aiops` | 2030 | 2030 | not configured |
| `argus.hermes` | 2040 | 2040 (bound to `127.0.0.1`) | required |

A pack started without a discovery token accepts unauthenticated discovery
requests. For production, give every pack its own token file and mount it into
both Core and the pack.

## Building and running the packs

### Installer (recommended)

```bash
docker compose -f compose.install.yml run --rm --build install optimal
```

The `optimal` and `everything` profiles build the three pack images from
`packs/`, generate the Hermes discovery token and API key under the git-ignored
`secrets/` directory, and start Core with `deploy/compose/packs/compose.external-pack.yml`,
`deploy/compose/packs/compose.hermes-attached.yml` and `deploy/compose/packs/compose.hermes-local.yml` (a local Hermes
upstream). `everything` additionally starts local Ollama/LiteLLM model serving
and further optional profiles. `minimal` starts Core, PostgreSQL and Redis
without packs. See [docs/INSTALLATION.md](INSTALLATION.md).

### Manual Compose

```bash
docker build -t argus-dev:local packs/argus-dev
docker build -t argus-aiops:local packs/argus-aiops
docker build -t argus-hermes:local packs/argus-hermes

mkdir -p secrets
openssl rand -hex 32 > secrets/argus-hermes-discovery-token
# .env: ARGUS_HERMES_DISCOVERY_TOKEN_FILE=./secrets/argus-hermes-discovery-token

docker compose -f docker-compose.yml -f deploy/compose/packs/compose.external-pack.yml up -d --wait
```

Each pack Dockerfile runs the pack's tests and build in a builder stage and
produces an unprivileged Node.js runtime image. Image names can be overridden
with `ARGUS_DEV_IMAGE`, `ARGUS_AIOPS_IMAGE` and `ARGUS_HERMES_IMAGE`.

About `deploy/compose/packs/compose.external-pack.yml`:

- It points Core at the three packs; Core's `LANGGRAPH_URL` targets the
  `argus-dev` container, so Argus Dev owns the LangGraph service identity.
- The Hermes discovery token is a Docker secret mounted read-only only into
  `mcp-server` and `argus-hermes` at `/run/secrets/argus-hermes-discovery-token`.
  It never appears in an environment variable, command line or Compose log.
- A custom `ARGUS_SOLUTION_PACK_TOKEN_FILES` must keep the entry
  `argus.hermes=/run/secrets/argus-hermes-discovery-token`, and every listed
  path must actually be mounted into `mcp-server`.
- Each pack advertises its Core-reachable origin (`ARGUS_A2A_PUBLIC_URL`,
  `ARGUS_AIOPS_A2A_PUBLIC_URL`, `ARGUS_HERMES_PUBLIC_URL`). It must match the
  configured endpoint, otherwise Core rejects the agent card.
- Managed Hermes variables default to empty, so managed runs stay disabled.

To attach an existing Hermes service, add `deploy/compose/packs/compose.hermes-attached.yml` with a
separate API key file. Never reuse the discovery token as the Hermes API key:

```bash
export HERMES_BASE_URL=http://host.docker.internal:8000
export ARGUS_HERMES_API_KEY_SOURCE_FILE=./secrets/hermes-api-key
docker compose -f docker-compose.yml -f deploy/compose/packs/compose.external-pack.yml \
  -f deploy/compose/packs/compose.hermes-attached.yml up -d --build --wait
```

`HERMES_BASE_URL` must be reachable from the pack container; for a service on
the Docker host use `host.docker.internal`, not `localhost`.

Each pack can also be developed on its own (`npm ci`, `npm test`,
`npm run build`) with its standalone `docker-compose.yml`. Health and manifest
discovery work without Core; executing a workflow requires a reachable Core,
configured agents and bundles, and a valid execution grant.

## Related documents

[README.md](../README.md) · [docs/ARCHITECTURE.md](ARCHITECTURE.md) ·
[docs/INSTALLATION.md](INSTALLATION.md) · [docs/THREAT_MODEL.md](THREAT_MODEL.md) ·
[SECURITY.md](../SECURITY.md)
