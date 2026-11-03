-- Migration 027: Fallback Configuration

CREATE TABLE IF NOT EXISTS mcp_fallbacks (
  id SERIAL PRIMARY KEY,
  model_group VARCHAR(128) NOT NULL,
  fallback_group VARCHAR(128) NOT NULL,
  trigger_errors TEXT[] DEFAULT '{}',
  retry_count INTEGER DEFAULT 1,
  retry_delay_ms INTEGER DEFAULT 1000,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fallbacks_group ON mcp_fallbacks(model_group, fallback_group);
