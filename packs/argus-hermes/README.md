# Argus.Hermes

Hermes integration for the Argus agent-operations platform.

`argus.hermes` is a separately versioned **Solution Pack** and runtime bridge.
It does not turn Hermes into an unrestricted MCP backend. Argus Core remains the
single authority for identity, MCP bundles, policies, approvals, audit, traces
and scoped credentials.

## What it supports

| Mode | Purpose | Governance boundary |
| --- | --- | --- |
| Attached Hermes | Connect an existing Hermes API service. | `External / attested`: the Hermes service and its native tools remain outside Argus governance. Attached mode never receives a Core MCP lease or Fabric credentials. |
| Managed Hermes | Provision an isolated Hermes runner/profile per run. | `Argus managed`: per-run MCP leases, isolated auth/profile state and Core-owned approval/tool policy. |

The attached vertical slice performs a **pinned v2026.7.7.2 handshake** against
`/health/detailed` and `/v1/capabilities`. That release reports Hermes package
version `0.18.2`; the API must also report
`runtime.mode = "server_agent"`, `runtime.tool_execution = "server"`, and
`runtime.split_runtime = false`. A different release, client-side tool
execution, a split runtime, malformed JSON, or an incompatible capability shape
fails closed as a degraded attachment.

When that handshake succeeds and `HERMES_API_KEY_FILE` is configured, an
authenticated Core administrator may start, poll and stop an attached Hermes
run through the fixed Pack adapter paths. The Pack bounds and normalizes the
native run ID, state, output and token usage. Browser callers never receive the
Hermes endpoint or API key and cannot override either value.

Attached mode is deliberately `External / attested`: it never receives a
Core-issued runtime MCP lease or Argus MCP Fabric credentials. The optional
**managed** runner is isolated per run and receives a short-lived, bundle- and
trace-scoped lease through its private auth proxy.

Attached execution endpoints are intentionally separate from managed runs:

```text
POST /runtime/v1/adapters/hermes-http/attached/runs
GET  /runtime/v1/adapters/hermes-http/attached/runs/<nativeRunId>
POST /runtime/v1/adapters/hermes-http/attached/runs/<nativeRunId>/stop
```

## Local development

```powershell
Copy-Item .env.example .env
npm install
npm run verify
npm run dev
```

Then inspect:

```text
GET http://localhost:2040/healthz
GET http://localhost:2040/.well-known/argus-solution-pack.yaml
GET http://localhost:2040/runtime/v1/adapters/hermes-http/status
```

Only `/healthz` is intentionally unauthenticated. Every other endpoint fails
closed with `503 SERVICE_CREDENTIAL_REQUIRED` until either
`ARGUS_PACK_DISCOVERY_TOKEN` (local development) or
`ARGUS_PACK_DISCOVERY_TOKEN_FILE` (production) is configured. After that,
Core must send the matching `Authorization: Bearer <token>` service
credential. Production deployments mount the same read-only secret into Core
and this Pack; never place it in a browser, a manifest, or a repository.

`docker-compose.yml` binds the local debug port to `127.0.0.1` by default.
Core reaches the Pack over the container network instead of the host port.

To connect an existing Hermes service, set `HERMES_BASE_URL` and preferably
`HERMES_API_KEY_FILE`. The API key is never returned, logged or stored in the
Pack manifest.

## Docker

```powershell
docker compose up --build
```

The Pack uses port `2040` by default. Core will later discover it through:

```text
ARGUS_SOLUTION_PACK_ENDPOINTS=argus.hermes=http://argus-hermes:2040
```

### Managed runner configuration

The Pack contains the managed-run lifecycle, broker protocol, and per-run MCP
auth proxy. It still remains **unavailable by default**: an operator must
deploy a separately privileged `runnerd` broker and explicitly configure:

```text
ARGUS_CORE_RUNTIME_MCP_ORIGIN=http://mcp-server:3000
ARGUS_HERMES_RUNNERD_URL=http://argus-hermes-runnerd:2050
ARGUS_HERMES_RUNNERD_TOKEN_FILE=/run/secrets/argus-hermes-runnerd-token
```

