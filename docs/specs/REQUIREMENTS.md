# Track A Requirement Register

Status values: `implemented`, `contract`, `planned`, `certified`.

## Access

| ID | Requirement | Status |
| --- | --- | --- |
| ACCESS-001 | Core exposes one stable named-permission catalog. | implemented |
| ACCESS-002 | Existing roles and `admin`/`editor` aliases map compatibly to permission presets. | implemented |
| ACCESS-003 | Explicit deny wins over direct, group and role allows. | implemented |
| ACCESS-004 | Verified SSO groups resolve server-side to role presets with deterministic precedence. | implemented |
| ACCESS-005 | Four-eyes review rejects self-approval without explicit override permission. | implemented |
| ACCESS-006 | Console receives permissions, installed modules, entitlements and navigation capabilities separately. | implemented |
| ACCESS-007 | Every migrated endpoint enforces named permissions independently of UI visibility. | planned |
| ACCESS-008 | Persisted permission and role mutations plus verified SSO identity/mapping decisions emit canonical audit evidence. | certified |

## Tags

| ID | Requirement | Status |
| --- | --- | --- |
| TAG-001 | One workspace tag registry serves all supported resource types. | implemented |
| TAG-002 | Assignment validates resource existence and actor authorization. | implemented |
| TAG-003 | Root runs freeze resource and tag references at creation time. | implemented |
| TAG-004 | Tag telemetry is bounded and cannot create unbounded metric cardinality. | planned |

## Runs

| ID | Requirement | Status |
| --- | --- | --- |
| RUN-001 | Run lists expose root/parent relations and aggregate child states. | implemented |
| RUN-002 | Display status distinguishes active, waiting, action-required and terminal states. | implemented |
| RUN-003 | Run queries use authorization before counts, filters and pagination. | implemented |
| RUN-004 | Historical orphan runs remain visible and explicitly classified. | implemented |

## Golden Path and pilot readiness

| ID | Requirement | Status |
| --- | --- | --- |
| GP-001 | One versioned journey projects Git issue ingestion, immutable repository context, Dev analysis, policy, approval, bounded external outcomes and Evidence without duplicating domain authority in the Console. | contract |
| GP-002 | Certification mode uses deterministic local Git and notification providers; live-demo mode uses explicitly configured GitHub and Slack targets and never falls back silently to fixtures. | contract |
| GP-003 | Preflight freezes tenant, workspace, environment, saved Workflow/Agent revisions, selected Runtime profile, effective grant, exact write targets and Policy digests before execution. | contract |
| GP-004 | Read-only analysis runs without an unnecessary Human Gate; every declared external write in guarded mode is bound to an exact payload and approval decision. | contract |
| GP-005 | Issue ingestion, approval resume, provider writes and checkpoint retry are idempotent across duplicate triggers and process restarts. | contract |
| GP-006 | Run, Trace, Runtime Task, Approval, Audit Report, Evidence Pack, Dossier and external Receipts remain discoverable through typed correlation references. | contract |
| GP-007 | Two concurrently executing tenants with colliding display names cannot observe or mutate each other's resources, runtime grants, search results, logs, approvals or Evidence. | partial — session, Audit/Reports/Evidence, AI-system Compliance, Golden Path and runtime technical-identity boundary certified; remaining registries are P1 |
| GP-008 | A versioned encrypted backup restores the Golden Path data and verifiable Evidence into a fresh namespace with measured RPO/RTO and a retained Restore Receipt. | partial — fresh Compose DB, Audit/Reports, memberships, workspace artifacts and WORM receipts certified |
| GP-009 | Supported Session, encryption, signing, OIDC, MCP, Runtime and provider secret rotations preserve in-flight safety and historical verification while revoking the old active path. | planned |
| GP-010 | Upgrade certification proves the preserved Golden Path on a previous release fixture, applies migrations once and verifies the declared app-rollback or backup-restore recovery path. | planned |

Contract and delivery plan: [`docs/specs/golden-path/README.md`](./golden-path/README.md)
and `GOLDEN_PATH_PILOT_READINESS_PLAN.md` (internal, not published).

## Agent and model evaluation

E0/E1 provide frozen datasets/configurations, scope checks and canonical audit.
Historical smoke evidence stays readable. Starts fail closed until the isolated
E2 executor exists. The original policy-only script is not an execution certificate.

