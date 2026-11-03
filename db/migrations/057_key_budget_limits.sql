-- Per-model budget limits within a virtual key
-- Format: [{"model":"gpt-4o","max_budget":5.00,"budget_duration":"30d"}]
ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS budget_limits JSONB DEFAULT '[]'::jsonb;
-- Also ensure metadata column exists (used for per-key logging overrides)
ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
