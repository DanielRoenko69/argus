# Evaluated Agent Skill revisions — V1

## Contract

- Migration 265 retains immutable Skill content and provenance revisions. Existing
  assignments are pinned to the exact content present at migration; this is an
  upgrade baseline, not invented historical evidence.
- Library edits/imports publish a new catalog revision without changing existing
  Agent pins. New assignments pin the current catalog revision. Saving/reordering
  an existing assignment and Blueprint upgrades preserve its pin.
- An administrator with `agents.manage` may save a bounded, redaction-clean draft
  for one attached Skill and one Agent in default/default. The source Agent head,
  all current Skill pins and original Bundle scope are bound to the draft.
- A comparison may change one Skill revision OR a prompt revision, never both.
  Both sides use the same Agent, current model/runtime, credentials and context.
  Freeze the exact revision IDs, digests and contents. Drafts never call models.
- Release requires complete passing evidence, unchanged source/context, reviewed
  preview digest, reason, stable idempotency key and fresh provider-verified MFA.
  Update only that Agent's Skill pin. Persist decision, canonical audit and outbox
  atomically. Never update a shared Skill or another Agent as a side effect.
- Rollback restores the previous immutable pin only when the post-release Agent
  and effective context still match. Intervening changes block rollback.
- Current Agent and original Bundle permissions apply to reads, starts, releases,
  rollback and idempotent replays. Drafts are Agent/scope-bound. Content stays out
  of audit summaries. Database constraints forbid history rewrite or cross-Skill
  pins. Disabled Skills fail closed when composing new Agent/evaluation inputs.

## Compatibility and limits

Catalog MCP prompts, explicit Workflow Skill nodes and compliance templates keep
their existing catalog-current semantics; they are not Agent-pinned consumers.
Hermes and narrow Solution Pack workers do not inject Agent Skills today; do not
claim a Skill version was executed on those paths. Native/Codex/Claude Agent turns
record the versions actually loaded. Prior traces/snapshots are not backfilled.
No automatic rollout, four-eyes approval or compliance certification. Library
administration and detach/reattach remain explicit direct configuration changes,
not evaluated release decisions. Live publication of the maintainer Skill is not
part of this work.

## Acceptance

Disposable PostgreSQL + fake-provider/Edge evidence must cover shared-Skill
isolation, import/Blueprint pin preservation, exact A/B inputs, immutable history,
scope/Bundle/draft checks, stale state, redaction/size bounds, MFA/origin/idempotency,
audit failure atomicity, release/rollback and accessible responsive UI. No real
model calls or customer database fixtures are needed.
