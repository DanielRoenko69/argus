# Installing Argus

This guide installs Argus on a single machine for evaluation and development.

| Profile | Includes | Best for |
|---|---|---|
| `minimal` | Core (Console, API, MCP gateway), PostgreSQL/pgvector, Redis | UI, API, policy and control-plane work |
| `optimal` (default) | Minimal + Agent Workspace + Argus Dev, Argus AIOps and Argus Hermes from `packs/` | End-to-end development workflows and incident investigation |
| `everything` | Optimal + local Ollama/LiteLLM, Presidio PII analysis and the public-widget demo | Offline models, demos and integration testing |

## Prerequisites

- Docker Desktop (Windows/macOS) or Docker Engine (Linux) with Compose v2,
  running Linux containers;
- Git;
- free Docker memory: about 4 GiB for `minimal`, 12 GiB or more for `optimal`,
  16 GiB or more for `everything`;
- Node.js 20+ only if you want to run tests or tools on the host.

Check:

```bash
docker version
docker compose version
```

## Install

```bash
git clone https://github.com/DanielRoenko69/argus.git argus
cd argus
docker compose -f compose.install.yml run --rm --build install            # optimal (default)
docker compose -f compose.install.yml run --rm --build install minimal    # Core only
docker compose -f compose.install.yml run --rm --build install everything # plus local models
```

The disposable `install` container:

1. checks the Docker engine;
2. creates `.env` from `.env.example` if it does not exist;
3. generates independent random values for database, session, encryption,
   MCP, workspace, execution-grant, webhook and widget secrets;
4. creates a machine-local Ed25519 key for signed audit evidence and passes it
   to Core through a read-only Docker volume;
5. for `optimal`/`everything`: creates Hermes discovery/API secrets (streamed
   into read-only Docker volumes, never into image layers) and builds the
   Solution Pack images from `packs/argus-dev`, `packs/argus-aiops` and
   `packs/argus-hermes`;
6. builds and starts the Compose project `argus-core`;
7. waits for health checks and runs the platform doctor.

After an `optimal` installation, connect a coding runtime (Codex or Claude
Code) or a model provider under **Settings → Providers & Models**, then open
**Argus Dev** or **Argus AIOps** in the Console. Start with read-only bundles
and verify traces before enabling write-capable tools.

The installer container receives `/var/run/docker.sock` for this one run, so
it temporarily controls the local Docker engine. Its implementation is small
and reviewable: `compose.install.yml`, `deploy/installer/Dockerfile`,
`scripts/docker-install.sh`, `deploy/compose/installer/compose.installer-hostpaths.yml`,
`deploy/compose/installer/compose.installer-audit.yml`. Never run the installer service in production
or expose the Docker socket to an application container.

Useful options:

```bash
# Inspect path detection without changing files or services
docker compose -f compose.install.yml run --rm --build install optimal --dry-run

# Restart without rebuilding existing local images
docker compose -f compose.install.yml run --rm install optimal --no-build
```

## First login

Open <http://localhost:3000>. On a fresh database the login page offers to
create the first account; that account becomes the platform administrator.
Use a strong password and, for anything beyond local evaluation, configure an
OIDC provider with MFA (see [oidc-sso-setup.md](oidc-sso-setup.md)).

A fresh installation contains no users. Its only pre-built skills are the
Workflow Copilot skills and one editable assessment checklist per compliance
framework (EU AI Act, NIS2, ISO/IEC 27001, DORA, SOC 2); the checklists support
an evidence review and are not legal advice. The Docker installer adds eight provider-neutral
starter agents (planner, coder, reviewer, knowledge, researcher, architect,
compliance auditor, workflow copilot). They are preconfigured for the local
LiteLLM/Ollama models that only the `everything` profile starts; with
`minimal` or `optimal`, assign a provider or runtime before using them. Next
steps in the Console:

1. **Settings → Providers & Models** — register a model provider or a
   subscription runtime profile. Credentials stay in Core and are never shown
   again.
2. **Agents** — assign a model or runtime to the starter agents you want to
   use, or create your own.
3. **MCP Fabric** — register MCP or HTTP backends, review their tool catalog
   and assign them to bundles. Start with read-only bundles.

## Verify

```bash
docker compose ps mcp-server postgres redis
curl http://localhost:3000/health
```

With Node.js on the host you can rerun the doctor:

```bash
npm ci
npm run doctor:local -- --core-only
```

| Component | URL |
|---|---|
| Console | <http://localhost:3000/home> |
| OpenAPI | <http://localhost:3000/docs> |
| Health | <http://localhost:3000/health> |

## Signed audit evidence

The installer enables canonical audit evidence automatically. For a manual
Compose setup, the Evidence API stays fail-closed until you provide a signing
key (never commit it):

```bash
npm run setup:audit-signing-key
docker compose -f docker-compose.yml -f deploy/compose/options/compose.audit-evidence.yml up -d --build mcp-server
```

Reports, checkpoints and restore records are evidence support, not a legal
certification. The Console exposes them under **Observe → Audit trail**.

## Update

Pull and rerun the installer with the same profile you installed:

```bash
git pull --ff-only
docker compose -f compose.install.yml run --rm --build install optimal
```

Database migrations run automatically when Core starts. The installer never
resets the repository, discards local changes or removes named volumes.

## Stop or remove

For `minimal`:

```bash
docker compose stop      # stop containers
docker compose down      # remove containers, keep data volumes
```

For `optimal`/`everything`, repeat the Solution Pack overlay files:

```bash
docker compose -f docker-compose.yml -f deploy/compose/packs/compose.external-pack.yml -f deploy/compose/packs/compose.hermes-attached.yml -f deploy/compose/packs/compose.hermes-local.yml stop
```

`docker compose down --volumes` also deletes the database and all local
state. Only use it when you really want a clean slate.

## Troubleshooting

- **Docker access denied** — make sure Docker Desktop/Engine is running and
  your user may access the Docker socket.
- **Port 3000, 5432 or 6379 already in use** — stop the conflicting service or
  another Argus stack first.
- **Core is unhealthy** — `docker compose logs --tail 200 mcp-server`.
- **A Solution Pack is missing in the Console** — check that its container is
  healthy (`docker compose -f docker-compose.yml -f deploy/compose/packs/compose.external-pack.yml ps`)
  and that `ARGUS_SOLUTION_PACK_ENDPOINTS` lists it.

## Security notes

- Never commit `.env`, `secrets/`, provider keys, OAuth state or runtime
  credential volumes.
- Set `NODE_ENV=production`, terminate TLS in front of Argus and use strong,
  unique secrets for any shared or internet-reachable deployment.
- Only the Console/API port (`PORT`, default 3000) listens on all network
  interfaces. PostgreSQL, Redis, LangGraph and the Solution Pack ports are
  bound to `127.0.0.1`. With `NODE_ENV=production` the session and sign-in
  cookies are `Secure`, so serve Argus over HTTPS whenever people reach it by
  any name other than `localhost`.
- See [SECURITY.md](../SECURITY.md) for the security model, known limitations
  and how to report vulnerabilities.
