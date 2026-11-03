# Evaluation contract — E0/E1/E2/E3a/E3b/E4/E5

[Skill revisions](skill-revisions.md) pin Agent inputs to immutable content.
Same-Agent/model comparisons can replace one saved Skill revision on B; reviewed
MFA release changes one Agent binding only. Imports never move existing pins.

The user-facing starter catalog now provides **24 additional synthetic decision
tasks** in two versioned sets (`src/evaluation/starterSets.ts`). Explicit import
creates an atomic draft, not an active dataset or experiment. Human-reviewed
trace/span capture binds a redacted preview digest and independent expectations
to an authorized source; it never infers truth from the recorded answer.
See curation contract and runbook.
The Quality Inbox joins failed traces, active
human feedback and failed frozen evaluation results into an admin review queue.
Human decisions are append-only and audited; changing evidence reopens the review
without changing the original run or automatically invoking a model.
The original fixtures below remain unchanged for deterministic certification.

These are synthetic fixtures, not live measurements, customer content, compliance
certification or proof of model quality. `curated-cases.v1.json` contains 12 small
Dev-review/AIOps cases; `smoke: true` selects exactly three. Every case includes a
correct answer, a wrong **non-empty** answer, empty output and a provider error.
Known usage is explicitly `source: fixture`; unknown usage stays null.

## Deterministic judge contract

`rules.v1.schema.json` and `src/evaluation/contracts.ts` define the same closed
contract. All assertions are mandatory and equally weighted. Empty/whitespace
output fails regardless of exclusion assertions. Provider failures are errors,
not quality failures. The initial score is passed assertions / total assertions;
passing requires all assertions. No LLM judge, arbitrary code, regular expression,
network schema reference, normalization, case folding or fuzzy matching is implied.

- `text_equals`: exact, case-sensitive comparison of the complete output.
- `text_includes` / `text_excludes`: case-sensitive literal substring checks.
- `json_object`: parse the complete output (no Markdown fences); require a JSON
  object, not an array/null, with each named own property. Additional fields are allowed.
- `json_field_equals`: parse JSON and walk only own properties of non-array
  objects along the explicit path; compare the scalar with strict type equality.
  Missing fields, type mismatch, unsafe prototype keys or invalid JSON fail.

`expected_output` is curated reference evidence, not an implicit judge. Explicit
`rules` are mandatory so the same answer has one unambiguous interpretation.
Both expectations and rules enter the immutable dataset digest. Redaction happens
before hashing; inspect the stored redacted cases before activating a version.

## Staged delivery

E1 freezes datasets/configuration and validates access. E2 adds the dedicated
native API executor and the judges above. New native snapshots start with HTTP
202 after an audited claim; old E1 snapshots/external runtimes return HTTP 409
`EVALUATION_EXECUTOR_NOT_READY`. Historical records return `EVALUATION_LEGACY_SMOKE`.
No automatic retry, sessions, tools, RAG, memory or LLM judge. Each case uses a
new request, checks current access/routing and appends result plus native trace
and canonical audit. The comparison returns `comparison_state` passed/failed,
inconclusive for incomplete evidence, or not_comparable for incompatible/legacy
evidence. An eligible comparison can still fail mandatory criteria.
E3a adds renewable worker leases, append-only attempt starts and recovery.
Worker loss becomes `interrupted` after lease expiry; complete recorded case
evidence can be finalized without another request. A late worker is fenced out.
Startup and periodic recovery never dispatch a provider request.

E3b adds immutable paired plans and per-round baseline links. Both configurations
are frozen once in the same audited transaction, then cloned for explicit repeats.
Parent and child leases fence scheduling and evidence commits. Failure or restart
never automatically schedules further experiments. All planned rounds must complete
before an overall gate can pass; mandatory candidate rules apply to every round.
This is a configuration comparison, not a claim of statistical significance.

