-- Preserve the existing whitelist and append the HTTP identity-selection event.
-- Do not modify historical audit rows, hash chains or append-only guards.
ALTER TABLE mcp_immutable_audit_log
  DROP CONSTRAINT mcp_immutable_audit_log_event_type_check;
ALTER TABLE mcp_immutable_audit_log
  ADD CONSTRAINT mcp_immutable_audit_log_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'request_success','request_failure','cache_hit','guardrail_block','budget_exceeded',
    'rate_limit_exceeded','tool_hook_decision','entra_sp_provisioned','entra_sp_deleted',
    'entra_sync_failed','codegraph_built','user_policy_block','upstream_token_acquired',
    'upstream_token_revoked','upstream_auth_fallback','upstream_elicitation_required',
    'policy_updated','agent_public_chat','upstream_auth_selected'
  ]::text[]));
