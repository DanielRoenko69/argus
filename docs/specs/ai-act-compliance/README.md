# AI Act compliance enablement contracts

Status: v1 lifecycle contracts plus V2 obligation-mapped compliance dossier
Owner: Core
Consumer: Console
Requirements: `AIA-001` through `AIA-005`

These executable Zod contracts define the first additive Core/Console handoff
for customer-specific AI Act governance. They support a conformity process;
they do not declare an Argus installation or AI system legally compliant.

Contract implementation: `src/compliance/aiActContracts.ts`.

Registry implementation:

- `db/migrations/230_ai_act_system_registry.sql`;
- `src/compliance/aiSystemRegistry.ts`;
- `src/compliance/aiSystemReadiness.ts`;
- `src/compliance/aiSystemRoutes.ts`.

Production workflow run-gate implementation:

- `db/migrations/231_ai_act_production_run_bindings.sql`;
- `src/compliance/aiSystemWorkflowBinding.ts`;
- `src/compliance/aiSystemRunBinding.ts`;
- `src/workflows/aiActExecutionGate.ts`;
- `src/workflows/triggerWorker.ts` and `src/workflows/executeRoutes.ts`.

OIDC/Entra MFA export-control foundation:

- `db/migrations/232_session_auth_assurance.sql`;
- `src/auth/oidcAuth.ts`, `src/auth/userAuth.ts` and `src/auth/sessionMiddleware.ts`;
- `src/audit/evidenceRoutes.ts` and `src/audit/reportRoutes.ts`.

Immutable lifecycle-governance implementation:

- `db/migrations/233_ai_system_governance_decisions.sql`;
- `src/compliance/aiSystemGovernance.ts`;
- revision, classification and release routes in `src/compliance/aiSystemRoutes.ts`.

## Fixtures

| Fixture | Requirement | Meaning |
| --- | --- | --- |
| `control-catalog.v1.fixture.json` | AIA-001 | Versioned controls with evidence and explicit Argus/customer responsibility |
| `ai-system-revision.v1.fixture.json` | AIA-002 | Immutable intended purpose, roles, Art.-5 decision, classification and components |
| `production-run-binding.v1.fixture.json` | AIA-003 | Exact released system/control/component tuple frozen into a production run |
| `registration-readiness.v1.fixture.json` | AIA-004 | Server-authoritative guided registration state without a false compliance claim |
| `compliance-dossier-manifest.v1.fixture.json` | AIA-005 | Historical offline-verifiable dossier manifest derived from signed Evidence |
| `compliance-dossier-manifest.v2.fixture.json` | AIA-008 | Backward-compatible dossier with a digest-bound Annex IV, Article 17, lifecycle and conformity obligation matrix |

Fixtures are wire examples and test vectors, not legal templates or seed data.

## Invariants

- Registry, control, readiness and runtime-binding `schemaVersion` remains `1`.
- Dossier manifests accept historical V1 and current V2. New dossiers are V2;
  stored V1 artifacts remain byte-stable, readable and verifiable.
- IDs are opaque; the fixture uses UUIDs only where the contract requires them.
- Every system revision binds one exact control-catalog version and SHA-256.
- A high-risk classification requires an explicit legal basis.
- A prohibited system or blocked prohibited-practice decision cannot be released.
- Authorized production execution requires a passed gate and no blocking
  reasons. Interactive humans require a server-verified OIDC/Entra SSO identity;
  scheduled and provider-webhook execution requires a verified workload identity.
- Evidence/readiness counts account for every applicable control.
- Dossier statuses intentionally exclude an automatically derived `compliant`
  value. Independent assessment remains a separate recorded fact.
- Digests are lowercase SHA-256 hex. Contract validation proves shape, not that a
  supplied digest matches bytes; persistence/service layers must recompute it.
- Browser-supplied tenant, system, control and evidence scope is never authoritative.

## Registry API