The Pack preflights the authenticated broker at startup and advertises managed
run capabilities only when it receives the pinned ready response. The Pack
never gets a Docker socket or Kubernetes credential. The broker chooses the
pinned image, command, network, mounts and resource limits; Core and the Pack
cannot supply those fields.

Core must set its trusted internal origin, for example
`http://mcp-server:3000`. The Pack accepts a runtime lease endpoint only when
it has no credentials, query or fragment and is exactly:

```text
${ARGUS_CORE_RUNTIME_MCP_ORIGIN}/mcp/runtime/<leaseId>
```

The Pack will not treat a caller-provided arbitrary HTTP URL as a runtime MCP
endpoint. A short-lived `eg_v1` grant crosses only the fixed, authenticated
Pack -> runnerd start request. `runnerd` must write it into a per-run `0600`
secret file mounted solely into the MCP auth-proxy container. The Hermes runner
gets only `http://argus-mcp-proxy:3002/mcp`, never the bearer, Core endpoint,
or a long-lived grant environment variable.

`start:mcp-proxy` is the runnerd-only entrypoint for that proxy. It accepts
only `POST`, `GET`, and `DELETE` on `/mcp`, pins every request to one exact
`/mcp/runtime/<leaseId>` URL, strips caller authorization, and forwards only a
small MCP header allow-list. It is meant to run on a private per-run network
with no host port. Production requires Linux secret-file permissions; the
proxy intentionally refuses normal Windows execution.

Managed-run lifecycle evidence is deliberately limited to compact,
machine-readable labels, counters and booleans. It rejects raw model/tool
output, prompts, free prose, URLs, `host:port` values and secret-shaped fields.
Human-readable evidence needs a separate redaction and retention design; it
must not be added by loosening the runner or Pack lifecycle contracts.

The Pack includes both the **fail-closed runnerd control plane** and an opt-in
Docker provisioner. The ordinary Pack image remains unprivileged and contains
no Docker CLI. Only the explicit `runnerd` Dockerfile target can be deployed
with engine authority, and it advertises ready only after immutable
Hermes/proxy images, operator networks and a separate managed-auth volume all
pass startup preflight. Without those policy/attestation files it stays
fail-closed with `MANAGED_RUNNER_NOT_PROVISIONED`:

```powershell
$env:ARGUS_HERMES_RUNNERD_TOKEN = '<operator-mounted service secret>'
$env:ARGUS_CORE_RUNTIME_MCP_ORIGIN = 'http://mcp-server:3000'
npm run build
npm run start:runnerd
```

It exposes only authenticated `GET /v1/ready`, `POST /v1/runs`, `GET
/v1/runs/<id>`, and `POST /v1/runs/<id>/cancel` (plus unauthenticated
`/healthz`). Core owns the local `deploy/compose/packs/compose.hermes-managed.yml` overlay plus the
setup/certification scripts. They pin repository-qualified immutable digests,
copy only Hermes `.env`/`auth.json` into a separate protected managed profile,
and approve one explicit read-only Bundle ID.

Managed Hermes runs non-root with a read-only root filesystem, no capabilities
or published ports. It sees only `http://argus-mcp-proxy:3002/mcp`; the proxy
alone receives the one-time grant in a `0600` tmpfs file and alone joins the
Core egress network. Provider/model are explicit policy, so `openai-codex` can
use the Hermes subscription directly without LiteLLM or API-key fallback. V1
caps concurrency at one run per managed auth profile and accepts only MCP-only
Core-approved read scopes. Raw final model output is not lifecycle evidence;
coding artifacts remain in the Argus-owned workspace/tool boundary.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the ownership boundary,
maintenance channels and the planned runtime contract.

## Upstream maintenance

The Pack tracks Hermes releases in
[`upstream/hermes-release-lock.json`](upstream/hermes-release-lock.json).
GitHub Actions checks upstream weekly and informs maintainers when a newer
release exists. It does not auto-update a customer installation.

The safe update path is:

1. update the `candidate` release reference;
2. test the Hermes API contract and, later, its managed-runner image;
3. record an immutable OCI digest and rollback reference;
4. promote the same tested release to `stable` in a reviewed pull request;
5. canary the Pack in Argus before a fleet rollout.
