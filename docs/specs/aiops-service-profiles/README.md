# AIOps Service Profiles v1

Status: implemented; live multi-service routing, deterministic correlation, provider-signal ingestion, fail-closed readiness and Core outcome projection
Owner: Core
Requirement families: `AIOPS-PROFILE`, `AIOPS-READY`, `AIOPS-RUN`,
`AIOPS-OUTCOME`

## Purpose

An AIOps Service Profile binds one logical `service + environment` identity to
the exact MCP Fabric evidence, selectors, detection rules, knowledge and
remediation policy that apply to that service.

It is configuration for the shared AIOps Agent workflow, not another Agent or
separately trained model. Profile revisions are immutable once created. Every
investigation captures the exact revision and SHA-256 digest used at start.

The executable Zod contract is implemented in
`src/observability/aiopsServiceProfileContracts.ts`.

## Fixtures

| Fixture | Contract state |
| --- | --- |
| `service-profile-active.v1.fixture.json` | Active provider-only profile with Metrics, Traces, optional Logs and Changes |
| `global-readiness-ready.v1.fixture.json` | One eligible Bundle is connected; Console shows the compact connection summary |
| `profile-readiness-partial.v1.fixture.json` | Required lanes are ready while optional Logs are missing |
| `profile-readiness-blocked.v1.fixture.json` | Required Kubernetes lane is blocked by stale certification |
| `profile-forbidden.v1.fixture.json` | Actor lacks the activation permission |
| `legacy-alert-rule-projection.v1.fixture.json` | Existing Alert Rule fields projected into a read-only compatibility context |

These files are test vectors. They are wire examples rather than seed data.

## Identity and lifecycle

V1 uses one profile for exactly one canonical `serviceName + environment`
combination. Staging and Production are separate profiles. A discovered Service
Catalog entry is a suggestion and does not become active until a user creates,
validates and activates a profile.

Lifecycle states:

- `draft`: editable but cannot dispatch automatic investigations;
- `active`: one validated revision is selected for new investigations;
- `paused`: retained and inspectable, but automatic dispatch is disabled;
- `archived`: historical references remain resolvable and the profile cannot
  start new investigations.

Saving creates a new immutable revision. Activation is a separate authorized
action and never mutates an earlier revision.

## Native alert dispatch

An auto-investigating profile explicitly selects one or more enabled Native
Alert Rule IDs. A rule may be owned by only one active auto-profile in the
same workspace and tenant; activation rejects ambiguous ownership.

When an incident fires, Core snapshots the active profile ID, revision and
SHA-256 digest into the restart-safe dispatch row. Dispatch re-resolves that
exact boundary through the same signed profile investigation path used by a
manual run. If the active revision changes while work is queued, the queued
dispatch fails closed instead of silently changing context.

The incident uniqueness constraint makes retries idempotent. For multiple
firing incidents on one profile, deterministic ordering admits one immediate
candidate and schedules later candidates after the profile cooldown. A
recovered incident is skipped before any Agent call. Legacy rule-owned Bundle,
service, environment and Runtime fields remain a compatible fallback during
the additive migration.

## Deterministic incident correlation

Native Alert incidents remain rule-level signal evidence. Core adds a durable
correlation group and append-only membership record instead of mutating alerts
into a lossy aggregate. A new signal joins the most recent group only when all
three deterministic conditions are true:

- canonical service matches case-insensitively;
- environment matches case-insensitively;
- the signal follows the group's latest signal inside the active profile's
  `correlationWindowMinutes` boundary.

The first signal is the `primary`; later signals are `member`s. Every member
stores machine-readable `groupingReasons`, including the observed time delta
and configured window. Foreign services, foreign environments and expired
windows never correlate.

Only the primary is eligible for automatic AIOps dispatch. The dispatch claim
uses the group lifecycle, so a still-firing member keeps the group active even
if its primary rule has recovered. Correlation identity and signal count are
forwarded as low-cardinality `argus.core.correlation.*` investigation labels.
Legacy incidents without correlation membership retain their previous
behavior.

