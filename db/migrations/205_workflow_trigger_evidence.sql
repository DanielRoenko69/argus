-- Persist webhook provenance with each workflow execution and use the
-- provider delivery identifier as a cross-replica idempotency boundary.

ALTER TABLE mcp_workflow_executions
  ADD COLUMN IF NOT EXISTS trigger_evidence JSONB NOT NULL DEFAULT '{}'::JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_webhook_delivery
  ON mcp_workflow_executions (
    workflow_id,
    (trigger_evidence->>'source'),
    (trigger_evidence->>'event_id')
  )
  WHERE trigger_evidence ? 'event_id'
    AND trigger_evidence->>'event_id' <> '';

CREATE INDEX IF NOT EXISTS idx_workflow_execution_trigger_source
  ON mcp_workflow_executions (
    (trigger_evidence->>'source'),
    (trigger_evidence->>'received_at') DESC
  )
  WHERE trigger_evidence <> '{}'::JSONB;

COMMENT ON COLUMN mcp_workflow_executions.trigger_evidence IS
  'Authenticated trigger provenance: source, provider event/delivery ID, event type, receipt time and payload fingerprint.';
