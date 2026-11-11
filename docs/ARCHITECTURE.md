# Argus Core Architecture

> Status: pre-1.0. Interfaces, schema and configuration still change between
> commits. This document describes the current code in this repository; the
> source, tests and migrations are authoritative where they differ.

Argus Core is a self-hosted control plane for governed AI agents, Model Context
Protocol (MCP) backends and independently deployable Solution Packs. It runs on
Docker Compose; the services are plain containers that can also be deployed to
Kubernetes.

For installation see [INSTALLATION.md](./INSTALLATION.md), for the Core/Pack
contract [ARGUS_CORE_AND_SOLUTION_PACKS.md](./ARGUS_CORE_AND_SOLUTION_PACKS.md),
and for the security analysis [THREAT_MODEL.md](./THREAT_MODEL.md).

---

## 1. System overview

The Core process (`mcp-server` service, port 3000) combines three areas:

1. **MCP Fabric** - registers MCP and HTTP backends, discovers their tools and
   exposes them through permissioned **Bundles** over Streamable HTTP (`/mcp`).
2. **Agent runtime** - agents with system prompt, skills, RAG, optional memory
   and tools. Model calls go directly to OpenAI, Anthropic or an
   OpenAI-compatible endpoint, or to a Core-managed subscription runtime.
3. **Workflow runtime** - persistent workflows with triggers, human approval
   gates and a visual builder.

Domain workflows that do not belong in Core run in separate **Solution Pack**
containers that Core discovers, authorizes and observes.

```text
                 Browser (Console, Chat)  ·  API clients  ·  MCP clients
                                    │
          ┌─────────────────────────▼──────────────────────────────┐
          │                   Argus Core :3000                      │
          │  HTTP layer: sessions · OIDC/Entra SSO · API keys       │
          │              OAuth2 bearer · execution grants · CSRF    │
          │              rate limiting (Redis sliding window)       │
          │  ┌────────────┐ ┌──────────┐ ┌───────────┐ ┌─────────┐  │
          │  │ MCP Fabric │ │  Agents  │ │ Workflows │ │ Packs   │  │
          │  │ /mcp/*     │ │ RAG/Mem. │ │ approvals │ │ registry│  │
          │  └─────┬──────┘ └────┬─────┘ └─────┬─────┘ └────┬────┘  │
          │  identity · RBAC · credentials · audit · observability │
          └────────┼─────────────┼─────────────┼────────────┼──────┘
                   │             │             │            │ A2A + signed grant
        ┌──────────▼───┐  ┌──────▼──────┐  ┌───▼────────┐  ┌▼──────────────────┐
        │ MCP / HTTP   │  │ LLM provider│  │ PostgreSQL │  │ Solution Packs    │
        │ backends     │  │ or runtime  │  │ (pgvector) │  │ argus-dev  :2025  │
        │ Git, CI, K8s,│  │ profile     │  │ Redis      │  │ argus-aiops:2030  │
        │ observability│  └─────────────┘  └────────────┘  │ argus-hermes:2040 │
        └──────────────┘                                   └─────────┬─────────┘
                                                                     │ governed calls
                                          agent-workspace :3001 ◄────┘
                                          (internal sandbox)
```

## 2. Repository layout

| Path | Content |
|---|---|
| `src/` | Core server (Express, TypeScript). Entry point `src/index.ts` |
| `argus-console/` | React/Vite console SPA (`/home`, `/mcp-fabric`, `/runs`, `/observe/*`, `/solutions/*`) |
| `argus-chat-ui/` | Chat SPA served by Core |
| `workflow-builder/` | Visual workflow builder (derived from Sim Studio, see `NOTICE`) |
| `agent-workspace/` | Internal sandbox service for repository, shell and subscription-runtime work |
| `db/migrations/` | Append-only numbered SQL migrations, applied at Core start |
| `docker-compose.yml` | Core stack: PostgreSQL, Redis, Core, agent-workspace, optional services |
| `deploy/compose/packs/compose.external-pack.yml` | Overlay that adds the Solution Pack containers |
| `packs/argus-dev/` | Development workflows (LangGraph state machines) |
| `packs/argus-aiops/` | Evidence-first incident investigation |
| `packs/argus-hermes/` | Hermes runtime bridge (attached and managed modes) |

