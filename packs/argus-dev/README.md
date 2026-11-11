# Argus Dev

## Compatibility with Argus Core

The current opt-in Workspace-session, independent-QA, code-generation/import
recovery, environment repair and grant-renewal path needs the matching Argus Core
and Agent Workspace sources. Both live in this repository (Core at the repository root). Copy neither machine-local image IDs nor OAuth state.

`npm test` tests this Pack standalone (also in its Docker build; Bash is installed
in the test stage). Run `npm run test:contracts` separately with the matching Core
checkout to verify all three wire-contract copies. Set `ARGUS_CORE_ROOT` if Core
is not the repository root two levels above this Pack. This gate fails on a missing
or different contract; Core's new workstation source-build wrapper always runs
it before building. No live model calls or human approvals are performed by it.

Governed software-delivery Solution Pack for Argus Core.

Argus Dev turns repository work into durable, reviewable delivery workflows.
It owns the LangGraph state machines and checkpoint data; Argus Core remains the
single authority for agents, models, credentials, MCP bundles, execution grants,
human approvals, audit and observability.

## Current workflow catalog

Pack manifest version: `0.4.0`.

| Workflow ID | Purpose | Required bundle categories |
|---|---|---|
| `ticket-to-pull-request` | Plan, implement, test, review, approve and create a PR | repository, CI |
| `pull-request-review` | Inspect and validate an existing PR, optionally apply feedback | repository |
| `ci-failure-recovery` | Diagnose a failed provider run, patch it and resume CI | repository, CI |
| `security-remediation` | Triage and remediate a scanner finding with approval gates | repository, security |
| `release-notes` | Build and review evidence-backed release notes | repository |
| `backlog-grooming` | Backlog Planning: turn a broad issue into reviewed vertical slices | repository |

Backlog Planning retains its API ID `backlog-grooming` and graph ID
`backlog_grooming` for existing tasks/checkpoints. Its workspace is derived from
`backlog_id`; Core must bind that same sanitized ID in the execution grant before
dispatch, not wait for the Pack to seed `ticket_id`. Code indexing still requires
the exact workspace-bound grant and selected Code Intelligence bundles.

External CI/CD remains provider-owned. Argus Dev does not replace GitHub
Actions, Gitea Actions, GitLab CI or Jenkins; it creates the branch/PR handoff,
persists the external run identity and resumes the graph when the provider
reports a terminal result.

## Architecture and trust boundary

```text
Argus Console / API
        │ workflow.start
        ▼
Argus Core
  ├─ validates user and bundle capabilities
  ├─ resolves logical Agent roles to Core model/runtime profiles
  ├─ issues a short-lived signed execution grant
  └─ records the root trace, approvals and audit evidence
        │ A2A
        ▼
Argus Dev
  ├─ validates workflow input
  ├─ persists thread, run and LangGraph checkpoints
  ├─ invokes only grant-bound Core Agents
  ├─ interrupts at human and external-CI gates
  └─ publishes durable task and delivery evidence
        │ governed MCP calls
        ▼
Repository provider · workspace sandbox · CI provider · RAG
```

The workflow contains logical roles such as planner, knowledge, coder and
reviewer. Their concrete model and subscription/provider runtime are configured
only in Argus Core. A TypeScript graph cannot silently replace that choice.

Repository and CI access must arrive through a Core bundle. The Pack never
receives a broad, permanent provider credential and cannot call a tool outside
the catalog embedded in its execution grant.

### Subscription-runtime HTTP deadlines

Direct Codex and Claude calls keep the HTTP response channel open for the full
configured worker budget. `ARGUS_CODEX_TIMEOUT_SEC` / `ARGUS_CLAUDE_TIMEOUT_SEC`
default to 900 seconds per Agent invocation (clamped to 30–1800 seconds), not per
whole workflow. The HTTP deadline is that budget plus 30 seconds of response
grace: 930 seconds with the default configuration. A dedicated Undici dispatcher
raises the response-header/body ceiling to 1830 seconds; the per-call abort signal
enforces the narrower configured deadline. Ordinary requests and the global
dispatcher are unchanged. A body field such as `timeoutSec` alone does not extend
Node's default HTTP response-header timeout.

This does not extend the worker's execution budget, bypass approval or add retries.
Run-ID-scoped cancellation remains active while waiting. Errors distinguish worker
HTTP errors, response-header/body timeouts and the total HTTP deadline; safe
transport cause codes are retained without nested payloads/headers. Unfinished
workspace changes and historical failures are not rewritten by this fix.