E4 adds guided cases, catalog targets, a provider-free preview and per-case A/B
answers. Preview returns a stable digest over its parsed input, dataset digest
and both resolved configurations. The UI submits it on save; a changed review
returns `EVALUATION_PREFLIGHT_CHANGED` before any experiments commit. Target
discovery and preview have the same admin/workspace boundaries as execution.
The latest attempt determines the displayed answer; a newer unfinished attempt
must never be hidden behind an earlier passing result. 

The standalone aggregate regression endpoint is explicitly a simulation; historical
non-empty output scores cannot be promoted into a quality comparison.

E5 adds versioned JSON and flat attempt CSV for complete paired evidence, including
failed quality gates. Export requires admin/audit.export, fresh provider-verified
MFA, current authorized scope/Agent/Bundle access, source digest validation and
a committed canonical audit event before delivery. Repeat keys bind exact artifact
bytes. Forced redaction, formula-safe CSV, private no-store and a 16 MiB byte bound
apply. Hashes are integrity checks, not signatures or WORM/compliance guarantees.
`npm run demo:evaluation` starts an isolated disposable local fixture; live model
quality and live SSO remain separate. See exports and demo.

## API usage

### Pinned Codex subscription executor

`argus.codex-reference.v1` is a separate subscription executor, not
the normal Agent runner. It pins CLI/model/reasoning/auth-reference and frozen
input; the sidecar bounds dispatch to one request and rejects tool/intermediate
output before the CLI sees it. Same-model A/B is valid repeatability evidence,
not a requirement to add API aliases. Core rechecks profile drift and readiness
per case. Old snapshots are never upgraded; usage/model/cost omissions stay
unknown. Normal runtime runs are unchanged. Readiness is enabled only
for CLI 0.146.0 / gpt-5.6-terra with ChatGPT auth and supported reasoning.
Other versions/models remain blocked; old snapshots are not promoted. PDF
marks Agent API temperature/output defaults as not applied to Codex. See the current
adapter contract and acceptance record.

### Dataset and experiment API

Admin session, same-origin and server-authorized tenant/workspace scope are
required. Start with `POST /api/admin/evaluations/datasets`, append cases to
`/datasets/:id/cases`, then activate `/datasets/:id/activate`. Case bodies use
`case_key`, `input`, `expected_output`, `context`, and the fixture's `rules`;
`fixture_responses`, `domain` and `smoke` are test metadata, not API fields.
Create a snapshot with `POST /experiments` and `dataset_id`, `model_ref`, optionally
`agent_id`. The model must be an unambiguous enabled API alias, or exactly the
model on the Agent's runtime profile. Credential overrides are not accepted:
`credential_ref`, if supplied, must match the resolved `profile:<id>`.
Do not supply keys, tokens or production secrets in any content field.

`GET /experiments/:id` includes `attempts`, `cancellation_requested`,
`lease_expires_at`, and `progress` (total/completed cases, recorded/pending attempts,
retryable case IDs). `POST /experiments/:id/cancel` accepts `{}` and returns 202.
Cancellation is durable across replicas and best effort at the provider boundary;
it does not promise zero billing. Poll until terminal.

`POST /experiments/:id/retry` requires an `Idempotency-Key` and
`{"case_ids":[123],"acknowledge_possible_duplicate_cost":true}`. Select only IDs
from `progress.retryable_case_ids`. Failed/cancelled/interrupted native runs can
retry missing or technically erroneous cases, never a previously judged answer
(even failed assertions). Keys bind the actor, authorized workspace/environment,
experiment and selected IDs. Identical replay cannot dispatch again; changed
selection returns 409. Access, frozen digests and routing are revalidated.
Results and attempt starts stay append-only. The latest attempt determines each
case's quality; all attempts contribute to usage/cost coverage, including unknown
outcomes. Technical retry history cannot hide prior quality failures.

