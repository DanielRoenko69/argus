# Argus.Hermes architecture

`argus.hermes` is a Solution Pack and runtime bridge. It is not an MCP Bundle.

```text
Argus Core
  ├─ identity, policies, approvals, audit and traces
  ├─ MCP Fabric bundles and short-lived runtime tool leases
  └─ Argus.Hermes Pack
       ├─ attached Hermes API connector
       ├─ managed Hermes runner (later)
       └─ HTTP/A2A event and approval bridge
```

## Modes

| Mode | Meaning | Trust label |
| --- | --- | --- |
| `attached` | Argus calls an existing Hermes API service and records its lifecycle evidence. Native Hermes tools remain outside Core enforcement. | External / attested |
| `managed` | The Pack creates an isolated Hermes profile or runner with only Core-issued tool access. | Argus managed |

The attached bridge is pinned to Hermes release `v2026.7.7.2` and verifies both `/health/detailed` and `/v1/capabilities` before exposing the attachment as ready:

- health reports `platform: "hermes-agent"` and package version `0.18.2`;
- capabilities report `object: "hermes.api_server.capabilities"` and `platform: "hermes-agent"`;
- `runtime.mode` is exactly `server_agent`;
- `runtime.tool_execution` is exactly `server`;
- `runtime.split_runtime` is exactly `false`.

The Pack does not accept a runtime MCP lease in `attached` mode. Hermes' remote MCP configuration is static at the service/profile level, so attaching a short-lived, per-run Core credential to an already-running external service would risk cross-run scope leakage. The attachment is therefore explicitly `External / attested`; only a future isolated `managed` runner may receive a Core-issued, bundle- and trace-bound lease.

With a separately mounted Hermes API key, Core administrators can use the
Pack's dedicated `/attached/runs` lifecycle for a bounded smoke run. The Pack
normalizes start, status and stop responses and rejects unsafe native IDs,
unknown lifecycle states, oversized output and malformed token usage. This is
an external-attested execution path, not an Argus-governed MCP execution path;
the UI requires an explicit trust acknowledgement before starting it.

## Managed runtime wire contract

The Pack already validates the versioned start envelope at:

```text
POST /runtime/v1/adapters/hermes-http/runs
```

It accepts only `mode: "managed"` with one opaque `eg_v1` execution grant,
one Core lease ID, one Run ID, one Root Trace ID and the bundle IDs selected by
Core. The grant is never written to Pack state, status, events or logs. The
future runner receives it only through a per-run 0600 secret file; it must not
use an environment-variable fallback.

Before any managed provisioner can be enabled, the operator must configure
`ARGUS_CORE_RUNTIME_MCP_ORIGIN` to the trusted internal Argus Core origin. The
lease URL is accepted only when it is credential-free, has no query or
fragment, uses that exact origin, and has exactly this path:

```text
/mcp/runtime/<leaseId>
```

This keeps a managed runner on a single Core-owned tool boundary rather than
letting a Pack caller direct it to an arbitrary HTTP endpoint. The current
health-only release keeps that origin optional only because it has no
provisioner; the provisioner must use the Pack's fail-closed configuration
guard and refuse to start when the origin is absent.

Until a separately deployed, authenticated `runnerd` broker passes startup
preflight, a valid managed request returns `409 MANAGED_RUNNER_NOT_PROVISIONED`.
This is deliberate: no request may fall back to an attached or globally
configured Hermes profile. A request that tries to attach a Core lease to
`mode: "attached"` returns
`409 ATTACHED_MCP_LEASE_UNSUPPORTED`.

When a provisioner exists, `202` means the Pack has durably **accepted** a
queued run. Its normalized response uses `acceptedAt` and `updatedAt` (and may
include an `eventCursor`); it must not use `startedAt`, because the native
Hermes process can begin later. A managed lease must contain one or more unique
positive Bundle IDs, matching the exact scopes issued by Core.

The Pack also reserves these managed lifecycle routes so Core and the Pack can
test their request boundary before a runner exists:

```text
GET  /runtime/v1/adapters/hermes-http/runs/<runId>
POST /runtime/v1/adapters/hermes-http/runs/<runId>/cancel
GET  /runtime/v1/adapters/hermes-http/runs/<runId>/events
```

`runId`, cancellation `requestId` and `rootTraceId` are strict UUIDs. The
cancellation body cannot contain an execution grant. Each valid request returns
the same `409 MANAGED_RUNNER_NOT_PROVISIONED` until a reviewed isolated
provisioner is injected; malformed requests return
`400 INVALID_RUNTIME_REQUEST`. The events endpoint deliberately returns JSON
`409`, not an empty SSE stream, so it cannot be mistaken for runtime evidence.

## Pack service credential