Provider-free verification:

```sh
npm test
npm run certify:cancellation
npm run build
node scripts/certify-runtime-http.mjs
```

The last check takes just over five minutes and returns real loopback HTTP headers
after 305 seconds. It uses no credentials, model, repository or CI service. Run it
with the deployed Node version/image when changing transport versions; mocked
unit tests alone do not establish that the old 300-second boundary is gone.

### Native code-intelligence handshake

Before a Codex or Claude subscription runtime starts, Argus Dev asks Core to
build or reuse the native code index for the exact grant-bound workspace Git
commit. The Pack cannot choose another filesystem root, repository or commit.
The returned snapshot identity is attached to the Agent response and the Core
root trace.

Select these bundles together for indexed Dev runs:

- the repository/CI bundle used by the workflow;
- `Argus Code Intelligence · Read`;
- `Argus Code Intelligence · Index`.

The subscription-runtime handshake is metadata-only by default. An Argus Core
administrator may explicitly set an external runtime profile to
`bounded_source` and choose result/byte ceilings. For those profiles only,
Argus Dev requests commit-cited excerpts through the same execution grant and
adds them to the worker prompt as clearly delimited untrusted repository data.

Core re-evaluates the policy for every request. Revoking source sharing takes
effect even if Argus Dev still has older runtime metadata in its short-lived
cache. Run evidence retains snapshot IDs, channels and citations but never
copies raw source text into the Pack task record.

Planner, knowledge, coder and reviewer all use this same Core-controlled call
path. Argus Dev reduces each role prompt to ticket-specific paths, endpoints and
identifiers for retrieval, while preserving the complete task prompt for the
runtime. This avoids generic workflow prose suppressing otherwise relevant code
matches and prevents a specialized coder runtime from bypassing Core policy.

### Polyglot project verification

The test stage discovers project components from repository markers instead of
assuming that every workspace is a single Node.js application. One workflow can
therefore verify a polyglot repository component by component:

| Ecosystem | Detected markers | Deterministic verification |
|---|---|---|
| Node.js | `package.json` plus npm, pnpm, Yarn or Bun lockfile | install, test, optional build |
| Python | `pyproject.toml`, `uv.lock` or `requirements.txt` | install and pytest |
| Go | `go.mod` | `go test` and `go vet` |
| Rust | `Cargo.toml` | `cargo test` and `cargo check` |
| Java/JVM | Maven or Gradle build files and wrappers | provider-native test task |
| .NET | solution or project files | `dotnet test` |

Vendored, generated and fixture trees are excluded and discovery is bounded.
Nested packages inherit the nearest workspace lockfile, while changed-file
scoping selects the most specific affected component per ecosystem. A backend
Python change therefore does not trigger an unrelated frontend Playwright suite;
cross-cutting configuration changes conservatively retain the full test set.
Known projects fail explicitly with `TOOLCHAIN_UNAVAILABLE` when their runtime
is missing; they are never silently delegated to an LLM-generated shell
command. The selected profiles, component roots, commands and pass/fail state
are persisted as task evidence and rendered in the Argus Dev run view.

The default Argus Core development workspace contains all listed toolchains.
Set `ARGUS_DEV_MULTILANG=false` only when building a deliberately smaller
workspace image that does not need polyglot verification.

## Runtime contract

The container exposes:

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | liveness |
| `GET /readyz` | database/runtime readiness |
| `GET /.well-known/argus-solution-pack.yaml` | `argus.eu/v1alpha1` pack manifest |
| `GET /.well-known/agent-card.json` | A2A Agent Card and workflow catalog |
| `POST /message:send` | A2A workflow start |
| `GET /tasks/:taskId` | durable A2A task snapshot |
| `POST /tasks/:taskId:cancel` | cancel a task |
| `POST /threads/:threadId/ci` | merge external CI provider evidence and resume |

Compatibility endpoints for thread/run inspection are also available to Core.
Direct workflow execution requires a valid Core-issued grant; knowing the Pack
URL is not sufficient authorization.

## Persistence and recovery

PostgreSQL stores:

- workflow threads and runs;
- A2A task state;
- LangGraph checkpoints and interrupt state;
- external CI correlation data;
- final delivery evidence.

On restart, the Pack reconciles non-terminal A2A tasks and completed workflow
outcomes. Approval and CI waits are durable rather than process-local timers.

