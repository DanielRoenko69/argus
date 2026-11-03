-- Migration 011: Builtin backends in DB
-- Allows K8s, Grafana, OpenSearch, PostgreSQL to be managed as DB rows instead of ENV-only.

-- Extend backend_type to include 'builtin'
ALTER TABLE mcp_backends DROP CONSTRAINT IF EXISTS mcp_backends_backend_type_check;
ALTER TABLE mcp_backends ADD CONSTRAINT mcp_backends_backend_type_check
  CHECK (backend_type IN ('http', 'mcp', 'builtin'));

-- Identifier for builtin backends: 'kubernetes', 'grafana', 'opensearch', 'postgresql', 'meta'
ALTER TABLE mcp_backends ADD COLUMN IF NOT EXISTS builtin_key VARCHAR(32) DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_backends_builtin_key
  ON mcp_backends (builtin_key) WHERE builtin_key IS NOT NULL;

-- Extra config JSONB (e.g. K8s cluster configs, OpenSearch-specific settings)
ALTER TABLE mcp_backends ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN mcp_backends.builtin_key IS 'Unique identifier for builtin backend type: kubernetes, grafana, opensearch, postgresql, meta';
COMMENT ON COLUMN mcp_backends.config IS 'Backend-specific config (e.g. K8s clusters, OpenSearch credentials)';
