-- Migration 078: Add thinking_budget to mcp_agents
--
-- Anthropic extended-thinking feature (Claude 3.7+ / Claude 4) reserves up
-- to N tokens for internal reasoning before the visible answer. Reviewer
-- and Compliance-Auditor agents benefit from deeper edge-case analysis;
-- everyday chat agents do not need it (extra latency + cost).
--
-- Semantics: 0 = disabled (default), >0 = enabled with N token budget.
-- Argus passes `thinking: { type: "enabled", budget_tokens: N }` to
-- Anthropic when this column is > 0 (see claudeRunner.ts / anthropic
-- provider). Min recommended: 1024. Max sensible: 16000.

ALTER TABLE mcp_agents
  ADD COLUMN IF NOT EXISTS thinking_budget INTEGER NOT NULL DEFAULT 0
  CHECK (thinking_budget >= 0 AND thinking_budget <= 32000);

COMMENT ON COLUMN mcp_agents.thinking_budget IS
  'Anthropic extended-thinking budget in tokens. 0 = disabled. Recommended: 0 for chat, 3000 for reviewer, 5000 for compliance auditor.';
