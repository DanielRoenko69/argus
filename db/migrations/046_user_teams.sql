-- Migration 046: Add per-member budget columns to mcp_team_members
ALTER TABLE mcp_team_members
  ADD COLUMN IF NOT EXISTS max_budget    NUMERIC(12,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS current_spend NUMERIC(12,4) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_team_members_team ON mcp_team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON mcp_team_members(user_id);
