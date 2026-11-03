# Argus-owned LangGraph Runtime

**Status:** Accepted and implemented  
**Date:** 2026-08-01

## Context

Argus previously ran `@langchain/langgraph-cli dev` as its LangGraph container.
LangChain documents that server as an in-memory development/test server. Its
supported production Agent Server requires a production license key; the
standalone deployment documentation also requires license verification and,
outside air-gapped operation, outbound usage reporting.

That deployment model conflicts with Argus' product goals:

- self-hosted and operable without a SaaS control plane,
- EU-governed and suitable for restricted networks,
- low-cost and vendor-neutral,
- open-source core with an independently licensable Argus product.

The workflow engine itself remains a good fit: the LangGraph repository is MIT
licensed, and its checkpointer API supports durable PostgreSQL checkpoints,
human interrupts and fault recovery.

Official references:

- [LangGraph repository and MIT license](https://github.com/langchain-ai/langgraph)
- [`langgraph dev` is an in-memory development server](https://docs.langchain.com/oss/javascript/langgraph/local-server)
- [Production Agent Server licensing](https://docs.langchain.com/langsmith/cli)
- [Standalone server license and egress requirements](https://docs.langchain.com/langsmith/deploy-standalone-server)
- [LangGraph persistence and fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/persistence)

## Decision

Production and normal local development use the Argus-owned runtime in
`packs/argus-dev/src/server.ts` directly on top of the MIT
`@langchain/langgraph` library. The LangGraph CLI is not part of the installed
Argus dependency graph. A developer can evaluate Studio in a separate,
explicitly managed tool environment without coupling it to the product image.

The public Argus API remains stable:

```text
Browser / API client
        |
        v
Argus /api/coding/*       authentication, RBAC, approval audit
        |
        v
Argus LangGraph runtime   internal secret, queue, state projection
        |
        +--> PostgreSQL   thread/run registry + LangGraph checkpoints
        |
        +--> Argus agents / agent-workspace
```

Only the internal compatibility surface needed by `src/api/coding.ts` is
implemented:

- `POST /assistants/search`
- `POST /threads` and `POST /threads/search`
- `GET /threads/:id` and `GET /threads/:id/state`
- `POST /threads/:id/runs`
- `DELETE /threads/:id`
- `GET /ok`

This is intentionally not a clone of LangSmith Agent Server.

## Persistence and recovery

LangGraph node state is stored by `PostgresSaver`. Argus adds two small runtime
registries:

- `argus_langgraph_threads`: graph, user-facing metadata, current status and
  last error,
- `argus_langgraph_runs`: durable queued/running request, base checkpoint and
  terminal result.

Run submission and thread state changes are transactional. A run records the
checkpoint that existed before submission. On process startup the runtime:

1. claims queued runs,
2. compares interrupted running runs with their base checkpoint,
3. replays a request that never advanced its checkpoint,
4. exposes a newer human interrupt without replaying the old decision,
5. marks an already-terminal checkpoint complete,
6. otherwise continues from the last durable superstep.

Checkpoint writes use synchronous durability. This prevents the runtime from
reporting a run as complete before its latest checkpoint has reached
PostgreSQL.

### Delivery boundary

Recovery is **at least once at the node boundary**, not globally exactly once.
If a process dies after an external side effect but before the next checkpoint,
that node can run again. Nodes that mutate Git, Kubernetes, ticket systems or
other external services therefore need an idempotency key or an equivalent
read-before-write guard. Human decisions and Argus governance audit rows remain
separate immutable control-plane records.

## Native cross-runtime telemetry

The LangGraph thread UUID is also the native workflow root-trace ID. The public
`/api/coding/*` control plane creates that root with the authenticated Argus
user before it starts a run. The runtime mirrors its durable lifecycle through
`POST /api/internal/telemetry/langgraph` and propagates the same root ID to
every Argus agent call. Agent traces therefore become children of the workflow
root, while their native RAG, LLM and tool spans remain attached to the agent
trace.

Cross-process parent headers are trusted only when all of these checks pass:

1. `X-Workspace-Secret` matches with timing-safe comparison,
2. root, parent trace and optional parent span IDs are valid UUIDs,
3. root and parent already exist in one persisted trace family.

Lifecycle delivery is best-effort and never makes a durable workflow fail.
The authenticated coding state endpoint reconciles terminal/waiting state as a
fallback. Human approvals are written both to the immutable approval audit and
to revision-aware native trace feedback. Telemetry inputs and feedback comments
pass Argus redaction before persistence.

## Security and operations

- `/ok` is unauthenticated for container health checks.
- Every other runtime route requires the timing-safe compared shared
  `X-Workspace-Secret` value.
- `/api/internal/telemetry/langgraph` and all `X-Argus-*` correlation headers
  are cluster-internal contracts and must not be exposed or injected by an
  ingress.
- Production startup fails closed when `WORKSPACE_SECRET` is absent.
- The service runs as the non-root `node` user in a multi-stage image.
- The production image contains runtime dependencies only; the TypeScript
  toolchain remains in the builder/development dependency set and the
  LangGraph CLI is not installed by Argus.
- Graceful shutdown stops accepting requests and gives active runs a bounded
  window to reach another checkpoint.

## Verification

`npm run test:e2e:local` performs three phases against a clean database (the
Node runner works directly from PowerShell, Git Bash and Unix shells):

1. full product Golden Path plus LangGraph reject/rework/approve,
2. Argus control-plane restart while native and LangGraph checkpoints wait,
3. LangGraph runtime restart while its human interrupt waits, followed by
   successful resume and approval-audit verification.

The Golden Path also asserts the native workflow/agent trace tree, RAG and
worker/reviewer LLM spans, secret redaction, approval feedback, human feedback
supersession and the complete Console journey from Observe to UUID Run Detail,
approval evidence and family-wide waterfall.

This certifies process restart at a human checkpoint. Crash injection during an
actively executing external side effect remains a separate resilience test.
