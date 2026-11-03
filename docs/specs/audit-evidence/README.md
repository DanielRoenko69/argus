# Canonical audit and evidence handoff

Status: H5 canonical event/query, H6 signed checkpoints, retention/legal hold,
offline-verifiable Evidence Packs, the H7 report workflow, the H8 external
trust-anchor contract, H9 retention planning, H10 WORM archive verification,
H11 independent restore verification, H12 standalone archive verification and
H13 immutable chain-segment sealing
are implemented.
The report workflow has been exercised in the live Docker stack with a real
Ed25519 checkpoint, complete-chain verification and deterministic PDF/JSON/CSV
artifacts. H8 verifies and stores detached provider-signed receipts, but a real
customer WORM/timestamp provider and physical purge enforcement remain
deployment/production hardening. H11 supplies the restore-drill protocol; a
real provider drill is still required per deployment. H13 seals a verified
genesis prefix and its continuation hash but deliberately does not authorize
or perform deletion.

Producer migration status: workspace Tag create/update/delete, resource Tag
assignment replacement, first-user bootstrap, the admin-managed user lifecycle
(create, update, password change and delete) and API-key
create/update/rotate/delete are migrated. User-/group-composite assignments,
user-/group-tool rules and user-/group-agent allow-lists are also canonical.
Verified OIDC auto-provisioning and login synchronization persist the applied
role plus group snapshot atomically with `access.sso_identity` evidence. Raw
group claims, email and signed callback state are excluded; group sets and
matched mappings are represented by bounded SHA-256 digests. The underlying
group-to-role rule remains deployment configuration because no editable DB
mapping resource exists today. Runtime approval decisions, workflow lifecycle
approvals and external runtime-filter risk policies now commit their canonical
event and outbox atomically with the protected mutation. Replays do not repeat
a decision, resume dispatch or lifecycle transition, and secret/free-form
policy material is retained only as bounded digests. All other producer
families remain explicitly legacy until moved in later bounded slices.

The canonical business-audit path is additive. Existing operational logs,
`mcp_admin_audit_log` and `mcp_immutable_audit_log` remain readable and are not
rewritten as if they had always satisfied this contract.

## Persistence contract

Migration `220_canonical_audit_events.sql` adds three responsibilities:

- an append-only, schema-versioned event envelope;
- a sequence and SHA-256 hash chain partitioned by workspace, tenant and
  environment;
- a PostgreSQL outbox row committed atomically with the event and protected
  business mutation.

Migration `221_scope_canonical_audit_idempotency.sql` scopes producer
deduplication to workspace, tenant and environment. Equal client keys in
different isolation domains therefore cannot suppress or disclose each
other's events.

Migration `222_canonical_audit_integrity.sql` adds an immutable Ed25519 public-
key registry and append-only scoped checkpoints. Private signing keys are never
stored in PostgreSQL. A rotated key creates a new historical key record; old
checkpoints remain verifiable with the public key and fingerprint captured for
their `keyId`.

Migration `223_canonical_audit_retention.sql` adds versioned, region-aware
retention policies and an append-only legal-hold action ledger. Holds are
placed and released as new actions; canonical events remain immutable. The
prototype evaluates those overlays in Evidence Query but deliberately does not
yet delete or archive expired events.

Migration `229_audit_evidence_reports.sql` adds immutable report runs,
disable-only recurring definitions and append-only human review decisions.
Every completed report references a fresh signed checkpoint, the exact
Evidence Pack digest and its verification result. Terminal report rows cannot
be rewritten or deleted; a correction is represented by a new report or review.

Migration `236_external_evidence_anchors.sql` stores detached, append-only
receipts returned by an external trust boundary. Each receipt is bound to the
exact Evidence Pack UUID and SHA-256 plus workspace, tenant and environment.
It records the provider, immutable reference, anchor time, optional retention
deadline, configured verification-key fingerprint and fresh SSO/MFA assurance.
Rows cannot be updated, deleted or truncated. Keeping the receipt detached
avoids a circular digest: the already-signed Evidence Pack is anchored first,
and later Compliance Dossiers include the verified receipt and its digest.

Use `executeCanonicalAuditedMutation` for migrated privileged producers. Its
producer name and producer event ID are the idempotency boundary. A replay does
not run the mutation again and returns `result: null`; callers re-read the
resource when they need the current response representation.

