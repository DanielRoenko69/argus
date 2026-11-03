-- Ownership and trace correlation for workflows started by a personal Hermes
-- through the deliberately narrow Argus Dev MCP bridge.
CREATE TABLE IF NOT EXISTS mcp_hermes_dev_bridge_tasks (
  task_id                 VARCHAR(128) PRIMARY KEY,
  context_id              VARCHAR(128) NOT NULL,
  principal_user_id       INTEGER NOT NULL REFERENCES mcp_users(id) ON DELETE CASCADE,
  api_key_prefix          VARCHAR(64) NOT NULL,
  root_trace_id           UUID NOT NULL,
  origin_session_ref_hash CHAR(64),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mcp_hermes_dev_bridge_origin_hash_check
    CHECK (origin_session_ref_hash IS NULL OR origin_session_ref_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_hermes_dev_bridge_tasks_owner_created
  ON mcp_hermes_dev_bridge_tasks (principal_user_id, api_key_prefix, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_hermes_dev_bridge_tasks_root_trace
  ON mcp_hermes_dev_bridge_tasks (root_trace_id);

COMMENT ON TABLE mcp_hermes_dev_bridge_tasks IS
  'Core-owned identity and trace binding for personal-Hermes initiated Argus Dev A2A tasks.';

COMMENT ON COLUMN mcp_hermes_dev_bridge_tasks.origin_session_ref_hash IS
  'SHA-256 correlation only; the native Hermes session reference is never stored in plaintext.';
