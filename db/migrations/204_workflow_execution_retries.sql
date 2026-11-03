-- Preserve workflow failure evidence while linking each checkpoint retry to
-- the immutable execution it was derived from.

ALTER TABLE mcp_workflow_executions
  ADD COLUMN IF NOT EXISTS retry_of_execution_id BIGINT REFERENCES mcp_workflow_executions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retry_from_step_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS idx_workflow_execution_retry_source
  ON mcp_workflow_executions (retry_of_execution_id, started_at DESC)
  WHERE retry_of_execution_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_execution_active_retry
  ON mcp_workflow_executions (retry_of_execution_id)
  WHERE retry_of_execution_id IS NOT NULL
    AND status IN ('running', 'waiting_for_approval');

COMMENT ON COLUMN mcp_workflow_executions.retry_of_execution_id IS
  'Immutable source execution used to create this checkpoint retry.';

COMMENT ON COLUMN mcp_workflow_executions.retry_from_step_ids IS
  'Failed, invalidated, or previously unsettled workflow steps executed by this retry.';
