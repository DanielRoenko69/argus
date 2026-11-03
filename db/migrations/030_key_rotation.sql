-- Migration 030: Key rotation support

ALTER TABLE mcp_api_keys
  ADD COLUMN IF NOT EXISTS rotation_schedule VARCHAR(16) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS next_rotation_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS previous_key_hash TEXT DEFAULT NULL;

COMMENT ON COLUMN mcp_api_keys.rotation_schedule IS 'daily | weekly | monthly | quarterly';
COMMENT ON COLUMN mcp_api_keys.next_rotation_at IS 'When the next automatic rotation is scheduled';
COMMENT ON COLUMN mcp_api_keys.previous_key_hash IS 'Hash of the previous key (grace period allows both)';