HTTP Tag, admin-managed user lifecycle, API-key lifecycle and admin
access-policy mutations accept a bounded `Idempotency-Key` header. Browser
requests without one receive a generated event key; clients that retry an
ambiguous request must preserve their original key. Replayed mutations do not
create duplicate resources or legacy audit rows. API-key create/rotate are a
deliberate exception to response replay: the first request returns plaintext
once; a replay returns `API_KEY_SECRET_NOT_REPLAYABLE` with the committed
resource/audit IDs and never persists, remints or re-exposes the credential.
First-user bootstrap uses a PostgreSQL table lock around the empty-user check
and insert. This makes the platform-admin invariant hold even when local and
SSO provisioning race; its unauthenticated initiator is recorded honestly as
a system bootstrap actor rather than as a verified human identity.
OIDC synchronization uses a digest of the signed callback state as its producer
key and a per-subject transaction lock. The signed state itself, authorization
code, email and raw group IDs are never written to canonical evidence.

The outbox is at-least-once. Consumers must deduplicate by canonical `eventId`.
Delivery failures return to `pending` with bounded exponential backoff and are
never dropped because an attempt threshold was reached. When the configured
queue capacity is reached, the protected transaction fails closed.

## Privacy and integrity

- Generic payload keys containing credentials, tokens, prompts, message
  content and common personal data are redacted recursively.
- Payloads are bounded; oversized redacted summaries become digest-only.
- Before, after and combined payload digests are SHA-256 lowercase hex.
- Event hashes cover the normalized redacted envelope plus the previous hash.
- Evidence Query overlays the currently effective regional retention policy and
  legal-hold state without mutating the canonical event.
- Signed checkpoints bind the scoped chain head, sequence, key identity and
  checkpoint time. Scheduled verification exports low-cardinality integrity,
  checkpoint-lag and outbox-lag metrics.
- When configured, Argus verifies a third-party signed receipt for a WORM copy,
  timestamp or transparency entry. Without a real provider it makes no such
  claim. H11 can re-download and verify complete retention archives when the
  provider implements retrieval; physical retention deletion remains open.

## Fixtures

- `canonical-event-summary.v1.fixture.json` is the exact service summary shape.
- `evidence-page.v1.fixture.json` is the exact Console-facing,
  presentation-enriched query result. Its resource label, href and tags are
  read-model enrichment, not mutable fields in the canonical event row.

## Evidence query API v1

`GET /api/ui/audit/evidence/v1` is fail-closed behind
`ARGUS_AUDIT_EVIDENCE_V1_ENABLED=true`, requires an authenticated principal
with `audit.read`, resolves workspace/tenant scope only on the server and sends
`Cache-Control: private, no-store`.

Supported query parameters are `actor_id`, `actor_type`, `resource_type`,
`resource_id`, `tag`, `action`, `outcome`, `risk`, `policy_id`, `root_run_id`,
`trace_id`, `environment`, `from`, `to`, `limit` and opaque `cursor`. Exact
matches and time bounds are parameterized; pages are ordered by occurred time
and event ID, capped at 100 records and never include `payloadSummary`.

The reader recomputes each v1 event hash and, when one valid signed checkpoint
covers the returned page, returns its ID and
`event_hashes_and_checkpoint_valid`. Page-level verification deliberately does
not claim complete filtered-page chain continuity; the offline Evidence Pack
contains the full redacted chain through its checkpoint for that purpose. The
Tag, `access.user_lifecycle`,
`access.api_key_lifecycle`, `access.policy_management`, `access.sso_identity`,
`approval.runtime`, `approval.workflow` and `risk_policy.external_filter`
producer families are canonical today, so every response still declares the
remaining legacy coverage gap. Assignment events
use the event-time Tag list captured in their redacted payload; other tagged
resources can use current workspace assignments only when clearly marked
`current_live_fallback`.

`audit.export` is evaluated independently. Authorized callers receive
`state: available` and the advertised `json`, `jsonl` and `csv` formats;
unauthorized callers receive no format list.

## H6 APIs and permissions

All endpoints remain behind `ARGUS_AUDIT_EVIDENCE_V1_ENABLED=true`, enforce
same-origin checks for mutations and derive workspace/tenant scope on the
server:

- `GET /api/ui/audit/checkpoints/v1/latest?environment=...` requires
  `audit.read`.
