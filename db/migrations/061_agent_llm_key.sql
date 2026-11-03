-- Per-agent LLM Gateway key for granular cost tracking.
-- When set, the agent uses this specific Gateway key for its LLM calls
-- instead of the global LLM_API_KEY env var.
-- Create keys in /gateway/admin#keys, then assign here or via Agent form.
ALTER TABLE mcp_agents ADD COLUMN IF NOT EXISTS llm_api_key TEXT;
COMMENT ON COLUMN mcp_agents.llm_api_key IS
  'Optional Argus Gateway API key (ak_...) used for this agent''s LLM calls. '
  'Enables per-agent cost tracking in spend_logs. Falls back to LLM_API_KEY env if null.';
