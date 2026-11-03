-- Migration 119: message-tree — pointer to the tip of the currently-visible branch.
-- NULL = legacy/linear session (no tree); resolves to the whole messages array.
ALTER TABLE mcp_agent_sessions ADD COLUMN IF NOT EXISTS active_leaf_id TEXT;
