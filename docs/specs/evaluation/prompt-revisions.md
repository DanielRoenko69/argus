# Evaluated Agent prompt revisions — V1

Scope: installed Agent system prompt only. No model, Skill, Knowledge, tool,
credential or permission changes; no independent reviewer or production approval.

- An authorized administrator saves an immutable prompt draft bound to the exact
  current Agent head. Saving a correction creates another revision, never edits
  the previous draft. The active Agent is unchanged. Redaction-changing prompts
  are rejected instead of silently publishing a modified prompt.
- A comparison may select a saved draft for candidate B only. Both sides use the
  same Agent, current model/runtime, parameters and frozen dataset. Core resolves
  and verifies the revision; no arbitrary prompt override is accepted by runners.
- Draft history retains its original Bundle access boundary even after the Agent
  moves to another Bundle. Current Agent access alone cannot expose old prompts.
- Preflight/save and each candidate dispatch check scope, access, revision digest
  and source head. Saving never dispatches. Starting retains explicit consent.
- Release requires complete passing evidence, unchanged source/configuration,
  a reviewed preview digest, reason, agents.manage, fresh MFA and idempotency.
  Only system_prompt and its revision pointer change, together with the immutable
  decision and canonical audit/outbox. Prompt contents never enter audit payloads.
- Rollback is a separate MFA-bound decision restoring the previous prompt/pointer
  only when no intervening Agent/configuration change occurred. No force overwrite.
- Native Agent runs record the loaded system-prompt digest and revision pointer;
  evaluations record the frozen prompt identity. These identify the Agent prompt,
  not the entire dynamically assembled context. Historical runs are not backfilled.
  Ordinary direct edits invalidate the revision pointer rather than mislabel runs.
- UI includes draft authoring, active/draft comparison, explicit test creation,
  reviewed release, decision history and rollback. Drafts are not selectable in
  normal Agent runs. Local fake-provider tests must prove all mutation boundaries.

Acceptance: no active change on save/evaluation; candidate receives draft and A
receives active prompt; secret rejection; scoped access/replay; stale source;
failed/incomplete evidence; audit-failure rollback; concurrent confirmation;
MFA; rollback drift; revision/decision immutability; dark/light/mobile UI.