The Alerts API projects group identity, scope, lifecycle, primary incident,
signal count and membership reasons on each incident. The Console renders the
group, clickable member signals and the correlation decision in the incident
timeline.

## External provider signal ingestion

`POST /api/observability/aiops/provider-signals/:provider` brings external
detectors into the same Core-owned incident pipeline. It accepts native
Alertmanager-compatible payloads from `prometheus-alertmanager` and `grafana`;
`elasticsearch`, `opensearch` and `generic` connectors submit the strict,
bounded Argus provider-signal v1 envelope.

The exact raw body is authenticated with `X-Argus-Signature:
sha256=<hex>` and `AIOPS_PROVIDER_WEBHOOK_SECRET`. Missing configuration is
fail-closed in every environment. API-key authentication is deliberately not
stacked onto this machine-to-machine route.

Each signal must resolve exactly one active profile by canonical service and
environment plus an exact `providerMonitorRefs` entry. References may be plain
monitor IDs or provider-prefixed values such as
`prometheus-alertmanager:CheckoutLatencyHigh`. Zero matches return 404; an
ambiguous match returns 409. Core then freezes the profile ID, revision and
SHA-256, creates or recovers a provider-backed signal incident, enters the
deterministic correlation window and requests dispatch only for a newly firing
primary.

Raw provider payloads are not retained. The append-only evidence row contains
the raw-body SHA-256, redacted bounded normalized signal, provider event and
monitor identities, immutable profile tuple, incident and group. A repeated
provider event ID resolves to the existing evidence without another incident
or Agent Task. Provider payloads may supply an optional evidence URL. Core
retains it only for HTTP(S), rejects embedded credentials, removes fragments
and strips credential-like query parameters before it can reach the Console.

## Incident Cockpit and outcomes

`GET /api/ui/observability/aiops/outcomes?days=30` builds a bounded rolling
projection directly from Core-owned incident, correlation, Task, dispatch,
remediation, change-plan, post-change and provider-signal evidence. The window
is clamped to 1–90 days and the response is never cached by the server.

The projection deliberately does not introduce a second analytics store:

- a raw signal is one native/provider alert incident in the selected window;
- an actionable incident is one correlation group, or one standalone signal;
- alert compression is `raw signals / actionable incidents`;
- suppressed signals are the additional group members that did not create a
  separate actionable incident;
- investigation coverage is the share of actionable incidents having a Task;
- recovery duration runs from the first group/signal trigger to recovery;
- RCA conclusions use only the latest normalized Task result per actionable
  incident;
- remediation success uses terminal immutable change plans, not proposal
  approvals; rollback and post-change regression remain separately visible;
- recurrence counts repeated actionable incidents for the same canonical
  `service + environment` in the selected window.

The Alerts page renders these outcomes above the incident list only while the
discovered Pack is ready and its manifest identity is exactly `argus.aiops`.
Missing, degraded and mismatched Packs hide the complete Outcome surface and
prevent its API request, matching the Argus.Dev/Hermes connector posture.
Selecting an
incident opens the existing evidence-rich drill-down under the explicit
`Incident Cockpit` identity: signal comparison, explainable correlation,
hypotheses, reviewer evidence, blast radius, audited changes, governed
remediation, verification/rollback and Core Trace links stay on one surface.
Legacy incidents without a service identity remain visible as
`unassigned / unknown`; they are never silently attributed to a profile.

The Outcome response also contains a bounded graph of at most 32 nodes and 80
edges. It joins incident-bearing `service + environment` identities to retained
OpenTelemetry-derived service, database, messaging and external dependency
evidence. Healthy edges remain `observed`; failed edges are explicitly labelled
`causal_candidate` with a deterministic confidence tier. This is prioritization
evidence, not causal proof. Selecting a node reveals related edges, internal
Incident links and, when the originating provider supplied one, a sanitized
external provider deep link. Truncation remains visible and the full Service
Topology stays the broader exploration surface.