Each pack is a separately versioned Node.js service with its own Dockerfile,
tests and standalone Compose file.

## 3. Core and Solution Packs

Core is the only authority for identity, permissions, credentials, approvals
and audit. Packs own their domain workflow, state machine and task data. They
do not own provider credentials, model assignments, authorization policy,
approvals or final mutation authority. A Pack declares the agents, skills,
capabilities, Bundles, knowledge sources, policies, dashboards and readiness
tests it needs; Core decides whether and how those are satisfied.

## 4. Deployment topology

`docker-compose.yml` starts the Core stack:

| Service | Image / build | Purpose |
|---|---|---|
| `mcp-server` | `Dockerfile` (multi-stage, `node:20-alpine`, runs as `node`) | Argus Core on port 3000 |
| `postgres` | `pgvector/pgvector:pg16` | Main database, sessions, vectors, audit |
| `redis` | `redis:7-alpine` | Distributed rate-limit state and caches |
| `agent-workspace` | `./agent-workspace` | Internal sandbox (port 3001, not published) |
| `agent-workspace-db` | `postgres:18-alpine` on tmpfs | Disposable database for repository tests |
| `tei-reranker` | Hugging Face TEI (CPU) | Optional cross-encoder for RAG reranking |

Optional Compose profiles add a local LLM gateway (`llm-gateway`, `local-llm`),
a local Gitea lab (`dev-demo`) and a Presidio PII analyzer (`pii`).

`deploy/compose/packs/compose.external-pack.yml` adds `argus-dev`, `argus-aiops` and `argus-hermes`,
sets `ARGUS_SOLUTION_PACK_ENDPOINTS` to their internal URLs and mounts the
Hermes discovery token as a read-only Docker secret. Build the pack images from
`packs/*` first, then run
`docker compose -f docker-compose.yml -f deploy/compose/packs/compose.external-pack.yml up -d`.

## 5. Request lifecycle: agent chat

A call to `POST /api/agents/:id/chat`:

```text
1. helmet (CSP, HSTS in production, frame and referrer policy), JSON body parser
2. session middleware               (argus_session cookie -> mcp_sessions)
3. OAuth2 bearer middleware         (JWT -> enabled Argus user, if enabled)
4. execution-grant middleware       (Bearer eg_v1.* from Solution Packs)
5. API-key middleware               (env or DB key, rate limit per key)
6. requireAuthOrApiKey + agent visibility check
7. agent handler:
     a. load agent, model and runtime profile
     b. resolve allowed tools: principal ∩ key policy ∩ agent Bundles ∩ grant
     c. assemble system prompt (agent prompt + skills)
     d. optional RAG retrieval and memory retrieval
     e. resolve provider/runtime and credential (section 6)
     f. tool loop up to max_iterations:
          model returns tool calls -> hooks/guards -> executeTool()
          (dynamic HTTP tool or remote MCP) -> result back to the model
     g. persist messages, usage, cost, trace spans and audit entries
```

Agent modes (`mcp_agents.agent_mode`): `chat` (interactive), `worker`
(autonomous task execution) and `reviewer` (read-only, structured review
output). Tool results and model output are treated as untrusted data; the
tool name, Bundle and resource scope are re-validated immediately before
dispatch. Built-in hooks cover human approval gates, user policy, destructive
command and production-cluster guards, cost budgets and PII pre-write checks.

## 6. Models, runtimes and credentials