## Run with Argus Core

The Docker installer builds and starts Core with all Packs from the repository root:

```bash
docker compose -f compose.install.yml run --rm --build install optimal
```

Or manually from the repository root:

```powershell
docker build -t argus-dev:local packs/argus-dev
docker compose -f docker-compose.yml -f deploy/compose/packs/compose.external-pack.yml up -d --build --wait
```

Open <http://localhost:3000/solutions/argus.dev>. Core discovers the Pack at
`http://argus-dev:2025`, checks its manifest and renders the workflow catalog.

## Standalone development

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

Docker with Pack-local PostgreSQL:

```powershell
docker compose up --build --wait
curl.exe http://localhost:2025/healthz
curl.exe http://localhost:2025/.well-known/argus-solution-pack.yaml
```

The standalone Compose file defaults to Core at
`http://host.docker.internal:3000`. Health and manifest discovery work without
executing a workflow; real execution additionally needs a reachable Core,
workspace and valid Core authorization.

Stop the standalone stack with:

```powershell
docker compose down
```

Use `docker compose down --volumes` only when Pack-local task/checkpoint data
may be discarded.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | Pack HTTP port, default `2025` |
| `POSTGRES_CONNECTION_URL` | durable threads, tasks and checkpoints |
| `ARGUS_URL` | Core API origin |
| `ARGUS_API_KEY` | technical Core identity for integrated local setups |
| `ARGUS_A2A_PUBLIC_URL` | Pack origin advertised to Core |
| `AGENT_WORKSPACE_URL` | isolated repository workspace service |
| `WORKSPACE_SECRET` | workspace service authentication |
| `MAX_REVIEW_RETRIES` | bounded implementation/review loop |
| `ARGUS_CI_CANARIES_*` | explicitly invoked provider connectivity checks |

Provider-specific Git/CI variables in the Core integration compose file are
adapters for local/demo operation. Production access should use scoped secret
injection and Core bundle policy.

## Safety properties

- no Pack-owned model or credential override;
- exact signed Agent and bundle scope per run;
- isolated workspace with path and write validation;
- bounded retry loops and explicit completion criteria;
- human gates before branch/PR actions where the workflow requires them;
- durable external-CI correlation instead of assuming a push succeeded;
- full root-trace correlation across workflow, Agent and MCP calls.

Argus Dev produces delivery evidence; it does not claim that generated code is
safe without the configured tests, reviewer evidence and human decision.

## Opt-in Jenkins delivery dispatch

The durable `external_ci` checkpoint can dispatch explicitly bound Jenkins jobs
after code approval, successful tests/review and an exact branch push. Set
`ARGUS_JENKINS_DISPATCH_TARGETS` to a JSON array of `{repository, gitOrigin,
branchPrefix, job}` (Gitea repositories; simple Jenkins job names). The default
`[]` disables dispatch. Configure `ARGUS_JENKINS_API_ORIGIN`,
`ARGUS_JENKINS_PUBLIC_ORIGIN`, `ARGUS_JENKINS_DISPATCH_USER` and
`ARGUS_JENKINS_DISPATCH_TOKEN` separately; credentials never enter task output.
Targets are operator-owned, not accepted from agent or browser input.

Jobs receive `REPOSITORY`, `BRANCH_NAME`, `COMMIT_SHA`, `BASE_SHA`. The checkout
base is frozen for new workflows; pre-upgrade single-commit deliveries use the
immutable commit's parent. The job must independently verify source identity.
The Core Showcase bootstrap prepares a compatible exact-source Docker CI job.
Core must receive the same `JENKINS_CI_WEBHOOK_SECRET` already configured in
Jenkins. The bootstrap verifies this authenticated return path before activation;
without it, a successful image/test step still cannot complete CI delivery.

A PostgreSQL thread metadata intent commits before dispatch. Replica/callback
coordination uses per-thread advisory locks. A bounded 15-second reconciliation
reads at most 100 pending threads and 100 recent builds per job. Queue/build
matching requires all four source parameters. No automatic repost follows an
ambiguous POST, even after restart; inspect `dispatch_uncertain_operator_review`
against Jenkins before any explicit operator recovery. Preserve receipt history.
Preflight failures before an intent may be checked again. Builds not configured
in this allowlist retain their existing provider-owned trigger path.

