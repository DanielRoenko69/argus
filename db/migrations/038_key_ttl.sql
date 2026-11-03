ALTER TABLE mcp_api_keys
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_expires_at
  ON mcp_api_keys(expires_at)
  WHERE expires_at IS NOT NULL;
