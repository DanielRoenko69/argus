-- Provider-neutral settings for the Argus Knowledge adapter registry.
-- Credentials remain encrypted in api_key and are never stored in this JSON.
ALTER TABLE mcp_rag_indexes
  ADD COLUMN IF NOT EXISTS adapter_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN mcp_rag_indexes.adapter_config IS
  'Non-secret provider settings such as content/source/id fields, namespace and auth mode.';