Only the existing authenticated provider callback supplies terminal CI truth
and advances to the second human/PR gate. Polling never fabricates success or
approves a PR. Receipts are Pack operational evidence, not a claim of a new
canonical signed business-audit producer. This slice does not add a generic
frontend CI configuration editor or automatic deployment/merge.

## Cooperative workflow cancellation

Core's A2A cancel action is accepted during an active node. The durable thread
first becomes `canceling` (A2A `TASK_STATE_WORKING`); the Console disables the
cancel button and displays the pending acknowledgement. Direct Codex/Claude
workers receive a stop for their exact runtime run ID, never a global stop.
Transient stop failures are retried while the worker is active. Terminal
`canceled` requires the current operation to settle; a dispatched subscription
worker additionally needs an exact runtime termination receipt. Core-native or
managed Agent calls and workspace commands finish their current bounded call
cooperatively. No subsequent graph superstep is started. Already performed
external writes are not rolled back, and external Jenkins jobs are not stopped.

Repeated cancellation is idempotent. Late CI callbacks cannot override the
canceling/canceled status; existing human interrupts and their resume behavior
remain intact. A Pack restart never replays a thread with a durable cancel
request. If the worker receipt is missing or the Pack restarts mid-cancellation,
the pending state requires operator reconciliation: do not declare success,
erase the checkpoint, or re-run it to hide uncertainty. Automatic reconciliation
of that exceptional state is not implemented. Deploy this Dev Pack together with
Core and the Console.

Run `npm test` and `npm run certify:cancellation` for regression coverage. The
latter requires Docker and creates/removes a disposable PostgreSQL container
with a fake workspace/runtime. It exercises real Pack HTTP/database behavior,
scoped cancellation, transient failures, terminal evidence, lost-response
handling, late CI isolation and restart/no-replay without model or Jenkins calls.
It is not a live provider certification.

## Backlog Planning review boundary

The planner and reviewer receive the original issue, constraints and audience.
Review acceptance means ready for a separate human handoff, not implementation,
CI execution, release or PR approval. Missing CI, credentials, accountable owners
or benchmark decisions can remain explicit future prerequisites when the plan
records the decision/setup task, owner role (or explicitly unassigned owner),
acceptance evidence and blocked dependent work. Do not invent completed tests,
approval or unsupported decisions. Contradictions, unsafe scope and untestable
plans still fail review; missing infrastructure alone is not a reason to demand
its creation during this read-only workflow. The bounded revision loop and later
human approvals remain unchanged.

The workflow catalog exposes `reviewPolicy.maxAttempts` for Backlog Planning
from the same constant as the graph's bounded review loop (currently two).
This is current display policy, not execution authority or historical evidence.
Core/Console presents reviewer findings and same-run revision rounds separately
from agent completion and human handoff approval. A canceled run with a retained
next planner node is not running again; previous verdicts remain historical.

## Test development and requirements checkpoints

Ticket-to-PR now runs **Planner → Knowledge → independent QA design → Coder →
Tests → Reviewer** before the unchanged code and functional/PR approval gates.
QA uses a separate read-only reviewer invocation to derive cases and assertions
from the original requirements; the Coder writes implementation and tests. This
is role separation, not a claim of a separate model or an infallible test oracle.
The reviewer compares coverage against the QA design and original requirements.

Planner, QA and Coder return a validated `ready`/`blocked` JSON outcome. A missing
input, no workspace diff, out-of-scope change or unavailable test environment
pauses at `requirements_input`; it is not another implementation attempt.
The owning Core user submits clarification through the separate audited
`/api/coding/threads/:id/requirements` action. Approval payloads cannot resume
this checkpoint; clarification cannot approve code, change Bundles or expand
the explicit file scope. Cancel and configure a new run for scope changes.
Actual assertion failures and review findings retain bounded revision loops.

### Versioned design clarification (new Ticket-to-PR runs)

Fresh governed starts use development contract v2. Existing/checkpoint-resumed
runs keep v1; no stored run, approval or source issue is migrated. Planner, QA
and Coder emit validated typed findings: `design`, `requirement`, `environment`,
`authorization`, `scope`, or `technical_review`. Original brief/frozen issue,
provenance-bound approved handoff, observed repository evidence and generated
plan proposals are distinct sources. A generated plan is never a verified
human handoff. Operator answers are retained separately from the original brief.

