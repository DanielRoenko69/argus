-- Persist the exact workflow checkpoint associated with a runtime approval.

ALTER TABLE mcp_workflow_executions
  DROP CONSTRAINT IF EXISTS mcp_workflow_executions_status_check;

ALTER TABLE mcp_workflow_executions
  ALTER COLUMN status TYPE VARCHAR(32);

ALTER TABLE mcp_workflow_executions
  ADD CONSTRAINT mcp_workflow_executions_status_check
  CHECK (status IN ('running', 'waiting_for_approval', 'completed', 'failed', 'cancelled'));

ALTER TABLE mcp_workflow_executions
  ADD COLUMN IF NOT EXISTS waiting_approval_id BIGINT REFERENCES mcp_runtime_approvals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS waiting_step_id TEXT,
  ADD COLUMN IF NOT EXISTS resume_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS resumed_at TIMESTAMPTZ;

ALTER TABLE mcp_runtime_approvals
  ADD COLUMN IF NOT EXISTS workflow_execution_id BIGINT REFERENCES mcp_workflow_executions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS workflow_step_id TEXT;

CREATE INDEX IF NOT EXISTS idx_workflow_execution_waiting_approval
  ON mcp_workflow_executions (waiting_approval_id)
  WHERE status = 'waiting_for_approval';

CREATE INDEX IF NOT EXISTS idx_runtime_approval_execution
  ON mcp_runtime_approvals (workflow_execution_id, status);