The same response includes a bounded profile-attribution projection. Every
entry is keyed by the immutable Service Profile ID, revision and SHA frozen on
the Investigation Task, then evaluated against that exact revision's Evidence
Policy. Lane coverage comes only from normalized Task-result claims; the
Incident lane is implicit for a result-bearing incident investigation. Missing
or malformed results remain unassessed instead of manufacturing coverage.

Usage attribution joins the Task Root Trace to retained native trace telemetry.
It reports input/output token counts and recorded USD cost only when those
values exist in trace evidence. The response exposes how many investigations
were trace-linked and separately how many carried token or cost values. A zero
recorded cost therefore means `no positive cost was recorded`, never `the
runtime was free`. The query processes at most the latest 1,000 profile-bound
Tasks per window and exposes truncation.

Completed RCA results expose a compact human review control in the Incident
Cockpit. `helpful`, `partial` and `incorrect` reviews require a bounded reason;
an optional note is force-redacted and capped at 2,000 characters. The browser
supplies only that assessment. Core resolves and freezes the Incident, Task,
Root Trace, service/environment and immutable Service Profile tuple. A changed
review creates a new feedback row and marks the former row inactive, retaining
revision history instead of overwriting it.

Each mutation is same-origin protected, requires
`aiops.investigation.review`, repeats the Investigation Bundle authorization
boundary and writes a fail-closed canonical event with the SSO subject,
effective role, trace correlation and profile hash. Free-text notes are not
copied into the canonical event payload. The rolling projection counts only
active reviews and exposes helpful/partial/incorrect totals plus helpful rate
for each exact Profile revision.

This completes the Evidence-lane, trace-reported usage and human RCA feedback
portions of `AIOPS-OUTCOME-001`. Longer-horizon product analytics remain
outside this projection.

## Live certification

`npm run certify:aiops-service-profiles` is mutation-free and validates the
Pack, Bundle, exact Agent tool projections and runtime readiness. Adding
`-- --execute` creates or reuses two bounded certification profiles and alert
rules, emits one firing Service A incident plus one recovered Service B control,
then proves:

- exactly one Service A dispatch and Task;
- zero Service B dispatches;
- duplicate dispatcher passes do not create another Task;
- the Task retains the exact profile revision/SHA, Bundle, service,
  environment, native-alert trigger and Root Trace;
- cleanup disables the rules, recovers test incidents and pauses both profiles.

`npm run certify:aiops-readiness-failures` builds Core and runs the transactional
negative-path probe when the process can reach PostgreSQL. In Compose, run the
compiled probe inside `mcp-server`. It injects Connector
Loss, a missing required lane capability and stale Kubernetes certification,
asserts that each profile is blocked before any A2A/Pack call, then rolls back
all injected state.

`npm run certify:aiops-alert-correlation` is a token-free transactional DB
certification. It creates three temporary signals, proves that two Checkout
signals share one critical group while a Payments signal stays isolated, and
proves that only two primaries are dispatchable. The entire transaction is
rolled back. In Compose, run the built script inside `mcp-server`.

`npm run certify:aiops-provider-signals` is the corresponding token-free
provider gate. It exercises Alertmanager normalization, exact profile routing,
append-only evidence, replay idempotency, recovery and same-service correlation
against PostgreSQL, then rolls the full transaction back. In a production Core
image without dev dependencies, execute the already-built script directly.

## Evidence contract

Supported lanes:

- `metrics`
- `logs`
- `traces`
- `runtime`
- `topology`
- `changes`
- `knowledge`
- `incident`

Every lane is `required`, `optional` or `disabled`.

- Missing or blocked required lanes block a run.
- Missing optional lanes produce a degraded readiness result and explicit
  Evidence Gaps.
- Disabled lanes cannot expose tools or query templates.
- At least one lane must be enabled.
- `minimumCollectedLanes` cannot exceed the enabled lane count.

One eligible MCP Bundle is sufficient for global AIOps onboarding when its
active trusted tools provide at least one of Metrics, Logs, Traces, Runtime or
Incident evidence. This is not permission to use an arbitrary, empty,
untrusted, disabled or write-only Bundle.