- `POST /api/ui/audit/checkpoints/v1` and
  `POST /api/ui/audit/checkpoints/v1/:checkpointId/verify` require
  `audit.export`.
- `POST /api/ui/audit/evidence-packs/v1` requires `audit.export` plus a stable
  `Idempotency-Key`; the export itself emits canonical audit evidence.
- `POST /api/ui/audit/retention-policies/v1` requires
  `audit.retention_manage`.
- `POST /api/ui/audit/legal-holds/v1` and
  `POST /api/ui/audit/legal-holds/v1/:holdId/release` require
  `audit.legal_hold_manage`.

The two governance permissions are granted only from `operations_admin`
upwards. Raw legal justification is reduced to a SHA-256 digest before
persistence. Evidence-pack export, manual report generation and report artifact
download require `audit.export` plus a fresh provider-verified OIDC MFA
step-up. The signed callback is bound to the existing SSO subject and accepts
only a fresh `auth_time` plus configured `amr`/`acr` evidence. Local sessions
fail closed. Scheduled report generation remains a service operation;
interactive artifact delivery is protected by the human step-up boundary.

## Evidence packs and offline verification

An export is one deterministic JSON container with manifest, exact scope and
filters, generation actor/time, selected canonical events, the complete
redacted chain through the signed checkpoint, Ed25519 public-key metadata,
schema dictionary, control mapping and embedded JSONL/CSV artifacts. The pack
has a SHA-256 digest and declares legacy coverage plus post-checkpoint gaps.
Private keys are never exported.

Exports fail closed beyond 10,000 selected or 50,000 chained events. Larger
datasets still need a multi-segment streaming archival format beyond the H13
genesis-prefix seal. Verify a downloaded
pack without Core or PostgreSQL:

```bash
npm run verify:audit-evidence-pack -- path/to/evidence-pack.json
```

## H7 Evidence reports

Reports are derived from persisted, signed Evidence Packs rather than from an
independent analytics read. On-demand and scheduled runs therefore share the
same scope, redaction, chain verification and declared-gap semantics as an
offline export. Report definitions support daily, weekly and monthly schedules
in an explicit IANA time zone; a restart-safe worker recovers queued and stale
runs without rewriting terminal evidence.

The Console exposes report readiness, recurring definitions, immutable run
history, deterministic PDF/JSON/JSONL/CSV artifacts and append-only human
reviews. Approving or rejecting a report creates a separate canonical audit
event; it never mutates the generated report.

`Generate report now` opens the general platform-report dialog. With no
filters it includes every canonical event in the selected workspace, tenant,
environment and 7/30/90/365-day window. Browser downloads use a neutral,
authenticated content endpoint before creating the local file, so download
manager extensions cannot silently replace the Evidence response. Direct API
clients retain the normal attachment endpoint. Both variants expose a
per-artifact SHA-256 `Content-Digest`; the Evidence Pack digest remains a
separate provenance value.

Relevant endpoints are:

- `GET /api/ui/audit/reports/v1`
- `POST /api/ui/audit/report-definitions/v1`
- `POST /api/ui/audit/report-definitions/v1/:definitionId/disable`
- `POST /api/ui/audit/report-definitions/v1/:definitionId/run`
- `POST /api/ui/audit/report-runs/v1`
- `POST /api/ui/audit/report-runs/v1/:runId/external-anchors`
- `GET /api/ui/audit/report-runs/v1/:runId/artifacts/:format`
- `GET /api/ui/audit/report-runs/v1/:runId/artifacts/:format/content`
- `POST /api/ui/audit/report-runs/v1/:runId/reviews`

Core remains fail-closed unless Evidence v1 and a signing key are configured.
The one-command Docker installer generates a machine-local Ed25519 key and
enables the report path; manual Compose installations opt in through
`compose.audit-evidence.yml`.

## H8 external trust-anchor contract

External anchoring is disabled by default and fail-visible in the Console.
When enabled, only `platform_admin` principals with
`compliance.external_anchor`, verified OIDC/Entra identity, same-origin browser
context, a fresh MFA assertion and a stable `Idempotency-Key` may request it.
The target report must already be completed, signature-verified and belong to
the server-authorized scope.

Argus sends a bounded JSON request to the configured HTTPS gateway. The gateway
must return an Ed25519-signed statement containing:

- `anchorKind`: `worm_object`, `qualified_timestamp` or `transparency_log`;
- the provider name and durable provider reference;
- the scope-bound idempotency key, which the gateway must deduplicate;
- `anchoredAt` and, for WORM, a later `retentionUntil`;
- artifact type `audit_evidence_pack` or `audit_retention_archive`, artifact UUID
  and lowercase SHA-256;
- exact workspace, tenant and environment scope.

Core rejects mismatched identity, key ID, artifact, scope, timestamp window,
retention claim, malformed digest/signature or oversized response. Production
endpoints must use HTTPS; loopback HTTP is available only with an explicit
development opt-in. Provider bearer tokens and public keys are read from
mounted files, not persisted in PostgreSQL or exposed to the browser.

`qualified_timestamp` is a technical receipt category, not by itself a legal
qualification claim. The selected provider, trust-service status, policy,
jurisdiction and operating controls still require customer/legal validation.
An adapter may wrap S3 Object Lock, Azure Immutable Blob, an RFC 3161 service or
a transparency log without changing the Core contract.

## H9 archive-first retention lifecycle

Retention execution starts with an immutable dry-run; it never starts with a
database delete. `POST /api/ui/audit/retention-plans/v1` creates a fresh signed
checkpoint and evaluates the complete audit scope in sequence order. Each event
uses its own explicit `retention_until` or the policy version that was effective
when the event occurred. The result may contain only a contiguous expired prefix
of the canonical chain. Evaluation stops at the first active Legal Hold,
unexpired event, indefinite-retention event, batch boundary or signed-checkpoint
boundary. It never skips a protected record to select later events.

The plan manifest binds every eligible event ID, sequence, event hash, retention
class, deadline, policy version and region to the signed checkpoint and a
SHA-256 digest. Plans and their decisions are append-only. Planning and decision
routes require `retention.execute`, verified OIDC/Entra identity, same-origin,
fresh MFA and an idempotency key. Approval additionally enforces four-eyes: the
requester cannot approve or reject their own plan, and active Legal Holds plus
source hashes are checked again inside the decision transaction.

Relevant endpoints are:

- `GET /api/ui/audit/retention-plans/v1?environment=...`
- `POST /api/ui/audit/retention-plans/v1`
- `POST /api/ui/audit/retention-plans/v1/:planId/decisions`

The Console exposes this under `Audit & evidence → Retention` and marks deletion
as disabled. An approval authorizes only the next archival step. A verified
external archive receipt, purge attestation, segmented-chain format and an
explicitly enabled physical executor remain mandatory before source rows may be
removed. Migration 237 deliberately installs no delete function.

## H10 complete WORM archive and receipt verification

Migration `238_audit_retention_archives.sql` adds an append-only archive receipt
ledger. `POST /api/ui/audit/retention-plans/v1/:planId/archive` accepts only an
independently approved plan and a configured provider supporting
`worm_object`. The route requires `retention.execute`, same-origin, a human
OIDC/Entra identity, fresh MFA, justification and a scope-bound idempotency key.

Immediately before upload Argus re-evaluates retention policies and Legal Holds,
revalidates every planned event ID/hash, verifies every canonical event hash and
link from sequence 1, and verifies the plan's signed checkpoint with its stored
public key. It then sends a canonical package containing the exact redacted
events, plan approval, checkpoint envelope, scope and chain boundaries. The
provider receipt must bind the archive UUID, package SHA-256, workspace, tenant,
environment and a future WORM retention deadline and must pass the configured
Ed25519 trust check.

The immutable local record stores only package metadata and the signed receipt;
the customer gateway owns the archived bytes. The archive UUID is deterministic
for a plan plus idempotency key so a provider success followed by a database
rollback can be retried safely. `archive_verified` still sets
`purgeAuthorized: false`: no delete function or purge endpoint exists in H10.

`compose.worm-demo.yml` is the executable local reference for this boundary.
Its gateway accepts only complete canonical Evidence Pack or retention-archive
payloads, verifies byte count and SHA-256, writes them to a versioned MinIO
bucket with `COMPLIANCE` Object Lock and reads the stored retention metadata
back before signing. `npm run demo:worm:up` also proves idempotent replay, full
retrieval, MinIO-level rejection of a locked-version delete and fail-closed
overwrite behavior.

## H11 independent full-download restore drill