Agents reference a model from the catalog (`mcp_models`,
`mcp_llm_providers`) and optionally a runtime profile. Supported provider
types are `openai`, `anthropic` and `openai-compatible`. Runtime profiles
(`argus`, `codex`, `claude-code`, `hermes`) select where the agent loop runs;
Codex and Claude Code subscription runtimes execute inside `agent-workspace`
with their own persistent auth volumes, started by an administrator from the
console.

```text
Agent run
  -> resolve model, provider and runtime profile
  -> resolve credential:
       agent credential profile
       -> per-agent key (only with DIRECT_AGENT_API_KEYS=true)
       -> provider credential profile
       -> provider inline secret (encrypted) or environment/Vault reference
  -> apply tool/RAG context and redaction
  -> call the provider directly, stream tokens
  -> persist usage, cost and audit
```

Argus does not expose an OpenAI-compatible `/v1/*` proxy. Workflows reference
logical agent roles and cannot silently switch provider, runtime, identity or
permissions.

**Agent memory** (`mcp_agent_memory`, pgvector) is off by default
(`ARGUS_AGENT_MEMORY_AUTO_ENABLED=false`) because it needs an embedding
provider; subscription runtimes do not provide embeddings. When enabled,
relevant memories (cosine similarity threshold 0.72) are injected before the
model call and new facts are extracted after the turn.

**RAG**: the built-in provider is pgvector; Qdrant, Azure AI Search,
OpenSearch, Elasticsearch, Weaviate, Pinecone and Milvus are available behind
the same index contract. Reranking can use the local TEI service, Cohere or
Voyage.

## 7. MCP Fabric

| Endpoint | Scope |
|---|---|
| `POST/GET/DELETE /mcp` | All tools the authenticated principal may use |
| `/mcp/group/:bundleName` | Tools of one Bundle |
| `/mcp/:backendName` | Tools of one backend |
| `/mcp/runtime/:leaseId` | Per-run lease for managed Pack runtimes |
| `/mcp/hermes-dev` | Credential-guarded bridge for Hermes development connections |
| `/sse`, `/sse/message` | Legacy SSE transport |

- **Backends** (`mcp_backends`, types `http`, `mcp`, `builtin`) hold base URL
  and encrypted authentication. Remote MCP backends are connected over
  Streamable HTTP and their tool catalog is discovered and stored.
- **Catalog trust**: a remote MCP server whose tool catalog changes is marked
  `changed` or `quarantined` and its tools are blocked until an administrator
  reviews the catalog.
- **Dynamic tools** (`mcp_tools`) render a `query_template` with declared
  parameters against a backend and are reloaded periodically
  (`DYNAMIC_TOOLS_POLL_INTERVAL_SEC`, default 30 s).
- **Templates** (`src/templates/`) create a backend and its tools in one step.
- **Bundles** group backends and tools and carry per-Bundle tool allowlists.
  Users, groups, API keys, agents and execution grants are scoped to Bundles.

**MCP session binding**: an MCP session fixes its tool filter at
initialization. Every later request on that session must come from the same
credential, and a fingerprint of the credential's current policy (key prefix,
tenant/workspace, Bundles, allowed/denied tools, role and groups) must still
match. A narrowed scope invalidates the session; a request without an
identifiable credential is rejected.

**Outbound requests** to backends pass an SSRF guard: the target is resolved
via DNS and every address is checked against CIDR block lists (loopback,
RFC 1918, CGNAT, link-local/metadata, reserved and multicast ranges,
unique-local and link-local IPv6). IPv4-mapped and other IPv6 spellings are
matched against the IPv4 rules; NAT64, 6to4 and Teredo prefixes are blocked as
a whole. Backend HTTP calls do not follow redirects automatically. Cluster service names must be listed explicitly in
`SSRF_ALLOWLIST_HOSTS`; `ARGUS_EGRESS_ALLOWLIST` optionally restricts outbound
hosts further.

## 8. Solution Pack integration