All endpoints are session-authenticated and enforce named permissions on the
server. Mutations also require a same-origin browser request.

```text
GET  /api/ui/compliance/ai-systems?limit=100
POST /api/ui/compliance/ai-systems
GET  /api/ui/compliance/ai-systems/:aiSystemId?revision=<positive-int>
GET  /api/ui/compliance/ai-systems/:aiSystemId/readiness
POST /api/ui/compliance/ai-systems/:aiSystemId/revisions
POST /api/ui/compliance/ai-systems/:aiSystemId/classifications
POST /api/ui/compliance/ai-systems/:aiSystemId/release
GET  /api/ui/compliance/workflows/:workflowId/ai-system-binding
PUT  /api/ui/compliance/workflows/:workflowId/ai-system-binding
```

| Operation | Permission |
| --- | --- |
| list, detail, readiness | `ai_system.read` |
| create first immutable revision | `ai_system.create` |
| read workflow binding | `ai_system.read` |
| bind/unbind a draft or review workflow | `ai_system.manage` |
| create a derived immutable revision | `ai_system.manage` |
| confirm classification | `ai_system.classify` |
| release independently reviewed revision | `ai_system.release` |
| later suspend operation | separately reserved `ai_system.suspend` |

An `Idempotency-Key` header freezes retry identity for creation and is required
for revision, classification and release decisions. Those three sensitive
actions additionally require a fresh OIDC/Entra MFA session. The server
derives actor, SSO snapshot, workspace/tenant scope, IDs, timestamps and all
digests; callers cannot supply them. The compatibility deployment currently
maps authenticated users to the authoritative `default/default` scope. A later
tenant resolver can replace this centralized boundary without changing stored
revision or canonical audit contracts.

Readiness is an operational evidence-gap projection. It counts registration
steps, flags expired or externally reviewed classifications and keeps control
evidence plus independent review blocking. It never returns a `compliant`
decision.

## Compatibility boundary

The v1 contracts and registry routes are additive. Field removal, rename,
semantic broadening, a new legal status, or a different digest canonicalization
requires v2. Historical revisions and future run bindings must remain
resolvable after later catalog or schema upgrades.

The current producers create the first immutable revision and separate derived
revision, classification and release revisions. They are intentionally not
hidden in generic CRUD: each has a separate permission, canonical event and
MFA-bound decision record. A revision author cannot classify that revision and
the classifier cannot release it. Release evidence references are resolved and
verified server-side before the new immutable release revision is committed.

Sensitive Audit/Evidence exports already require a fresh OIDC/Entra MFA
assurance. Core derives that assurance only from a verified ID token, binds a
step-up callback to the existing SSO identity and stores a bounded timestamp in
the server-side session. Local sessions, missing provider claims and stale
assertions fail closed. Classification and release now consume that primitive;
the technical certification does not certify a customer's concrete IdP policy.

The disposable local MFA lab exercises that boundary with a real Keycloak
Authorization Code + PKCE flow and Microsoft Edge. `npm run demo:mfa:browser`
performs an initial SSO login, a second TOTP step-up bound to the same subject,
returns to the Audit Reports tab and proves both the server-side
`exportSecurity.satisfied` projection and passage through the protected report
action middleware. Its machine-readable result is
`test-results/local-mfa-browser-certification.json`. Keycloak rejects reuse of
the same TOTP time slice; the certification therefore waits for a fresh code
before the second challenge. This lab is technical acceptance evidence only,
not validation of a customer's production IdP or Conditional Access policy.

## Certification

`npm run certify:ai-act-registry` only runs against an explicitly supplied
`AI_ACT_REGISTRY_CERTIFICATION_DATABASE_URL`; otherwise it reports `not_run`.
Against an isolated database initialized through the real install order
(`db/init.sql` plus the complete migration chain), it verified:

- create and idempotent replay;
- workspace/tenant-scoped read and list;
- server-side readiness projection;
- atomic canonical event and transactional outbox;
- database rejection of historical revision updates.

