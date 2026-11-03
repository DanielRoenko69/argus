-- Durable, tenant-scoped idempotency and correlation for the Golden Path.
-- Raw Idempotency-Key values are deliberately never persisted.

CREATE TABLE IF NOT EXISTS mcp_golden_path_runs (
  id UUID PRIMARY KEY,
  workflow_id INTEGER NOT NULL REFERENCES mcp_workflows(id) ON DELETE RESTRICT,
  workflow_execution_id BIGINT UNIQUE REFERENCES mcp_workflow_executions(id) ON DELETE RESTRICT,
  created_by_user_id INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  tenant_key VARCHAR(120) NOT NULL,
  workspace_key VARCHAR(120) NOT NULL,
  environment VARCHAR(120) NOT NULL,
  mode VARCHAR(24) NOT NULL CHECK (mode IN ('certification', 'live_demo')),
  write_mode VARCHAR(24) NOT NULL CHECK (write_mode IN ('read_only', 'guarded')),
  status VARCHAR(32) NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'running', 'waiting_for_approval', 'completed', 'completed_with_gaps', 'rejected', 'failed')),
  idempotency_key_sha256 CHAR(64) NOT NULL CHECK (idempotency_key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  preflight JSONB NOT NULL,
  task_id VARCHAR(200) NOT NULL UNIQUE,
  external_issue_id VARCHAR(300) NOT NULL,
  runtime_task_id VARCHAR(200) NOT NULL,
  error_code VARCHAR(120),
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT mcp_golden_path_preflight_object CHECK (jsonb_typeof(preflight) = 'object'),
  CONSTRAINT mcp_golden_path_completion CHECK (
    (status IN ('completed', 'completed_with_gaps', 'rejected', 'failed') AND completed_at IS NOT NULL)
    OR (status IN ('starting', 'running', 'waiting_for_approval') AND completed_at IS NULL)
  ),
  UNIQUE (tenant_key, workspace_key, mode, idempotency_key_sha256)
);

CREATE INDEX IF NOT EXISTS idx_mcp_golden_path_runs_scope_started
  ON mcp_golden_path_runs (tenant_key, workspace_key, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_golden_path_runs_status
  ON mcp_golden_path_runs (status, updated_at DESC);

CREATE OR REPLACE FUNCTION update_mcp_golden_path_runs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_golden_path_runs_updated_at ON mcp_golden_path_runs;
CREATE TRIGGER trg_mcp_golden_path_runs_updated_at
  BEFORE UPDATE ON mcp_golden_path_runs
  FOR EACH ROW EXECUTE FUNCTION update_mcp_golden_path_runs_updated_at();

COMMENT ON TABLE mcp_golden_path_runs IS
  'Golden Path journey identity, frozen preflight and mapping to the authoritative workflow execution.';
COMMENT ON COLUMN mcp_golden_path_runs.idempotency_key_sha256 IS
  'SHA-256 digest of the caller Idempotency-Key; the raw key is never persisted.';
COMMENT ON COLUMN mcp_golden_path_runs.preflight IS
  'Frozen, credential-free Golden Path v1 preflight used to authorize and explain this run.';
