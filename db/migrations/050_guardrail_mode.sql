-- Add mode field to guardrails (pre_call / post_call / during_call / logging_only)
ALTER TABLE mcp_guardrails
  ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'pre_call';
