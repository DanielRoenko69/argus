-- Migration 014: Add system_prompt and agent_role to service bundles
ALTER TABLE mcp_service_bundles
  ADD COLUMN IF NOT EXISTS system_prompt TEXT,
  ADD COLUMN IF NOT EXISTS agent_role    VARCHAR(128);
