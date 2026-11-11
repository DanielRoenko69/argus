# Compose overlays

The base stack stays in the repository root: `docker-compose.yml` (Core,
PostgreSQL, Redis, LangGraph) and `compose.install.yml` (the one-shot
installer). Everything here is an overlay or a separate test stack.

| Folder | Contents | Used by |
|---|---|---|
| `packs/` | Solution Packs (`compose.external-pack.yml`) and Hermes runtimes | installer `optimal`/`everything`, pack demos |
| `installer/` | host paths, audit signing key and Hermes secrets for installed stacks | `scripts/docker-install.sh` |
| `options/` | opt-in features: signed audit evidence, GPU, source-built workstation images, code-intelligence evaluation | manual setups |
| `demo/` | AIOps, MFA, WORM and backend-SSO demo stacks with **fixed, public demo credentials** | `npm run demo:*` |
| `e2e/` | disposable Docker/Playwright, HA and Golden Path certification stacks | `npm run test:e2e:local`, `npm run certify:golden-path`, CI |
| `pilot/` | experimental Argus Dev pilot overlays and the pilot recovery drill | maintainers only |

## Running overlays by hand

Always run Compose from the repository root and list `docker-compose.yml`
first. Relative paths in every file (build contexts, `./secrets`, `./db`) and
the `.env` lookup resolve against the project directory, which is the folder of
the first file:

```bash
docker compose -f docker-compose.yml \
  -f deploy/compose/packs/compose.external-pack.yml \
  -f deploy/compose/options/compose.audit-evidence.yml \
  up -d
```

The E2E stacks and the pilot recovery drill start without `docker-compose.yml`.
Pin the project directory to the root for them, as the npm scripts do:

```bash
docker compose -p argus-e2e --project-directory . \
  -f deploy/compose/e2e/compose.e2e.yml config --quiet
```

Prefer the installer (`docker compose -f compose.install.yml run --rm install`)
for real installations; it selects the right overlays for each profile.
