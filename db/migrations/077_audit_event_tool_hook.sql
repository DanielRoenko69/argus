-- Migration 077: Add 'tool_hook_decision' to immutable_audit_log event types
--
-- Hook decisions (allow/block/modify) need their own audit trail so DORA
-- Art. 14 / EU AI Act Art. 14 reviewers can answer "what blocked the agent
-- from doing X at time T?". Reuses the existing immutable_audit_log
-- infrastructure (append-only, tamper-evident via row_hash).
--
-- Idempotent: DROP IF EXISTS lets the migration re-run without "already
-- exists" errors, matching the pattern used by other Argus migrations.

ALTER TABLE mcp_immutable_audit_log
  DROP CONSTRAINT IF EXISTS mcp_immutable_audit_log_event_type_check;

ALTER TABLE mcp_immutable_audit_log
  ADD CONSTRAINT mcp_immutable_audit_log_event_type_check
  CHECK (event_type IN (
    'request_success',
    'request_failure',
    'cache_hit',
    'guardrail_block',
    'budget_exceeded',
    'rate_limit_exceeded',
    'tool_hook_decision'
  ));