The second migration pass applied zero files. The disposable database was
removed after certification. This is technical evidence for the registry
control, not external legal certification.

`npm run certify:ai-act-production-gate` likewise requires the explicit
`AI_ACT_GATE_CERTIFICATION_DATABASE_URL`. In a disposable PostgreSQL
database it verified an audited workflow association, authorization of a
released revision through verified workload identity, denial of an unverified
identity, exact immutable run-binding persistence, canonical allow/deny events
and database rejection of binding mutation. Unit tests additionally cover
interactive OIDC authorization, local-session denial, real trigger denial and
the sandbox exception. This remains technical control evidence, not a legal
conformity assessment.

`npm run certify:ai-system-governance` requires the explicit
`AI_SYSTEM_GOVERNANCE_CERTIFICATION_DATABASE_URL`. Against the fully migrated
disposable PostgreSQL database it verified assessment reset after material
change, the immutable revision chain, both four-eyes denials, independent
classification and release, server-side content-addressed Evidence resolution,
persisted SSO/MFA assurance, canonical events, idempotent replay and database
rejection of decision updates. The disposable database was removed afterward.

Next implementation slice:

1. [x] migrations for AI systems, revisions, roles and classification assessments;
2. [x] canonical audited initial producer and named permissions;
3. [x] server-side registration/readiness projection and API;
4. [x] governed workflow root-run binding and fail-closed gate;
5. [x] provider-verified OIDC/Entra MFA step-up for sensitive Evidence/report exports;
6. [x] revision/classification/release producers with step-up and four-eyes policy;
7. [x] immutable dossier builder using an exact released revision, a
   release-bound verified signed Evidence Pack, digest-bound JSON/PDF/signature
   artifacts, fresh-MFA exports and canonical generation/export evidence.
8. [x] compliance-console dossier workspace with released-system and verified-
   report selection, integrity/coverage/gap visibility, MFA step-up and
   manifest/JSON/PDF/signature downloads.
9. [x] guided compliance-console AI-system registration with intended-purpose,
   role/classification and immutable component/catalog evidence stages, plus a
   server-projected readiness matrix and protected independent classification
   and report-bound release actions.
10. [x] publish the versioned legal control catalog through a server-owned API
    and persist an append-only, revision-bound control ledger with
    implementation status, owner, due date, verified evidence, time-bounded
    exception and reassessment state. Registration readiness remains a separate
    projection. Release and dossier generation now consume the same legal
    control ledger and therefore fail closed on incomplete or expired
    production-blocking controls. A released revision resolves its immutable
    release-source revision explicitly through `assessmentSourceRevision`;
    assessments are never silently copied to the new lifecycle revision.

11. [x] generate Dossier V2 with 37 explicit requirements grouped by Annex IV,
    Article 17 QMS, lifecycle/deployer duties and the formal conformity route.
    Every requirement records legal references, applicability, owner, expected
    artifacts, verified evidence references, reassessment date and findings.
    Partial, missing and expired requirements become declared gaps; a
    non-high-risk classification marks only genuinely high-risk obligations as
    not applicable. The matrix has its own canonical SHA-256 binding and is
    embedded identically in the manifest, JSON evidence and human-readable PDF.

The V2 implementation is deliberately fail-visible: without an external WORM
anchor and independently validated PDF/A it emits `controls_incomplete` plus
declared gaps. `npm run certify:ai-system-governance` exercises the legal
control gate before independent release; `npm run
certify:ai-compliance-dossier` exercises the released ledger inside the real
PostgreSQL dossier lifecycle and offline verification. External anchoring,
full-download restore proof, a standalone archive verifier and a non-purge
genesis segment seal now exist in the audit subsystem. Real provider
certification, archival PDF/A validation, scheduled customer recovery drills,
multi-segment compaction and physical purge remain future deployment controls;
the dossier is not an automatic legal conformity declaration.