Active datasets are immutable. To change cases/rules, create a new version and
explicitly curate its content. Legacy versions are read-only and remain labelled.
Unscoped Agent/Bundle/model catalogs can only be referenced from `default/default`.
Non-default workspaces can curate independent datasets but cannot bind those catalogs.

## Paired API

### Result exports

`GET /comparisons/:id/export?format=pdf|json|csv` and `/export/content` share
admin, `audit.export`, same-origin, fresh provider-verified MFA, scoped access
and canonical audit-before-delivery. All planned pairs must be complete; failed
quality gates are valid export evidence. One stable Idempotency-Key per format.
JSON schema remains `argus.evaluation.comparison-export.v1`; PDF renderer is
`argus.evaluation.pdf.v1`, using the same verified/redacted payload. Separate
payload and artifact digests bind projection vs exact file bytes. Reports do not
dispatch a model. PDF includes configuration, rounds/gates, case verdicts, all
attempt measurements, scope/provenance and limitations. Raw prompts/context/
answers are JSON-only, display excerpts are labelled, unsupported font characters
are shown as U+ notation. No active links, scripts or remote resources. Stable
completion timestamps and one cached logo embedding preserve deterministic bytes.
Max 200 pages/16 MiB; HTTP 413 `EVALUATION_PDF_TOO_LARGE`, no partial PDF.
This is unsigned result evidence, not a compliance certification, signed Audit
Report, WORM anchor or trusted timestamp.

### Create and execute

`POST /api/admin/evaluations/comparisons` requires `Idempotency-Key`, `name`,
`dataset_id`, `baseline` and `candidate`. Each target has `model_ref` and optionally
`agent_id` (otherwise the dataset default), `credential_ref` (confirmation only).
`repetitions` defaults to 1, accepts 1–10; `order_mode` defaults to `alternating`
(A→B, B→A by whole dataset) or `baseline_first`. An invalid B rolls back A too.
No paid calls are made when saving. Inputs, prompt/Skills, native routing and
same-round baseline references are pinned; user content never enters audit payloads.

`POST /comparisons/:id/run` requires `{"acknowledge_cost":true}` and a stable
Idempotency-Key. Returns 202 after the atomic parent claim. The saved environment
must match. Queued children run sequentially, each with normal access/routing
preflight. Child `/run` cannot bypass the parent schedule. Transport failure stops
the series after the current experiment; failed assertions do not repeat answers.
`POST /comparisons/:id/cancel` requires `{}` and a key. Future children stay queued.
Cancellation cannot guarantee remote provider completion/billing stopped.

`GET /comparisons` lists the newest 100 scoped plans. `GET /comparisons/:id`
returns ordered records and summary including planned/remaining requests, round
evidence, cost coverage and the overall gate. Private worker tokens are omitted.
Experiments include `comparison_id` and `comparison_status`; retry eligibility is
blocked while their parent runs. Safe `stop_reason` codes explain interruptions.
To resume, explicitly repair eligible technical children via `/experiments/:id/retry`
first, then confirm a new `/comparisons/:id/run` action with a new key. Completed
children are skipped; their answers never overwritten. Reuse the original key
after an uncertain HTTP response, not a new key that could authorize more work.
All old attempts and unknown cost gaps remain included, not just successful retries.

Verification: `npm test -- --runInBand src/evaluation/__tests__` and the disposable
PostgreSQL certification gates. Native tests use a localhost fake provider,
never a paid model. Starting a real experiment is a separate explicit action.

## Controlled execution release

System-prompt-only drafts now have a separate [revision contract](prompt-revisions.md)
and operator guide. Candidate B may
reference a saved `prompt_revision_id`, with the same explicit Agent/model as A.
The active Agent stays unchanged until the separate MFA-bound prompt release.

The additive [V1 release contract](controlled-release.md) defines explicit
MFA-protected model/runtime adoption and rollback. It does not replace AI-system
production approval or introduce automatic score-based deployment.
