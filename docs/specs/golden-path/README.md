# Golden Path v1 contract

Status: contract-frozen; persisted preflight, idempotent run start and read model implemented and browser-certified.
Owner: Core. Consumer: Console.

## Purpose

The contract projects one Dev triage journey across Git issue ingestion, immutable
repository context, Hermes/native analysis, policy, approval, bounded external
outcomes and verifiable evidence. It is additive: existing Workflow, Run, A2A,
Audit and Compliance endpoints remain authoritative for their domains.

This read model exists so the Console does not reconstruct the journey from
unrelated API responses or duplicate authorization and policy decisions in the
browser.

## Fixtures

| Fixture | State | UI use |
|---|---|---|
| `preflight-ready.v1.fixture.json` | Certification dependencies are ready. | Enabled start action and explicit scope review. |
| `preflight-blocked.v1.fixture.json` | Live Slack target is not configured. | Blocking recovery state without a hidden fixture fallback. |
| `run-awaiting-approval.v1.fixture.json` | Analysis is complete and no write has occurred. | Approval/Reject view with hashes, exact targets and trace link. |
| `run-completed.v1.fixture.json` | All three writes and evidence are verified. | Success view with Trace, Report, Evidence, Dossier, WORM and Restore references. |

All fixtures are executable against `src/goldenPath/contracts.ts`. They are
presentation fixtures, not seeded credentials or production identifiers.

## Canonical stages

The order is stable in schema version 1:

1. `preflight`
2. `issue_ingestion`
3. `repository_context`
4. `dev_analysis`
5. `policy_decision`
6. `approval`
7. `external_action`
8. `evidence`

The Console may change labels and layout but must not infer a different order from
timestamps. New backend detail is added through resource references or a later
schema version.

## Provider modes

`certification` is deterministic and requires local Gitea plus the Slack protocol
fixture. `live_demo` requires GitHub plus Slack. Missing live credentials or a
missing provider must return a blocking `not_configured` check. Core never silently
switches a live demo to fixtures.

Hermes and native are runtime selections, not security authorities. Core freezes
the selected runtime profile and effective grant digest, while MCP Fabric still
enforces tools, credentials, tenant scope, approval and audit.

## Write boundary

Golden Path v1 permits only:

- a comment on the exact selected issue;
- adding an allowlisted label to that issue;
- one message to the exact selected Slack destination.

Repository content changes, branch creation, commits, pushes, pull requests,
issue creation/deletion, Slack channel discovery and arbitrary messages are out of
scope. Every permitted outcome has a digest-only idempotency key, provider receipt
and read-after-write verification state.

The default guarded mode pauses only before the external writes. A read-only policy
declares no writes and no runtime approval, so analysis does not inherit an
unnecessary gate.

## Scope and secrecy

Tenant, workspace, environment, Repository and notification targets are resolved
server-side. Browser input may select among authorized resources but cannot broaden
the frozen scope. The projection carries hashes and opaque references only. Raw
provider credentials, authorization headers, signing private keys and secrets are
forbidden.

Inaccessible resources must be omitted or returned through a non-enumerating
not-found response before the Golden Path read model is assembled.

## Evidence boundary

The completed projection links existing authoritative artifacts rather than copying
their full contents:

- distributed Trace;
- canonical Audit Report;
- signed Evidence Pack;
- optional AI compliance support dossier;
- optional WORM archive and independent restore receipts.

`complete` requires offline-verifiable, gap-free evidence. A completed journey with
known limitations must use `completed_with_gaps` and name those limitations. The
contract does not turn technical evidence into a legal certification.

## API surface

Core exposes server-derived equivalents of:

```text
GET  /api/ui/golden-path/v1/preflight?mode=certification|live_demo&writeMode=read_only|guarded
POST /api/ui/golden-path/v1/runs
GET  /api/ui/golden-path/v1/runs/:runId
```

