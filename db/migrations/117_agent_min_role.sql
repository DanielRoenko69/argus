-- Migration 117: per-agent minimum role for the chat window.
-- NULL = visible/usable by all roles (default, backward-compatible).
-- When set, only callers whose role weight >= this role's weight may see/use
-- the agent (weight-based, evaluated via hasRole() in code). Admins are never
-- accidentally locked out because higher-weight roles always pass.
ALTER TABLE mcp_agents ADD COLUMN IF NOT EXISTS min_role VARCHAR(20)
  CHECK (min_role IS NULL OR min_role IN
    ('platform_admin','gateway_admin','developer','agent_operator','viewer','chat_user'));
