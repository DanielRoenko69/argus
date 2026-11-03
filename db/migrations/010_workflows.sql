-- ============================================================
-- Migration 010: Workflow Orchestration Engine
-- ============================================================

-- Workflow definitions
CREATE TABLE IF NOT EXISTS mcp_workflows (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(128) NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  steps         JSONB NOT NULL DEFAULT '[]',
  input_params  JSONB NOT NULL DEFAULT '[]',
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_by    INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wf_name_format CHECK (name ~ '^[a-z0-9_]+$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_workflows_enabled ON mcp_workflows (enabled);
COMMENT ON TABLE mcp_workflows IS 'Workflow definitions with step DAGs stored as JSONB.';
COMMENT ON COLUMN mcp_workflows.steps IS 'Array of step objects: {id, label, tool, args, condition?, depends_on?, on_error?}';
COMMENT ON COLUMN mcp_workflows.input_params IS 'Array of input param defs: {name, type, description, required, default?}';

-- Workflow execution history
CREATE TABLE IF NOT EXISTS mcp_workflow_executions (
  id            BIGSERIAL PRIMARY KEY,
  workflow_id   INTEGER NOT NULL REFERENCES mcp_workflows(id) ON DELETE CASCADE,
  status        VARCHAR(16) NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  triggered_by  VARCHAR(128),
  input_args    JSONB NOT NULL DEFAULT '{}',
  step_results  JSONB NOT NULL DEFAULT '{}',
  error_message TEXT,
  duration_ms   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mcp_wf_exec_workflow ON mcp_workflow_executions (workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_wf_exec_status ON mcp_workflow_executions (status);
CREATE INDEX IF NOT EXISTS idx_mcp_wf_exec_started ON mcp_workflow_executions (started_at DESC);

-- Workflow ↔ Bundle junction
CREATE TABLE IF NOT EXISTS mcp_workflow_bundles (
  workflow_id INTEGER NOT NULL REFERENCES mcp_workflows(id) ON DELETE CASCADE,
  bundle_id   INTEGER NOT NULL REFERENCES mcp_service_bundles(id) ON DELETE CASCADE,
  PRIMARY KEY (workflow_id, bundle_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_workflow_bundles_bundle ON mcp_workflow_bundles (bundle_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_mcp_workflows_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_workflows_updated_at ON mcp_workflows;
CREATE TRIGGER trg_mcp_workflows_updated_at
  BEFORE UPDATE ON mcp_workflows
  FOR EACH ROW EXECUTE FUNCTION update_mcp_workflows_updated_at();
