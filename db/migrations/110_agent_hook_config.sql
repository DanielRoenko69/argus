-- Migration 110 — per-agent tool-hook configuration (P1.3).
-- Posture: ADDITIVE / TIGHTEN-ONLY. extra_destructive_patterns are unioned with
-- the built-in destructive-cmd floor (never replace it); max_tool_calls can only
-- LOWER the cost-budget cap (min(built-in, configured)). Config can never disable
-- a guard. See src/agents/hooks/config.ts.
CREATE TABLE IF NOT EXISTS mcp_agent_hook_config (
  agent_id                    INTEGER PRIMARY KEY REFERENCES mcp_agents(id) ON DELETE CASCADE,
  extra_destructive_patterns  TEXT[]      NOT NULL DEFAULT '{}',
  max_tool_calls              INTEGER,    -- NULL = use the built-in cap (60)
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE mcp_agent_hook_config IS
  'Per-agent additive tool-hook config (P1.3). extra_destructive_patterns union with the built-in destructive floor; max_tool_calls can only lower the cost-budget cap. Never disables a guard.';
