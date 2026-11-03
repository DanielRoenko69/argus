-- Local tool-calling workers need enough output budget to serialize complete
-- workspace_write arguments. The original smoke-test budgets (128/384) were
-- sufficient for prose but truncated real source-file writes.
UPDATE mcp_agents
SET max_tokens = 2048, updated_at = now()
WHERE name = 'coder' AND model IN ('argus-local', 'argus-local-coder') AND max_tokens <= 384;

UPDATE mcp_agents
SET max_tokens = 1024, updated_at = now()
WHERE name IN ('planner', 'knowledge', 'reviewer')
  AND model IN ('argus-local', 'argus-local-coder')
  AND max_tokens <= 384;
