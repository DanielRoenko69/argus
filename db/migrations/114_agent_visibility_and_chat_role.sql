-- Migration 114: per-agent visibility + chat_user role.
ALTER TABLE mcp_agents
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'internal'
  CHECK (visibility IN ('internal', 'public'));

ALTER TABLE mcp_users DROP CONSTRAINT IF EXISTS mcp_users_role_check;
ALTER TABLE mcp_users ADD CONSTRAINT mcp_users_role_check
  CHECK (role IN ('platform_admin','gateway_admin','developer','agent_operator','viewer','chat_user'));
