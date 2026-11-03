-- Native structured-log correlation for the Argus investigation loop.
-- IDs are deliberately not foreign keys: logging must remain non-blocking even
-- while trace/span inserts are still queued asynchronously.

ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS root_trace_id UUID;
ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS trace_id UUID;
ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS span_id UUID;
ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS agent_id INTEGER;
ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS workflow_execution_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_argus_logs_root_trace
  ON argus_logs (root_trace_id, ts DESC)
  WHERE root_trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_argus_logs_trace
  ON argus_logs (trace_id, ts DESC)
  WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_argus_logs_span
  ON argus_logs (span_id, ts DESC)
  WHERE span_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_argus_logs_agent
  ON argus_logs (agent_id, ts DESC)
  WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_argus_logs_workflow_execution
  ON argus_logs (workflow_execution_id, ts DESC)
  WHERE workflow_execution_id IS NOT NULL;

COMMENT ON COLUMN argus_logs.root_trace_id IS
  'Native Argus trace family used to correlate logs across workflow and Agent hops.';
COMMENT ON COLUMN argus_logs.trace_id IS
  'Native execution trace active when the structured log record was emitted.';
COMMENT ON COLUMN argus_logs.span_id IS
  'Native execution span active when the structured log record was emitted.';
