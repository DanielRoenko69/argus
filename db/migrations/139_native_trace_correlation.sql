-- Correlate nested Argus executions without depending on an external tracing
-- vendor. Parent links intentionally remain soft references: retention may
-- remove one trace while a related trace is still inside its own retention
-- window, and telemetry writes are queued asynchronously.

ALTER TABLE mcp_observability_traces
  ADD COLUMN IF NOT EXISTS root_trace_id UUID,
  ADD COLUMN IF NOT EXISTS parent_trace_id UUID,
  ADD COLUMN IF NOT EXISTS parent_span_id UUID;

UPDATE mcp_observability_traces
   SET root_trace_id = id
 WHERE root_trace_id IS NULL;

ALTER TABLE mcp_observability_traces
  ALTER COLUMN root_trace_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_observability_traces_root
  ON mcp_observability_traces (root_trace_id, started_at, id);

CREATE INDEX IF NOT EXISTS idx_observability_traces_parent
  ON mcp_observability_traces (parent_trace_id, started_at, id)
  WHERE parent_trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_observability_traces_parent_span
  ON mcp_observability_traces (parent_span_id)
  WHERE parent_span_id IS NOT NULL;

COMMENT ON COLUMN mcp_observability_traces.root_trace_id IS
  'Root execution shared by a workflow, its agents, sub-workflows and subagents.';
COMMENT ON COLUMN mcp_observability_traces.parent_trace_id IS
  'Immediate calling trace; a soft reference so telemetry retention remains independent.';
COMMENT ON COLUMN mcp_observability_traces.parent_span_id IS
  'Span in the parent trace that initiated this nested execution.';