| ID | Requirement | Status |
| --- | --- | --- |
| EVAL-001 | Dataset activation freezes cases, expected evidence, context and evaluator configuration under a stable digest; concurrent mutation cannot change an active version. | certified |
| EVAL-002 | A comparison pins authorized Agent, Skill, Runtime and model configuration, records the effective execution target and preserves history after configuration changes. | implemented |
| EVAL-003 | Versioned deterministic evaluators check explicit task criteria; non-empty output alone remains a smoke check, not a quality claim. | implemented |
| EVAL-004 | Usage, latency and costs retain provenance and measurement coverage; unavailable or partial cost data is never presented as a measured zero or complete total. | implemented (native API) |
| EVAL-005 | Regression requires compatible dataset, case and evaluator identities plus complete evidence; incomplete and incompatible comparisons receive explicit non-passing states. | implemented |
| EVAL-006 | Dataset, experiment, result, target, baseline, trace, credential and export access resolve one authorized workspace; legacy global resources remain contained in their supported scope. | implemented (E1–E5, local DB/API gates) |
| EVAL-007 | The isolated answer-evaluation mode disables tool execution, automatic retrieval, memory and undeclared evaluation calls; each external runtime must prove the same boundary before activation. | planned |
| EVAL-008 | Starts and worker claims are idempotent; interrupted or uncertain provider attempts remain visible and are not automatically reissued after restart. | implemented (E3a/E3b) |
| EVAL-009 | Cancel prevents new cases and preserves available usage; retry creates a new immutable attempt without silently rerunning successful cases. | implemented (E3a) |
| EVAL-010 | Console users can select validated execution targets, author cases, follow progress and inspect paired answers, scores and measurement gaps without mandatory JSON editing. | implemented (E4, local Edge/fake provider) |
| EVAL-011 | Authorized redacted exports and audit events bind the comparison to immutable dataset, configuration and evaluator identities. | implemented (E5 JSON/CSV, fresh MFA; local DB/Edge) |
| EVAL-012 | Provider-free end-to-end certification and an explicitly started live smoke produce separate evidence and a reproducible Windows/macOS demo. | partial (E5 Windows fixture demo certified; Mac instructions; live smoke/Mac run pending) |
| EVAL-013 | Atomic A/B plans reuse frozen configurations for explicit repetitions and a pinned alternating or baseline-first order; no unstarted or missing pair can produce a passing aggregate gate. | implemented (E3b, fake provider) |

Delivery sequence, scope and acceptance:
`ARGUS_EVALUATION_PRODUCTIZATION_PLAN.md` (internal, not published).

EVAL-001 certification is provider-free PostgreSQL evidence, not legal certification.
EVAL-002–005 are verified with native API fixtures, not a real paid provider.
EVAL-006/EVAL-011 include scope/audit boundaries; exports remain planned.
EVAL-007 is implemented for the dedicated native executor; external runtimes stay
blocked. EVAL-008/009 have renewable fenced leases, startup recovery, durable
cross-process cancellation and explicit technical retries with immutable history.
Recovery can finalize fully recorded results without repeating provider calls;
unknown outcomes remain interrupted. E3b adds atomic paired plans, 1–10 explicit
repetitions and whole-dataset A→B/B→A order. Parent leases fence child dispatch and
late results; cancellation/recovery never silently resume the series. Repair
technical children explicitly before resuming queued steps. All paired rounds and
historical cost gaps contribute; repeated samples do not imply significance.
EVAL-010 has guided case authoring, a two-stage reviewed target dialog with
transactional drift detection, and paired answer/criterion/measurement/trace
inspection. Native API browser acceptance ran in isolated Edge, including
keyboard focus, light/dark and narrow layouts. EVAL-012 has PostgreSQL/HTTP and
browser fake-provider evidence; curated export/demo, real-provider and Mac
acceptance remain pending. See [`evaluation/README.md`](evaluation/README.md).

## Repository graph

