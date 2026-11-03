-- Migration 118: per-model vision capability flag. Gates the chat image-upload button.
ALTER TABLE mcp_models ADD COLUMN IF NOT EXISTS supports_vision BOOLEAN NOT NULL DEFAULT false;
-- Seed known multimodal models (safe no-ops if absent).
UPDATE mcp_models SET supports_vision = true
  WHERE model_name IN ('gemini-2.5-flash','gpt-4o','gpt-4o-mini','gpt-4.1','claude-3-5-sonnet','claude-sonnet-4');