## Conditional Kubernetes boundary

Kubernetes is not a global requirement. A target and current certification are
required only when the resolved profile:

- marks Runtime as required;
- supplies a Kubernetes Runtime Selector; or
- authorizes a governed Kubernetes remediation path.

Provider-only Metrics, Logs or Traces investigations can run without a
Kubernetes target. Once selected, the existing signed target, namespace,
certification, Bundle and remediation-adapter controls continue to fail closed.

## Query safety

V1 query templates accept only these placeholders:

- `${service.name}`
- `${environment}`
- `${window.start}`
- `${window.end}`
- `${runtime.cluster}`
- `${runtime.namespace}`
- `${signal.keyword}`
- `${signal.fingerprint}`
- `${trace.id}`

Executable recipes add a structured `source` with its provider kind, optional
resource/index and field mapping. Their `template` must be a JSON argument
object. Legacy provider-native PromQL and LogQL expressions without `source`
remain valid for backward compatibility, but the generic preflight does not
execute them as tool arguments.

Secrets, credentials and private Backend configuration are not profile fields.
Core resolves the referenced Bundle and Tool server-side. Tool access remains
limited by the Bundle allowlist and signed execution grant.

The contract bounds lane, tool, template, selector, knowledge, alert, SLO and
dependency counts. A single provider result is limited to 4 KiB–512 KiB, after
which the existing Agent/provider-specific lower limit may apply.

## Readiness presentation

Global readiness drives progressive connector onboarding:

| Condition | `presentation` | Console behavior |
| --- | --- | --- |
| No eligible Bundle | `connector_setup` | Show provider/adapter onboarding |
| Eligible Bundle exists | `connected_summary` | Hide adapter gallery; show compact Evidence summary and Manage/Add actions |

The adapter gallery is never deleted. `Add environment` or `Manage connections`
opens it on demand. A connection issue highlights only affected profiles.

Profile readiness states:

- `ready`: every required lane is ready and no blocking issue exists;
- `degraded`: required lanes are ready but optional gaps or warnings exist;
- `blocked`: one or more required lanes, scopes or certifications fail.

Recovery actions are server-generated and authorization-filtered.
Active profile cards request this server-calculated readiness on render and
refresh it every 30 seconds. Lifecycle status and operational readiness remain
separate: an `active` profile stays visible while current drift, the affected
lane and its recovery action are surfaced in-place.

## Authorization matrix

| Action | Required permission |
| --- | --- |
| List and read profiles/readiness | `aiops.service_profile.read` |
| Create and revise | `aiops.service_profile.write` |
| Validate | `aiops.service_profile.write` |
| Activate, pause and archive | `aiops.service_profile.activate` |
| Start investigation | `aiops.investigation.run` |
| Review completed RCA | `aiops.investigation.review` |
| Propose remediation | `aiops.remediation.propose` |
| Approve exact change/rollback hash | `aiops.remediation.approve` |
| Execute approved plan | `aiops.remediation.execute` |

UI actions are discoverability only. Every endpoint repeats permission,
Bundle, target and scope authorization server-side. Existing production
separation-of-duties rules remain authoritative.

## Governed remediation certification

`npm run certify:aiops-remediation` builds Core and validates the independent
proposal, approval and execution permissions, immutable plan/rollback hashes,
separation of duties, read-after-write verification, post-change monitoring
and failure rollback without mutating a provider.

Passing `--live` additionally exercises the workload-scoped local Kubernetes
connector. It requires
`ARGUS_AIOPS_REMEDIATION_E2E_CONFIRM=scale-and-restore-argus-demo`, verifies a
temporary replica and retained-revision change, and restores both exact prior
states in `finally`..

## Compatibility

The first rollout is additive and feature-flagged. Existing Alert Rule fields
`aiops_bundle_ids`, `aiops_resource_scope`, `aiops_service` and
`aiops_environment` remain readable while Core can project them into the
legacy fixture shape.