| ID | Requirement | Status |
| --- | --- | --- |
| GRAPH-001 | Every graph response is pinned to immutable commit and graph digest. | certified |
| GRAPH-002 | Server traversal is bounded by depth, node/edge limits and authorization. | certified |
| GRAPH-003 | Browser graph reads are bundle-authorized and hard-bounded; the complete graph is available only through an explicit endpoint with independent node, edge, byte and time caps. | certified |
| GRAPH-004 | Graphify has a keyboard-accessible table/tree fallback. | implemented |
| GRAPH-005 | Graphify exposes a bounded repository/module overview with language, test and cross-module dependency summaries. | implemented |
| GRAPH-006 | Users can drill from an architecture module into its bounded file/symbol neighborhood without changing snapshot identity. | implemented |
| GRAPH-007 | Bounded Graphify views progressively focus a selected node and its direct loaded neighbors and lazily expand code without changing snapshot identity. | implemented |
| GRAPH-008 | The architecture overview defaults to its strongest dependencies and exposes one explicit action for the complete snapshot code graph. | implemented |
| GRAPH-009 | The complete view renders every returned file, function/symbol, declaration and provider relation at once on Canvas, without module drill-down or per-node React/SVG elements, and labels any server safety-cap truncation. | implemented |

## Audit and evidence

| ID | Requirement | Status |
| --- | --- | --- |
| AUDIT-001 | Privileged mutations produce versioned canonical audit events. | contract |
| AUDIT-002 | A PostgreSQL transactional outbox prevents permanent loss during sink failure. | certified |
| AUDIT-003 | Tenant/environment chains receive signed, externally verifiable checkpoints. | certified |
| AUDIT-004 | Evidence queries correlate actor, policy, resource, run, trace and tags. | implemented |
| AUDIT-005 | Retention classes and legal hold are evaluated independently of logs; archive/purge enforcement and deletion evidence remain production hardening. | implemented |
| AUDIT-006 | Exported evidence packs verify offline and declare legacy gaps. | certified |
| AUDIT-007 | On-demand and scheduled reports derive only from signed Evidence Packs, remain immutable, expose deterministic PDF/JSON/JSONL/CSV artifacts and accept append-only human reviews. | implemented + live-tested |

`AUDIT-001` remains at contract status until every privileged producer family
is migrated. Workspace Tag/Tag-assignment mutations and the admin-managed user
lifecycle, API-key create/update/rotate/delete plus user/group composite,
tool-rule and agent-allow-list mutations, runtime/workflow approval decisions
and external runtime-filter risk policies are the currently database-certified
canonical producer slices. The verified OIDC identity sync now freezes the
effective role/mapping decision and a digest-only group snapshot atomically
with provisioning or login synchronization. The mapping rule itself remains
deployment configuration (`OIDC_GROUP_MAP`/`ENTRA_GROUP_MAP`); no mutable DB
mapping resource exists today. First-user bootstrap is canonical and
serializes its empty-table decision with the insert, so concurrent registration
cannot create multiple initial platform admins.

`AUDIT-003` and `AUDIT-006` are database-certified prototype controls:
Ed25519 checkpoints support historical verification across key rotation, and
JSON evidence packs bind a complete redacted chain, selection, JSONL/CSV
artifacts, schema/control metadata and declared gaps to one SHA-256 digest.
`AUDIT-007` has additionally been exercised in the live Docker stack with a
real Ed25519 checkpoint, 20 selected events, 20 complete-chain entries and a
downloadable deterministic PDF artifact. It does not convert the prototype
into a legal certification: external WORM/timestamp anchoring, physical
retention enforcement and restore drills remain declared
gaps.
`AUDIT-005` does not yet claim physical deletion: versioned regional policies
and append-only hold placement/release are effective read-model overlays;
archive/purge execution, deletion evidence and backup/restore drills remain
explicitly open.

## AI Act compliance enablement

These requirements enable a customer-specific conformity process. They do not
declare that every Argus deployment or configured AI system is compliant.

| ID | Requirement | Status |
| --- | --- | --- |
| AIA-001 | A versioned control catalog maps applicable AI Act duties to enforceable controls, evidence and explicit Argus/customer responsibility. | contract |
| AIA-002 | Every governed AI system has an immutable intended-purpose, role, prohibited-practice and risk-classification assessment. | certified |
| AIA-003 | Every production root run freezes the released AI-system revision and complete control-set digest; missing or drifted bindings fail closed. | implemented |
| AIA-004 | The Console guides authorized users through registration and classification without automatically claiming legal conformity. | contract |
| AIA-005 | Risk, data, model, human-oversight, transparency and AI-literacy records are versioned and canonical-audited. | contract |
| AIA-006 | System-specific evaluation thresholds and negative tests gate each production release and material change. | planned |
| AIA-007 | Post-market monitoring, incident causality, deadlines and corrective actions are bound to the exact released system revision. | planned |
| AIA-008 | Compliance dossiers derive from signed Evidence Packs plus immutable compliance records and declare every partial, missing or expired legal/document requirement. | implemented |
| AIA-009 | Sensitive release, classification, exception, export, retention and incident decisions require SSO, fresh MFA step-up and separation of duties. | partial |
| AIA-010 | External WORM anchoring, qualified timestamp support, physical retention/purge and restore drills produce independently verifiable evidence. | planned |
| AIA-011 | Customer instructions clearly allocate provider/deployer responsibilities, intended-use boundaries, monitoring and human-oversight duties. | planned |
| AIA-012 | An independent reviewer can verify one complete dossier offline and trace every control to source revision, actor, test and digest. | partial |

