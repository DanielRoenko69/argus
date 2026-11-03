-- Migration 115: per-user + per-group agent-access rules for the chat window.
--
-- Mirrors the tool-RBAC pattern from migration 083 (mcp_user_tool_rules /
-- mcp_group_tool_rules) but for whole AGENTS (discrete agent_id, no globs).
-- Resolution is deny-first + allowlist-when-present: no rule => all internal
-- agents visible (today's behaviour, backward compatible); any allow rule =>
-- only those; a deny always wins. Consumed by resolveAgentAccess() →
-- listChatVisibleAgents() for /chat and /embed/chat.

CREATE TABLE IF NOT EXISTS mcp_user_agent_rules (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES mcp_users(id)  ON DELETE CASCADE,
  agent_id    INTEGER NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  effect      VARCHAR(8) NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  reason      TEXT,
  expires_at  TIMESTAMPTZ,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, agent_id)
);

CREATE TABLE IF NOT EXISTS mcp_group_agent_rules (
  id          SERIAL PRIMARY KEY,
  group_name  VARCHAR(256) NOT NULL,
  agent_id    INTEGER NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  effect      VARCHAR(8) NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_name, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_user_agent_rules_user   ON mcp_user_agent_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_group_agent_rules_group ON mcp_group_agent_rules(group_name);