Legacy projection does not invent an immutable revision and does not silently
gain newer automation capabilities. It remains explicitly marked and
read-only until migrated and activated as a real profile.

Old Argus AIOps Pack versions continue using their static Metrics + Runtime
requirements. Dynamic profile requirements are used only when Core and Pack
both declare the new contract version.

## Profile-backed investigation start

The browser starts an investigation with only an active profile ID and a
bounded incident signal. It cannot select Bundles, Tools, queries, service,
environment or Runtime scope for the Run.

Core loads the exact active immutable revision, recalculates readiness and
resolves only currently ready required/optional lanes. The resulting
`aiops-resolved-service-context` freezes:

- profile ID, revision and revision SHA-256;
- canonical service, environment and ownership;
- exact Bundle IDs, Tool names and query recipes per Evidence lane;
- selectors, knowledge/runbook references and optional Runtime scope;
- remediation policy and a SHA-256 over the complete resolved context.

Core includes the exact Bundle IDs, Tool names, optional Runtime scope and the
profile/context hash tuple in the signed Execution Grant. Grant middleware
intersects the live Bundle catalog with the signed Tool allowlist. Argus AIOps
requires `aiopsServiceContextVersion: 1` and rejects any mismatch between the
message context and the grant before creating a Task. Optional lanes that are
not ready are omitted from both context and grant instead of being silently
broadened.

The Pack uses the supplied lane recipes and Tool names in its evidence prompts;
it does not substitute a provider or infer a broader static catalog. Existing
legacy Pack starts remain compatible and retain their prior Kubernetes-scope
fail-closed behavior.

## Compatibility rules

- Optional fields may be added within v1.
- Field removal, rename or semantic broadening requires v2.
- Unknown lanes, permissions, recovery actions or capability categories fail
  closed in Core contracts.
- Historical revisions and Run snapshots are never rewritten during schema
  upgrades.
- Status and readiness are separate: an active profile may become degraded or
  blocked when an external connection changes.

## Implemented Core endpoints

```text
GET    /api/ui/observability/aiops/service-profiles
POST   /api/ui/observability/aiops/service-profiles
GET    /api/ui/observability/aiops/service-profiles/:id
PATCH  /api/ui/observability/aiops/service-profiles/:id
POST   /api/ui/observability/aiops/service-profiles/:id/validate
POST   /api/ui/observability/aiops/service-profiles/:id/activate
POST   /api/ui/observability/aiops/service-profiles/:id/pause
POST   /api/ui/observability/aiops/service-profiles/:id/clone
GET    /api/ui/observability/aiops/service-profiles/:id/revisions
GET    /api/ui/observability/aiops/readiness
GET    /api/ui/observability/aiops/outcomes?days=30
GET    /api/ui/observability/aiops/service-profiles/:id/readiness
POST   /api/ui/observability/aiops/evidence-query-preflight
POST   /api/ui/observability/aiops/service-profiles/:id/investigations
GET    /api/ui/observability/alerts/:incidentId/aiops-investigations/:taskLinkId/feedback
POST   /api/ui/observability/alerts/:incidentId/aiops-investigations/:taskLinkId/feedback
```

Every listed endpoint enforces its named server-side permission. Mutations use
same-origin checks, optimistic revision concurrency, canonical audit events and
idempotent producer event IDs. Investigation start requires
`aiops.investigation.run`; Core, rather than the browser, resolves the complete
active profile authority and binds it into the signed grant.

`evidence-query-preflight` is a bounded read path used by the Service Profile
Wizard. Core validates the caller's write permission and same-origin request,
repeats the SSO/RBAC Bundle boundary, confirms that the selected Tool belongs
to that Bundle, is enabled and is classified read-only, then renders only the
documented typed placeholders. Arguments are limited to 64 KiB, depth 12 and
2,000 nodes. Request and result previews are force-redacted; the preview is
capped at 16 KiB. Its canonical admin audit event contains execution metadata
only and intentionally excludes the query, rendered arguments and result.
