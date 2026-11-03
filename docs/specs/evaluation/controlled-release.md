# Controlled evaluation release — V1 contract

V1 is an explicit, MFA-protected operator decision, not automatic promotion,
four-eyes approval, AI-system production release or compliance certification.

- A completed, integrity-checked, passing A/B comparison may update the **baseline
  Agent's execution choice only**: model and runtime profile (including the
  profile's evaluated reasoning setting). Other generation parameters must match
  and stay untouched. Identical settings are a no-op and cannot release.
- Both source Agents must still match their frozen evaluations. Prompt, Skills,
  role, safety and Bundle context must match between A/B; credentials and runtime
  workspace/tool/memory policies must not change. No redacted snapshot is restored
  into a live prompt. Existing Knowledge/permissions/credentials remain untouched.
- Preview is read-only and returns a digest binding evidence, source heads and
  exact before/after settings. Confirmation requires the same digest, reason,
  stable idempotency key, platform admin, agents.manage and fresh verified MFA.
- Apply locks the comparison and Agents, rechecks evidence/access/drift, changes
  only the allowlist, and appends an immutable release plus canonical audit/outbox
  in one transaction. No inference, automatic retry or running-session rewrite.
- Rollback is a new immutable decision, not history deletion. It restores only
  the prior settings if the released Agent and effective target are unchanged and
  the old target is still valid. Changes since release block rollback. Each release
  can be rolled back once; retries recheck access and do not repeat mutations.
- UI: completed comparison → Review execution release → before/after + limits →
  explicit confirmation; release history offers a separately confirmed rollback.
- Tests: gate/integrity/no-op/context mismatch, MFA/scope, drift, two competing
  releases, idempotent replay, disabled old target, rollback and audit rollback.

Full prompt/Skill version promotion, independent approver, and governed AI-system
release integration remain subsequent work. Passing answer-only tests do not
prove successful tools, CI, production readiness or statistical significance.