Migration `239_audit_retention_restore_drills.sql` adds append-only successful
restore-verification records. The WORM gateway uses the same authenticated
endpoint for `argus.external-retention-archive-retrieve-request` and returns an
`argus.external-retention-archive-object` wrapper containing the immutable
reference, media type, canonical byte count, retrieval time and full JSON
content.

`POST /api/ui/audit/retention-archives/v1/:archiveId/restore-drills` requires
the dedicated `restore_drill.execute` permission, same-origin, verified human
OIDC/Entra identity, fresh MFA, justification and idempotency. Argus first
re-verifies the stored provider Receipt under the currently configured Ed25519
trust key. It then downloads the object and independently recomputes the
canonical package SHA-256, byte count, tenant scope, plan/manifest binding,
checkpoint signature and every event hash/link from sequence 1. The WORM
retention deadline must still be active.

Only a completely successful drill is written as `verified` and emits the
critical canonical event `audit.retention_restore_drill.verified`. The record
contains no evidence payload and never grants purge. Failed retrieval or any
changed byte fails closed without creating a misleading success proof; the
attempt is retained separately as `audit.retention_restore_drill.failed` with a
bounded reason class and digest rather than untrusted provider text. The
Console displays the latest verification and permits a fresh drill only when
the configured provider exposes both retrieval and stored-receipt verification.

## H12 dependency-free retention archive verifier

`GET /api/ui/audit/retention-verifier/v1` serves
`argus-audit-retention-verifier.mjs` as a protected `audit.export` download.
The file uses only Node.js 20 built-ins and can be moved to an isolated auditor
workstation. It does not contact Argus, PostgreSQL or any network service.

The auditor supplies the WORM archive JSON (or its retrieval wrapper), the
detached provider receipt and the trusted provider Ed25519 public key. The
verifier recomputes the provider statement and receipt digests, verifies the
provider signature and trust-key fingerprint, binds archive ID/SHA-256/scope,
recomputes every canonical event hash/link and verifies the embedded checkpoint
signature. It reports the current WORM-window state separately and always
asserts `purgeAuthorized: false`.

```bash
node argus-audit-retention-verifier.mjs \
  --archive archive.json \
  --receipt receipt.json \
  --provider-key customer-worm-public.pem \
  --expect-provider "Customer WORM" \
  --expect-key-id worm-key-2026
```

## H13 immutable chain-segment seal

Migration `240_canonical_audit_chain_segments.sql` introduces an append-only
ledger of cryptographic segment boundaries. A segment can be sealed only after
its exact WORM archive still has active retention and a successful full-download
restore drill binding package, receipt, checkpoint, range and terminal hash.
Argus serializes the operation on the scoped active chain head, checks the
archived first/last source events and verifies that a currently present next
event links to the archived terminal hash.

`POST /api/ui/audit/retention-archives/v1/:archiveId/seal-segment` requires
`retention.execute`, same-origin, a verified human OIDC/Entra identity, fresh
MFA, justification and idempotency. The immutable seal records its predecessor,
range, WORM and restore proof digests plus `continuationSequence` and
`continuationPreviousHash`. The corresponding critical canonical event is
`audit.retention_segment.sealed`.

H13 v1 seals the first genesis prefix. It creates no `DELETE`, `TRUNCATE` or
purge endpoint, and both the record and Console state explicitly carry
`purgeAuthorized: false`. Multiple physically compacted segments and a disabled-
by-default purge executor remain a separate production phase.

Certify the persistence behavior only against an explicitly disposable,
fully migrated database with `npm run certify:canonical-audit` and
`CANONICAL_AUDIT_CERTIFICATION_DATABASE_URL`. The gate covers atomic commit and
rollback, same-scope replay, equal producer keys across isolated tenant scopes,
independent hash-chain heads, redaction, append-only protection, durable retry,
the real Tag producer, concurrent first-user exclusion, the real admin-managed
user and API-key lifecycles, verified OIDC provision/sync/replay with raw-group
exclusion, runtime/workflow approval decisions, the external runtime-policy
lifecycle, signed checkpoint replay and key rotation, retention/legal-hold
overlays, evidence-pack tamper detection, scheduled integrity/outbox-lag
monitoring, and all eight user/group policy mutation shapes, including
idempotent replays, deny-row preservation plus password/API-key plaintext
exclusion.