**Discovery.** `ARGUS_SOLUTION_PACK_ENDPOINTS` maps pack IDs to internal
origins (for example `argus.dev=http://argus-dev:2025`). Endpoints must be
plain origins without credentials, path, query or fragment; plain HTTP is only
accepted for loopback, private or cluster-local hosts, and metadata or
link-local addresses are rejected. Optional bearer tokens are read from files
(`ARGUS_SOLUTION_PACK_TOKEN_FILES`), never from inline values.

Core fetches `/.well-known/argus-solution-pack.yaml` and validates it strictly
(`apiVersion: argus.eu/v1alpha1`, `kind: SolutionPack`): pack identity, semantic
version, required Core version, required capabilities and credentials, and
declared components (agents, runtime adapters, skills, Bundles, workflows,
knowledge sources, dashboards, policies, readiness smoke tests). Service paths
in the manifest must be relative, without traversal or encoded separators.
Core then probes the declared health and readiness paths. The resulting state
is `ready`, `degraded`, `unreachable`, `invalid` or `incompatible`; discovery
refreshes periodically (`ARGUS_SOLUTION_PACK_REFRESH_SEC`). Endpoint and token
configuration always come from the environment; PostgreSQL stores installation
state and evidence.

**Invocation.** Core starts Pack work over A2A (HTTP+JSON binding) after
validating the user, the required Bundle capabilities and the execution target.
It issues a short-lived, HMAC-signed **execution grant** (`eg_v1`, at most one
hour, revocable) that names the exact Core agents, Bundle/tool scope,
tenant/workspace and resource scope. Packs call back into Core
(`/api/agents/:id/chat` and related endpoints) with that grant. The grant is
not a general API credential: a Pack may narrow its tool scope per worker but
never widen it.

**Runtime adapters.** A Pack may declare runtime adapters
(`argus-runtime-v1alpha1`, modes `attached` and `managed`). Core inventories
them but never executes code from a manifest. Managed runs receive a per-run
MCP lease (`/mcp/runtime/:leaseId`) bound to one grant, agent, run and trace.

**Trace correlation.** Packs pass the workflow root trace ID. Cross-process
trace parentage is only accepted from trusted internal callers, so public API
callers cannot forge a trace hierarchy.

## 9. Argus Dev (`packs/argus-dev`)

Argus Dev owns LangGraph state machines for software delivery. Its workflow
catalog includes `ticket-to-pull-request`, `pull-request-review`,
`ci-failure-recovery`, `security-remediation`, `release-notes` and
`backlog-grooming`. It persists threads, runs, A2A tasks, LangGraph checkpoints
and CI correlation data in PostgreSQL and reconciles unfinished tasks after a
restart. Approval and CI waits are durable, not process-local timers. The
runtime design is described in
[argus-langgraph-runtime.md](./architecture/argus-langgraph-runtime.md).

Main path of `ticket-to-pull-request` (optional stages such as code
generation, test design, QA and technical investigation are configuration-
dependent and omitted here):

```text
setup_workspace        clone/reset repository in agent-workspace
      │
   planner             logical role -> Core agent
      │
  knowledge            patterns, APIs, RAG
      │
    coder              writes through governed workspace tools
      │
    tests ──fail+retry──► coder        (bounded; FAIL at limit -> END)
      │ pass
   reviewer ─rejected+retry─► coder    (MAX_REVIEW_RETRIES)
      │ approved
human_approval         stage 1: code approval (interrupt)
      │
finalize_build         branch, commit, push
      │
 external_ci           wait for the provider CI result (callback)
      │
human_approval_pr      stage 2: functional approval (interrupt)
      │
 finalize_pr           provider adapter creates the pull request
```

The two gates are deliberately separate: "the diff looks right" is not the
same as "the feature works in a test environment". Each logical role (planner,
knowledge, coder, reviewer) is mapped to a model and runtime in Core only.
Repository and CI access arrive through Core Bundles; external CI remains
provider-owned (GitHub Actions, Gitea Actions, GitLab CI, Jenkins).

## 10. Argus AIOps and Argus Hermes

