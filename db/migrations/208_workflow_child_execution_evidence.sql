-- First-class parent/child lineage for nested visual workflow executions.
ALTER TABLE mcp_workflow_executions
  ADD COLUMN IF NOT EXISTS parent_execution_id BIGINT
    REFERENCES mcp_workflow_executions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_step_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS parent_item_index INTEGER;

CREATE INDEX IF NOT EXISTS idx_mcp_workflow_executions_parent
  ON mcp_workflow_executions (parent_execution_id, parent_step_id, parent_item_index, started_at);

COMMENT ON COLUMN mcp_workflow_executions.parent_execution_id IS
  'Parent visual workflow execution for a persisted nested workflow run.';
COMMENT ON COLUMN mcp_workflow_executions.parent_step_id IS
  'Parent step that invoked this child execution.';
COMMENT ON COLUMN mcp_workflow_executions.parent_item_index IS
  'Stable zero-based For Each item index; NULL for ordinary sub-workflow calls.';