Detailed plan: `AI_ACT_COMPLIANCE_ENABLEMENT_PLAN.md` (internal, not published).

`AIA-009` remains partial: provider-verified OIDC/Entra MFA assurance is stored
server-side on the browser session, bound to the same SSO subject, bounded by
`auth_time`, and enforced for Evidence Pack export, manual report generation
and artifact download. Separate immutable revision, classification and release
producers now enforce named permissions, same-origin, fresh MFA, stable
idempotency and two distinct four-eyes boundaries. Retention, exception,
suspension and incident decisions still need equivalent step-up producers, and
the customer IdP path still needs a real E2E certification before the whole
requirement can be marked implemented.

`AIA-002` is certified for the registry slice: migration 230, the server-owned
initial revision producer, tenant/workspace-scoped reads, immutable role and
assessment records, canonical event/outbox persistence and database-level
mutation resistance passed the disposable PostgreSQL gate. `AIA-004` remains
`contract` until the guided Console flow consumes the implemented
server-authoritative readiness endpoint.

`AIA-003` is implemented and database-certified for governed workflow root
runs: cron and provider-webhook service identities, real Builder runs and
root-run retries must persist an immutable decision before any Agent or tool is
invoked. Human production runs require verified OIDC/Entra SSO; automated runs
require an explicitly verified workload identity. Mock and local webhook-test
runs are outside Production Evidence. The requirement is not yet marked fully
`certified` because component-drift verification and non-workflow root-run
producers still need to consume the same gate.

## AIOps Service Profiles