**Argus AIOps** (`packs/argus-aiops`) implements `incident-investigation`:
scoped read-only evidence collection (metrics, logs, traces, Kubernetes) by a
researcher agent, runbook and history lookup by a knowledge agent, and causal
claim validation by a reviewer that classifies findings as confirmed,
suspected, inconclusive or refuted. The Pack never receives a write connector.
Remediation is a Core lifecycle: persisted proposal, human decision,
allowlisted adapter, immutable plan with plan hash, approval of that exact
hash, dispatch through a separate remediation Bundle and post-change
monitoring. See [argus-aiops-kubernetes.md](./architecture/argus-aiops-kubernetes.md).

**Argus Hermes** (`packs/argus-hermes`) bridges Hermes agents. *Attached* mode
connects an existing Hermes service after a pinned version/capability
handshake; it is marked external and never receives MCP leases or Fabric
credentials. *Managed* mode provisions an isolated runner per run that reaches
Core only through a per-run MCP auth proxy holding a short-lived lease. Managed
mode is unavailable until an operator deploys and configures the separate
runner broker. All non-health Pack endpoints require the discovery token.

## 11. Security

### 11.1 Authentication

| Method | Used by | Details |
|---|---|---|
| Browser session | Console, chat | `argus_session` cookie: HttpOnly, SameSite=Lax, Secure in production; server-side session rows |
| Local login | Bootstrap, emergency admin | Rate limited per IP, account lockout; can be disabled when SSO is active |
| OIDC / Entra ID SSO | Workforce login | Authorization Code + PKCE (S256) + nonce, HMAC-signed short-lived state, one-time browser-binding cookie; IdP groups map to Argus roles |
| API keys (env `MCP_API_KEYS`) | Service-to-service | `Authorization: Bearer`, `X-API-Key` or `api_key` query parameter |
| API keys (DB) | Per-user / technical keys | `ak_` prefix, stored as SHA-256 hash; role, Bundle/tool scope, optional bound user |
| OAuth2 bearer JWT | External clients | Issuer and audience are mandatory; the subject must map to an enabled Argus user |
| Execution grant | Solution Packs | Signed `eg_v1` token, exact agent/Bundle/resource scope |

Entra ID and generic OIDC are mutually exclusive. Sensitive operations (for
example audit evidence export) can require a fresh MFA step-up based on signed
`amr`/`acr` claims. Setup: [oidc-sso-setup.md](./oidc-sso-setup.md),
[entra-sso-setup.md](./entra-sso-setup.md).

### 11.2 Authorization

RBAC uses six inherited roles: `platform_admin` ⊇ `operations_admin` ⊇
`developer` ⊇ `agent_operator` ⊇ `viewer` ⊇ `chat_user`, refined by
user/group policies, Bundle assignments and tenant/workspace scopes. Tool
authorization is evaluated at execution time:

```text
principal scope ∩ API-key policy ∩ agent Bundles ∩ execution grant
                ∩ backend trust ∩ Bundle tool allowlist
```

Session-authenticated mutations additionally pass `requireSameOrigin`
(Origin/Referer must match Host) as CSRF defense.

### 11.3 Secrets at rest

Sensitive columns (provider and credential-profile keys, per-agent override
keys, RAG provider keys, backend authentication values and header secrets,
guardrail HMAC secrets, upstream OAuth tokens) are encrypted field by field
with AES-256-GCM (`enc:v1:` prefix, `DB_ENCRYPTION_KEY`). During key rotation
`OLD_DB_ENCRYPTION_KEY` serves as a fallback and
`POST /api/admin/encryption/rotate` re-encrypts stored values. Credentials can
also be referenced from the environment or Vault instead of being stored.

### 11.4 Rate limits

| Limiter | Default |
|---|---|
| API key | `RATE_LIMIT_PER_MINUTE=120` |
| Login and registration | 10 per minute per IP |
| Admin mutations | 30 per minute per user |