Only evidenced design findings from Planner/QA about a proposal/repository can
trigger internal **Planner → QA** correction. Knowledge context/workspace are
retained; QA runs again, with at most two correction rounds per run. A repeated
finding or 20-minute correction window ends automatic clarification. The window
is checked between agent calls, not a new runtime timeout; an in-flight agent
keeps its existing worker budget. Mixed findings, requirements conflicts and
access/scope problems never enter this internal loop. Unresolved design issues
become a technical-review stop, not a request for a nontechnical user to invent
an API. Coder/test-stage blockers still pause instead of auto-replanning writes.

Core Console shows product questions with consequences and optional agent
recommendations, never preselected choices. An answer binds to the exact
question/plan/base/issue version; stale/unknown options and generic `yes` answers
without a selected option fail closed. Access/scope cards cannot be answered
as clarification. Clarification stays owner-bound and audited and cannot alter
Bundles, paths, credentials, approval gates or tests. Code approval still permits
branch commit/push and configured CI; the separate post-CI approval permits PR
creation. Neither gate authorizes a merge. The run summary distinguishes
clarification from approval.

Provider-free regression: `npm test` includes strict contracts, bounded/repeated
corrections, immutable-source clarification and real MemorySaver checkpoints
that still stop at human approval. Core additionally tests owner/version-bound
submission and Console decision controls. These are deterministic fixtures,
not proof of a successful live model run or a correct GEM issue implementation.

`planning_thread_id` imports only a completed, human-approved Backlog Planning
handoff owned by the same principal with its Bundles still authorized. It pins
the repository, Git origin, base commit and content digest. `allowed_files`
optionally narrows repository scope to exact paths, also with a handoff; the
workspace must match the planned base. A separate planning run is optional.
Truncated historical handoffs are rejected, not reconstructed.
New runtime final responses remain complete (256 KiB hard limit); event previews
can still be shortened. Planning handoffs are limited to 60000 characters.

Python `src` layouts use `PYTHONPATH=src python3 -m pytest` in the detected project
root, including scoped/new test files. This prevents an installed package from
silently replacing the modified sources. `uv` projects retain their own synced
environment. Scoped workspace tests do not replace the full external CI suite.

For multiple Jenkins jobs on one repository, select the exact configured
`ci_job`. Ambiguous/unknown jobs fail closed; old CI evidence keeps its original
job identity. A job selection grants no new provider permissions. This delivery
adapter still uses its existing service credential; personal SSO delegation is
not part of this change. Core's legacy `langgraph/` mirror is not this runtime.

## Checkpoint continuation versus a new attempt

### Opt-in technical design policy

`ARGUS_DEV_TECHNICAL_DESIGN_ENABLED=true` freezes technical design policy 1 on
fresh governed Ticket-to-PR starts only; default is off. Existing v1/v2 runs keep
their original behavior. Structured incremental decisions retain stable IDs,
requirement/source evidence and exact QA-reviewed digests. Changed decisions
lose their QA receipt; omitted decisions are preserved. Ready revisions must
resolve every open finding. Coder/reviewer receive this working contract, never
a fabricated human approval. After two corrections, at most one separately
checkpointed investigation uses the same Planner/runtime, followed by independent
QA. Unresolved technical work becomes `canClarify=false`, not an owner answer
form. Core/Pack reject direct answers. Team-assignment/engineer-resume is not included.

New-policy Planner/QA calls require read-only execution: direct Codex requests
`workspace-read-only`; Core-mediated calls narrow the existing signed tools to
`workspace_ls`, `workspace_read`, `argus_code_search`. The direct Claude bridge
is unsupported until it provides an enforced read-only mode; no runtime fallback.
Existing timeouts apply; a separate hard token/cost cap and general isolated
measurement runner are not implemented. Never invent unavailable measurements.

`npm run certify:technical-design` tests real A2A/HTTP/Postgres/LangGraph with
synthetic agents/workspace only, including restart and answer-bypass refusal.
This is not proof of a real-model/GEM run. Canonical design/activation checklist:
an internal design plan (not published).

Ready technical QA also requires structured independent `testCases` with concrete
inputs, expected results, independent oracles, decision references and test-file
targets. These are persisted in the current `qa_test_plan` and review history,
then passed to Coder; accepting the Planner's suggested tests alone is not enough.
An unresolved blocked review may return no cases rather than invent expectations.

Planner/QA prompts explicitly require `outcome.blockers[].evidence` as a string
array. A supplied non-empty scalar citation (at most 2000 characters) is wrapped
once as a singleton list before full schema/integrity validation. No content,
verdict or blocker is changed; missing/invalid evidence still fails closed. The
proposal/review history records its index and SHA-256 of the JSON-encoded original
string, and the workflow log distinguishes this from local test-case-ID repair.
An environment blocker still stops before QA/Coder; no extra model call, retry,
budget reset or approval. Existing checkpoints are not rewritten or resumed.