`/healthz` is the only unauthenticated route so orchestrators can determine
whether the process is alive. Every discovery, readiness, runtime status and
lifecycle endpoint requires the Pack service credential. If it is missing, the
Pack returns `503 SERVICE_CREDENTIAL_REQUIRED` rather than silently exposing
the control plane. Local Compose binds the debug port to loopback; production
mounts the same read-only credential into Argus Core and the Pack.

Capability discovery advertises `health`, plus `runs` and `cancel` only while
the pinned attached handshake and configured API key make attached execution
usable. `events-sse`, `approval`, `mcp-fabric`, and session continuity remain
managed-runtime contract surfaces rather than attached-mode claims.

## Managed runner control plane (fail-closed skeleton)

`runnerd` is now a standalone, **fail-closed control-plane skeleton**. It
provides authenticated internal `GET /v1/ready`, `POST /v1/runs`, `GET
/v1/runs/<runId>`, and `POST /v1/runs/<runId>/cancel` contract routes with a
durable redacted registry. Its default launcher is deliberately unavailable:
`GET /v1/ready` and every lifecycle route return `503
RUNNERD_NOT_PROVISIONED`. The Pack therefore still reports managed execution
as unavailable and returns `409 MANAGED_RUNNER_NOT_PROVISIONED` to Core.

The skeleton does not start, embed, or configure a privileged launcher. There
is no Docker socket mount, Docker CLI launcher, Kubernetes Job launcher, or
runtime-enabling environment switch in this release. A reviewed implementation
must be injected as a separately deployed and authenticated `runnerd`
launcher, using the same pinned internal contract. The launch payload is the
already validated managed-run envelope and contains no image, command, mount,
network, environment or host-control field. `runnerd` owns those
operator-pinned choices; the Pack must never receive a Docker socket or broad
cluster credentials.

The only secret-bearing payload is the one-time `eg_v1` grant. It goes directly
into a per-run `0600` proxy secret file, outside the Pack run-state record.
Hermes sees only the proxy's local `/mcp` URL and never receives the grant,
Core endpoint or proxy file. This proxy boundary is required: putting the
grant directly in Hermes' static MCP configuration would make it readable to
the same Hermes process that executes native file and terminal tools.

The `mcpAuthProxy` process accepts only MCP methods on `/mcp`, pins all traffic
to one `/mcp/runtime/<leaseId>` target, replaces caller authorization with the
secret-file grant, and filters request/response headers. It must share an
isolated network only with its corresponding Hermes runner and have no host
port. A future runnerd must start a fresh container/profile per Argus run,
configure only `argus_core` to that proxy URL, and destroy/revoke proxy,
secrets, network and runner before terminal completion. The response and all
later status/event surfaces contain only redacted run/trace evidence; they
never contain `eg_v1`, API keys, MCP headers or native profile paths.

V1 evidence is intentionally a compact machine-readable projection: safe
labels, counters, booleans and nulls only. Raw model/tool output, prompts,
instructions, diagnostics, free prose, URLs, `host:port` values and
secret-shaped field names are rejected by both runnerd and the Pack's durable
store. A future human-readable evidence feature requires its own reviewed
redaction and retention boundary.

Before `managed` can ever become ready, all of the following must be true for
the same upstream release:

1. `upstream/hermes-release-lock.json` records an immutable OCI
   `managedImageDigest`; a tag such as `latest` is never sufficient.
2. That digest has passed a reviewed managed-runner smoke suite against the
   pinned Hermes API contract, including start, normalized events, stop and
   terminal cleanup.
3. The smoke suite proves that the runner has no Docker socket, host mount,
   public port or unrestricted network; it also proves that the Hermes process
   cannot read the Core execution grant.
4. The operator has configured a trusted Core MCP origin and an approved model
   provider/egress path. The runner must not receive arbitrary model or MCP
   endpoints from a user request.

Until that evidence is recorded and a reviewed launcher is supplied, the
`runnerd` skeleton is only a contract boundary. It must not be represented as
a Docker Compose service, an enabled runtime type, or an attached-Hermes
fallback.

## Maintenance contract

The Pack is independently versioned from Core. Its machine-readable
[`upstream/hermes-release-lock.json`](../upstream/hermes-release-lock.json)
records the upstream release and is validated in CI. A Pack release records:

- Pack semantic version and supported Argus Core range;
- upstream Hermes version and OCI image digest;
- expected Hermes API capability set;
- migration notes and rollback image digest.

Updates move through `candidate` and `stable` channels. A scheduled workflow
only notifies maintainers about an upstream GitHub release; it never silently
pulls or deploys it. A maintainer updates `candidate`, validates the adapter
against a pinned upstream image, records an immutable digest, and then promotes
it to `stable` in a reviewable PR. A managed installation can then canary,
health-check and roll back without rebuilding Argus Core. An attached external
Hermes service is never modified by Argus; it is attested and flagged if its
version or capabilities are incompatible.