The limiter uses an atomic Lua sliding window on Redis ZSETs across replicas
and falls back to an in-process limiter (accurate for a single replica) when
Redis is unavailable.

### 11.5 Audit

- `mcp_audit_log` records logins, administrative changes, key lifecycle and
  model changes with sensitive fields redacted (retention
  `AUDIT_LOG_RETENTION_DAYS`, default 90).
- **Canonical audit events** (`mcp_canonical_audit_events`) are hash-chained
  per scope (each event stores the previous hash). With
  `ARGUS_AUDIT_EVIDENCE_V1_ENABLED=true` and a configured signing key, Core
  writes Ed25519-signed checkpoints over the chain, monitors integrity, and
  supports retention policies, legal hold, scheduled reports and
  offline-verifiable evidence packs. An external anchor provider can be
  configured optionally.

These mechanisms support audit and governance work; they do not by themselves
establish compliance with any regulation. See [GOVERNANCE.md](./GOVERNANCE.md).

### 11.6 Workspace sandbox

`agent-workspace` is the only place where agents execute shell and Git
commands. It is reachable only on the internal Compose network, requires the
`X-Workspace-Secret` header (compared in constant time, at least 16
characters), drops all Linux capabilities and sets `no-new-privileges`. Its
`/workspace` volume holds repository clones. Repository tests use the
disposable `agent-workspace-db`, which runs on tmpfs with no credentials and is
wiped on restart.

## 12. Observability

| Source | Content | Location |
|---|---|---|
| Native observability | Runs, trace families, spans, cost, feedback | PostgreSQL `mcp_observability_*`, console `/runs`, `/observe/*` |
| Langfuse | Optional external trace/score sink | `LANGFUSE_HOST`, not required |
| OpenTelemetry | Application tracing | `OTEL_EXPORTER_OTLP_ENDPOINT` |
| Logs | Structured JSON (pino) | stdout, log routes in the console |
| Prometheus | `/metrics` | Local callers, API key or admin session only |
| Health | `/health` (liveness), `/ready` | Compose healthcheck / probes |

Pack workflows appear as root traces; the agent runs they trigger, including
their RAG, LLM and tool spans, are correlated into the same trace family and
can be viewed hierarchically or as a waterfall. Approval decisions are stored
in the audit trail and as feedback on the root trace. Sensitive keys and PII
are redacted before telemetry is persisted.

## 13. State and persistence

```text
PostgreSQL (Core)
├── mcp_agents, mcp_tools, mcp_backends,
│   mcp_service_bundles                              configuration
├── mcp_users, mcp_sessions, mcp_api_keys            identity and RBAC
├── mcp_agent_sessions                               chat history
├── mcp_agent_memory, mcp_rag_indexes                memory and knowledge
├── mcp_workflows, mcp_workflow_executions,
│   mcp_workflow_approvals                           workflow runtime
├── mcp_observability_*                              traces, spans, feedback
└── mcp_audit_log, mcp_canonical_audit_*             audit and evidence

PostgreSQL (Pack-owned tables)                       threads, A2A tasks, checkpoints
Redis                                                rate-limit windows, caches
agent-workspace volume                               /workspace repository clones
```

Migrations in `db/migrations/` are append-only and run at Core start; a failed
migration aborts startup. After a restart, Core reloads sessions and
configuration from PostgreSQL, Packs resume from their durable checkpoints,
Redis windows simply expire, and the tmpfs test database starts empty.

## 14. Kubernetes considerations

The Compose services map to ordinary Kubernetes objects: Core and Packs as
Deployments, PostgreSQL (pgvector) as a StatefulSet or managed database,
`agent-workspace` with a persistent volume for `/workspace`, secrets as mounted
files, and `/health` / `/ready` as probes. Pack endpoints may use cluster-local
service names (`*.svc.cluster.local`). Without Redis, rate limiting is only
accurate per replica.

See also [README.md](../README.md) and, for vulnerability reporting,
[SECURITY.md](../SECURITY.md).
