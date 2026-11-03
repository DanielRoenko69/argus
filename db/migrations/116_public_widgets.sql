-- Migration 116: Phase 3 — public anonymous homepage widget.
-- Public widget config + anonymous chat sessions + public-RAG isolation +
-- a new immutable-audit event type for public chat turns.
-- NOTE: the master switch PUBLIC_WIDGET_ENABLED defaults to false in config;
-- these tables being present does not expose anything until it is enabled.

CREATE TABLE IF NOT EXISTS mcp_public_widgets (
  id                SERIAL PRIMARY KEY,
  agent_id          INTEGER NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  slug              VARCHAR(128) UNIQUE NOT NULL,
  allowed_origins   TEXT[] NOT NULL DEFAULT '{}',
  enabled           BOOLEAN NOT NULL DEFAULT false,
  greeting          TEXT,
  accent            TEXT,
  rate_limit_per_ip INTEGER NOT NULL DEFAULT 20,      -- requests / minute / IP
  daily_token_cap   INTEGER NOT NULL DEFAULT 200000,  -- per widget / day
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_public_widgets_slug ON mcp_public_widgets(slug);

-- Anonymous chat sessions: distinguish public from user, track origin + hashed IP.
ALTER TABLE mcp_agent_sessions ADD COLUMN IF NOT EXISTS kind    VARCHAR(8) NOT NULL DEFAULT 'user' CHECK (kind IN ('user','public'));
ALTER TABLE mcp_agent_sessions ADD COLUMN IF NOT EXISTS origin  TEXT;
ALTER TABLE mcp_agent_sessions ADD COLUMN IF NOT EXISTS ip_hash TEXT;

-- RAG index visibility: a public agent may only reach indexes marked 'public'.
ALTER TABLE mcp_rag_indexes ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','public'));

-- Widen the immutable-audit event_type whitelist with the public-chat event
-- (same pattern migration 112 used to add 'policy_updated').
ALTER TABLE mcp_immutable_audit_log DROP CONSTRAINT IF EXISTS mcp_immutable_audit_log_event_type_check;
ALTER TABLE mcp_immutable_audit_log ADD CONSTRAINT mcp_immutable_audit_log_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'request_success','request_failure','cache_hit','guardrail_block','budget_exceeded',
    'rate_limit_exceeded','tool_hook_decision','entra_sp_provisioned','entra_sp_deleted',
    'entra_sync_failed','codegraph_built','user_policy_block','upstream_token_acquired',
    'upstream_token_revoked','upstream_auth_fallback','upstream_elicitation_required',
    'policy_updated','agent_public_chat'
  ]::text[]));
