-- Migration 112 — add 'policy_updated' to the immutable-audit event_type CHECK.
-- P2.3: per-user/per-group RBAC policy changes (composites + allow/deny rules)
-- are now recorded in the tamper-evident hash-chained audit log. Preserves the
-- exact current allowed list (verified via pg_get_constraintdef) + the new value.
ALTER TABLE mcp_immutable_audit_log
  DROP CONSTRAINT IF EXISTS mcp_immutable_audit_log_event_type_check;

ALTER TABLE mcp_immutable_audit_log
  ADD CONSTRAINT mcp_immutable_audit_log_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'request_success', 'request_failure', 'cache_hit', 'guardrail_block', 'budget_exceeded',
    'rate_limit_exceeded', 'tool_hook_decision', 'entra_sp_provisioned', 'entra_sp_deleted',
    'entra_sync_failed', 'codegraph_built', 'user_policy_block', 'upstream_token_acquired',
    'upstream_token_revoked', 'upstream_auth_fallback', 'upstream_elicitation_required',
    'policy_updated'
  ]::text[]));