| ID | Requirement | Status |
| --- | --- | --- |
| AIOPS-PROFILE-001 | One profile binds exactly one canonical service and environment to bounded Evidence, Detection, Context and Remediation configuration. | contract |
| AIOPS-PROFILE-002 | Profile revisions are immutable, canonically hashed and captured by every new investigation. | contract |
| AIOPS-PROFILE-003 | Required, optional and disabled Evidence lanes are explicit; disabled lanes expose no tools or queries. | contract |
| AIOPS-PROFILE-004 | Profiles contain Bundle and Tool references but never credentials or private Backend configuration. | contract |
| AIOPS-PROFILE-005 | Runtime-required and governed-execute profiles require an explicit Runtime Selector. | contract |
| AIOPS-PROFILE-006 | Profile CRUD, lifecycle and investigation start use named server-side permissions resolved through existing RBAC/SSO; remediation enforcement remains Phase F. | implemented |
| AIOPS-PROFILE-007 | `aiops_service_profile` participates in the shared tag/resource-reference model. | implemented |
| AIOPS-READY-001 | Global AIOps readiness requires at least one active, trusted, authorized Bundle with a recognized read-evidence capability. | contract |
| AIOPS-READY-002 | The Console collapses provider adapters after readiness and preserves explicit Manage/Add Environment recovery actions. | implemented |
| AIOPS-READY-003 | Kubernetes target certification is conditional on the resolved profile rather than a global AIOps requirement. | contract |
| AIOPS-READY-004 | Missing required lanes block; optional gaps degrade and remain visible to operator and Reviewer. Connector loss, missing required capability and stale Runtime certification are transactionally certified to stop before Pack/model work. | certified |
| AIOPS-READY-005 | Active Service Profile cards continuously project server-calculated readiness drift, blocking reasons and authorization-filtered recovery actions without requiring a lifecycle mutation. | implemented |
| AIOPS-UI-001 | The AIOps Console creates versioned service-profile drafts, validates them server-side and exposes only server-projected lifecycle actions. | implemented |
| AIOPS-UI-002 | A configured but operationally blocked Evidence bundle stays in the compact summary with recovery evidence; only a missing suitable bundle reopens connector onboarding. | implemented |
| AIOPS-QUERY-001 | Each service can map a bounded Logs recipe to its own provider Tool, index/stream, service/environment/time/message fields and default signal keyword. | implemented |
| AIOPS-QUERY-002 | Query testing repeats SSO/RBAC Bundle authorization and read-only Tool policy server-side, renders only typed placeholders, bounds complexity and size, redacts request/result previews and audits metadata only. | implemented |
| AIOPS-RUN-001 | Core resolves and signs Profile revision, resolved-context hash, Bundles, exact Tools and Resource Scope without trusting client-supplied broadening; Pack rejects mismatches before Task creation. | implemented |
| AIOPS-RUN-002 | Deterministic cooldown and idempotency prevent duplicate Agent investigations for one correlated incident. | implemented |
| AIOPS-RUN-003 | Legacy Alert Rule AIOps fields remain readable and explicitly non-immutable during additive migration. | contract |
| AIOPS-RUN-004 | Alert correlation records explainable grouping reasons before learned correlation is introduced; live certification proves foreign-service, foreign-environment and expired-window isolation plus bounded direct/contextual change evidence. | certified |
| AIOPS-RUN-005 | A confirmed regression creates an immutable hash-bound remediation plan; separately authorized approval and execution perform a bounded provider write, read-after-write verification, post-change monitoring and exact-state rollback. | certified |
| AIOPS-RUN-006 | A reproducible two-service Native Alert certification proves one exact profile-backed dispatch for Service A, no dispatch for recovered Service B, restart-safe dedupe and immutable Task context. | certified |
| AIOPS-RUN-007 | HMAC-signed external signals resolve exactly one active immutable Service Profile revision, retain redacted append-only evidence, deduplicate provider event replays and enter the same deterministic incident-correlation pipeline. | certified |
| AIOPS-RUN-008 | A background reconciler resolves stale execution, verification and rollback claims exclusively through the exact approved read-only provider check; it never replays a write, atomically records canonical audit evidence and fails closed on unexpected state. | certified |
| AIOPS-OUTCOME-001 | Per-profile telemetry measures lane coverage, duration, tokens, costs, RCA conclusion, remediation and rollback outcomes. | certified |
| AIOPS-OUTCOME-002 | Metric labels remain low-cardinality and exclude free text, queries and raw telemetry. | contract |
| AIOPS-OUTCOME-003 | A bounded rolling Core projection measures raw signals, actionable correlated incidents, compression, recovery, investigation coverage and duration, RCA conclusions, remediation verification, rollback and recurrence without storing a second analytics truth. | implemented |
| AIOPS-OUTCOME-004 | The Alerts surface presents the rolling outcome projection above the incident list and uses the existing evidence, hypothesis, impact, change, remediation and post-change drill-down as the Incident Cockpit. | implemented |
| AIOPS-OUTCOME-005 | The Alerts surface fetches and renders AIOps outcomes only while an identity-valid `argus.aiops` Solution Pack is connected and ready; missing, degraded or mismatched Packs fail closed without an Outcome request. | implemented |
| AIOPS-OUTCOME-006 | The Incident Cockpit projects a bounded service/dependency graph from retained runtime evidence, distinguishes observed edges from correlation-based causal candidates, and exposes sanitized provider plus internal Incident deep links. | implemented |
| AIOPS-OUTCOME-007 | Outcome telemetry attributes normalized Evidence-lane coverage to the exact immutable Service Profile ID, revision and SHA used by each investigation; the implicit Incident lane is counted only for result-bearing profile Tasks. | implemented |
| AIOPS-OUTCOME-008 | Outcome telemetry attributes only trace-reported input/output tokens and recorded USD cost to profile-bound investigations, exposes trace-linkage coverage, and never interprets a missing or zero recorded cost as a free runtime. | implemented |
| AIOPS-OUTCOME-009 | An authorized human can review a completed RCA as helpful, partial or incorrect with a bounded reason and optional redacted note; every revision remains bound to Incident, Task, Root Trace and immutable Service Profile evidence, produces fail-closed canonical business-audit evidence, and contributes only active reviews to per-profile Outcome telemetry. | implemented |
| AIOPS-AUDIT-001 | Dry-run, immutable plan, approval, execution, verification, monitor and rollback transitions atomically persist domain state, canonical hash-chain evidence and durable outbox records with SSO/RBAC actor, request, approval, plan/rollback hash and Trace correlation while excluding raw provider payloads. | certified |
