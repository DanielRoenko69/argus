-- 028: Webhook Configuration
CREATE TABLE IF NOT EXISTS mcp_webhooks (
  id SERIAL PRIMARY KEY,
  name VARCHAR(128) NOT NULL UNIQUE,
  url TEXT NOT NULL,
  secret TEXT,
  headers JSONB DEFAULT '{}',
  events TEXT[] DEFAULT ARRAY['success','failure'],
  timeout_ms INTEGER DEFAULT 10000,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_webhooks_enabled ON mcp_webhooks(enabled);
