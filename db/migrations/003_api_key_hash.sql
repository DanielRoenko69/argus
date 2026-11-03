-- Migration 003: Store key hash + suffix for DB-managed API keys
ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS key_hash VARCHAR(64) DEFAULT NULL;
ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS key_suffix VARCHAR(4) DEFAULT NULL;
COMMENT ON COLUMN mcp_api_keys.key_hash IS 'SHA-256 hash of the full API key (NULL for env-only keys)';
COMMENT ON COLUMN mcp_api_keys.key_suffix IS 'Last 4 characters of the key for display';
CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_hash ON mcp_api_keys (key_hash) WHERE key_hash IS NOT NULL;