On Linux the Workspace installs the pinned Codex package's bundled `bwrap` in a
root-owned directory and puts it first on the Codex-only PATH. Its sandbox policy
is unchanged. The isolated experiment executor keeps `/usr/bin/bwrap`; installing
that system package must not silently replace Codex's helper. A missing/unsafe
Codex helper fails before inference, without an unsandboxed fallback.

The explicitly authorized `node scripts/pilot-technical-design.mjs --live` checks
the contracts with up to four real configured Codex runtime calls against a tiny
separate fixture; `--live --design-only` uses at most two. No Coder/delivery or
automatic retry; unchanged role assignments and file hashes are checked. This
internal bridge pilot is **not** full SSO/Core/Pack workflow certification and
never enables the feature. Reports and fixture receipts are retained under the
ignored `test-results/technical-design/<uuid>/`; inspect an interrupted call's
saved run ID before any new dispatch. The Core workspace image's provider-free
`agent-workspace/scripts/probe-codex-readonly.mjs` verifies sandbox read/write and
loopback-network boundaries before spending model tokens.

### Existing checkpoint continuation

The Retry panel offers **Continue from failed step** and **Reconfigure and start
over**. Continuation keeps the same thread, frozen inputs/issue/Bundles and the
existing partial workspace, while recording a new durable run ID. It repeats the
failed node, not individual model tokens; completed planning/knowledge/QA calls
are not repeated. Existing failed run rows and Agent traces remain evidence.

The initial scope is `coding_workflow` before approval/commit/push/CI/PR, with an
exact stopped Codex/Claude runtime receipt. On failure the Pack attempts to save
the matching terminal receipt in thread metadata before the runtime's short
in-memory retention expires. That proof remains usable after history expiry;
live workspace workers always block continuation. Historical failures without
such proof are not backfilled from an empty registry. Missing receipts, other workflow families, active/canceled work,
delivery evidence, drifted repository/base commit, protected changes and missing
checkpoints remain unavailable with a reason. Never force-enable these cases.
The configurable-new-attempt path still permits input/Bundle/runtime changes in
a fresh workspace and requires a fresh source-issue preview.

Core authenticates the original signed scope as provenance only, rechecks live
owner/workspace/Bundle access and capabilities, records an audit request, and
issues a fresh grant. The Pack refreshes Git credentials, checks content hashes
again at execution and holds a PostgreSQL workspace lease. Queue claims are
serialized; raw `retry_failed` is rejected. No approvals are generated or copied.
An interrupted active continuation is not automatically replayed on restart.

Run `npm run certify:checkpoint-retry`: real HTTP/Postgres/LangGraph with fake
Core/workspace/workers, no actual models, SCM or CI. It verifies Coder entry,
retained upstream results, fresh credentials, drift and worker gates, durable
terminal proof after history expiry, duplicate submissions, original failure
evidence and restart safety. The Console and Core
must be rebuilt alongside this Pack. No migration or backend-provider changes.

## Direct Gitea issue binding

In Ticket to pull request, `issue_reference` accepts a URL or local issue number.
Console first reads the issue through Core's authorized MCP tool preview. Start
sends `issue_sha256`; Dev imports through Core again using the signed workspace
grant and fails on drift, missing read permission or a mismatched checkout.
Only the Core-returned snapshot enters metadata/state and role context. Issue
content is untrusted requirements, not instructions to expand authority.
Configured retries require a fresh preview; checkpoint resumes retain the frozen
snapshot. Resulting PRs reference the issue with Related to, not auto-close syntax.

New governed Ticket runs use `development-v1`: empty `allowed_files` lets agents
choose implementation and regression-test paths in the single authorized repo.
An exact list further narrows this. Deterministic pre-test/pre-delivery guards
protect hidden, agent-policy, credential, CI, build/dependency and test-runner
configuration, test deletions, pinned HEAD and ordinary non-executable files.
This is a delivery guard, not a claim that every runtime shell action is sandboxed.
QA/reviewer/human checks still assess whether tests actually cover acceptance.
Use the matching `demo-gem-repository-dev` Jenkins job for normal GEM fixes;
the old showcase/source-slice jobs keep their narrower contracts.
