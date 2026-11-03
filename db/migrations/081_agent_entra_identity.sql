-- Migration 081: Per-agent Entra ID Service Principal tracking
--
-- Argus's agentStore lifecycle (createAgent / deleteAgent) calls into the
-- Entra SDK Sidecar to spawn / soft-delete a Service Principal per agent
-- from a Blueprint (template). The columns below persist the resulting
-- Entra IDs + sync state so the admin UI can surface failures without
-- breaking the agent runtime path.
--
-- Failure mode: when ENTRA_AGENT_REGISTRATION=true and a Graph call fails,
-- the agent row is still created (fail-open). entra_sync_error captures
-- the human-readable cause; entra_synced_at remains NULL. The admin UI
-- offers a "resync" button that retries.
--
-- Source pattern: Microsoft "Agent ID capability" + "Identity Blueprint".

ALTER TABLE mcp_agents
  ADD COLUMN IF NOT EXISTS entra_object_id   UUID,
  ADD COLUMN IF NOT EXISTS entra_app_id      UUID,
  ADD COLUMN IF NOT EXISTS entra_blueprint_id TEXT,
  ADD COLUMN IF NOT EXISTS entra_synced_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS entra_sync_error  TEXT;

CREATE INDEX IF NOT EXISTS idx_mcp_agents_entra_object ON mcp_agents (entra_object_id);

COMMENT ON COLUMN mcp_agents.entra_object_id IS
  'Entra Service Principal Object ID, populated after successful Graph create. NULL when Entra-integration disabled or sync failed.';

-- Extend immutable audit log with two new event types for the Entra path.
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
    'tool_hook_decision',
    'entra_sp_provisioned',
    'entra_sp_deleted',
    'entra_sync_failed'
  ));
