-- Migration 031: Request size limits

ALTER TABLE mcp_models
  ADD COLUMN IF NOT EXISTS max_request_size_bytes INTEGER DEFAULT NULL;

ALTER TABLE mcp_api_keys
  ADD COLUMN IF NOT EXISTS max_request_size_bytes INTEGER DEFAULT NULL;

COMMENT ON COLUMN mcp_models.max_request_size_bytes IS 'Maximum request body size in bytes for this deployment';
COMMENT ON COLUMN mcp_api_keys.max_request_size_bytes IS 'Maximum request body size in bytes for this key (overrides deployment)';