Alle drei Endpoints sind implementiert. Der Preflight projiziert ausschließlich
serverseitig geladene Ist-Zustände. Er prüft die gespeicherte Workflow-Revision,
die Agent-Bindung und Zugriffspolitik, den live geprüften Runtime-Status,
workflowgebundene MCP Bundles, Argus-Dev-Discovery sowie die Evidence-Persistenz.
Er enthält keine Provider-Credentials.

Der Zertifizierungsmodus besitzt reproduzierbare lokale Zielvorgaben. Für
`live_demo` sind die folgenden nicht geheimen Ziel-IDs explizit zu setzen; es
gibt keinen stillen Fixture-Fallback:

- `ARGUS_GOLDEN_PATH_WORKFLOW_NAME` und `ARGUS_GOLDEN_PATH_AGENT_NAME`
- `ARGUS_GOLDEN_PATH_GIT_BUNDLE`, `ARGUS_GOLDEN_PATH_GIT_REPOSITORY`,
  `ARGUS_GOLDEN_PATH_ISSUE_NUMBER`, `ARGUS_GOLDEN_PATH_GIT_ORIGIN`
- `ARGUS_GOLDEN_PATH_NOTIFICATION_BUNDLE` und
  `ARGUS_GOLDEN_PATH_NOTIFICATION_DESTINATION`
- optional `ARGUS_GOLDEN_PATH_PREFERRED_RUNTIME` (`hermes` oder `native`) und
  `ARGUS_GOLDEN_PATH_RUNTIME_FALLBACK`

Tokens, Passwörter und API Keys verbleiben in den vorhandenen MCP-/Runtime-
Credential-Stores und dürfen nicht in diese Variablen geschrieben werden.

`POST /runs` akzeptiert ausschließlich `mode` und `writeMode`. Es verlangt
`workflows.run`, Same-Origin für Browseraufrufe und einen begrenzten
`Idempotency-Key`. Core friert den frischen Preflight ein, leitet Workflow-Inputs
und Ziel-IDs serverseitig ab und startet die normale Workflow-Engine inklusive
Agent-, MCP-, AI-Act-, Approval-, Telemetrie- und Audit-Grenzen. Der rohe Key wird
nie gespeichert; der Digest dedupliziert Wiederholungen stabil.

`GET /runs/:runId` verlangt `workflows.read` und projiziert Execution,
Runtime-Approval, Stages, erlaubte Outcomes und Resource-Links in den strikten
v1-Vertrag. Bis signierte Report-/Evidence-Artefakte gebunden sind, bleibt ein
fachlich abgeschlossener Run ehrlich `completed_with_gaps`.

Die ausführbaren Gates sind:

```bash
npm run certify:golden-path:contract
npm run certify:golden-path
```

Das schnelle Contract-Gate schreibt nach
`test-results/golden-path-contract.json`. Das fokussierte Docker-Gate startet eine
frische, isolierte E2E-Welt und schreibt nach
`test-results/golden-path-certification.json`. Es prüft Read-only, Start-Replay,
Approval, Reject, einen echten Argus-Neustart und das idempotente Resume des
persistierten Checkpoints. Fehler-Retry, Provider-Receipts und signierte
Evidence-Erzeugung bleiben eigene folgende Nachweise.

Die disposable E2E-Konfiguration bindet außerdem getrennte Gitea- und Slack-
Fixture-Bundles an eine echte gespeicherte Workflow-Revision. Der Browsertest
prüft beide Write-Modi gegen DB, RBAC, Runtime, Argus Dev und Evidence. Damit ist
`allowedActions: ["start", "refresh"]` serverseitig belegt. Der reale Lauf prüft
außerdem Start-Replay ohne zweite Execution und Guarded Pause → Approve → Resume.

Starting a run requires authentication, a named execute permission, same-origin
protection for browser calls and an idempotency key. Approval continues to use the
existing governed approval producer rather than a Golden-Path-specific bypass.

## Compatibility

- Schema version 1 is strict: unknown fields are rejected by the executable schema.
- Additive UI metadata should first be expressed through typed resource references.
- Breaking stage, status or security changes require schema version 2.
- The existing `/api/ui/runs/v2` remains the general Run list; this contract is a
  purpose-built journey projection.
