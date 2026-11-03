-- Backfill the structured lifecycle records that native traces and spans
-- created before correlated info-level logging was introduced did not emit.
-- Exact correlation/message guards keep this migration idempotent and avoid
-- duplicating lifecycle logs already written by the current runtime.

INSERT INTO argus_logs (
  ts, level, msg, data, root_trace_id, trace_id, agent_id, workflow_execution_id
)
SELECT
  trace.started_at,
  'info',
  'Telemetry trace started',
  jsonb_strip_nulls(jsonb_build_object(
    'rootTraceId', trace.root_trace_id,
    'traceId', trace.id,
    'telemetryKind', trace.kind,
    'telemetryName', trace.name,
    'status', 'running',
    'agentId', trace.agent_id,
    'workflowExecutionId', trace.workflow_execution_id,
    'backfilled', true
  )),
  trace.root_trace_id,
  trace.id,
  trace.agent_id,
  trace.workflow_execution_id
FROM mcp_observability_traces trace
WHERE NOT EXISTS (
  SELECT 1 FROM argus_logs log
   WHERE log.trace_id = trace.id
     AND log.span_id IS NULL
     AND log.msg = 'Telemetry trace started'
);

INSERT INTO argus_logs (
  ts, level, msg, data, root_trace_id, trace_id, agent_id, workflow_execution_id
)
SELECT
  COALESCE(trace.ended_at, trace.updated_at),
  CASE WHEN trace.status = 'failed' THEN 'error' ELSE 'info' END,
  CASE WHEN trace.status = 'failed' THEN 'Telemetry trace failed' ELSE 'Telemetry trace finished' END,
  jsonb_strip_nulls(jsonb_build_object(
    'rootTraceId', trace.root_trace_id,
    'traceId', trace.id,
    'telemetryKind', trace.kind,
    'telemetryName', trace.name,
    'status', trace.status,
    'durationMs', trace.duration_ms,
    'inputTokens', trace.input_tokens,
    'outputTokens', trace.output_tokens,
    'error', trace.error_message,
    'agentId', trace.agent_id,
    'workflowExecutionId', trace.workflow_execution_id,
    'backfilled', true
  )),
  trace.root_trace_id,
  trace.id,
  trace.agent_id,
  trace.workflow_execution_id
FROM mcp_observability_traces trace
WHERE trace.status <> 'running'
  AND NOT EXISTS (
    SELECT 1 FROM argus_logs log
     WHERE log.trace_id = trace.id
       AND log.span_id IS NULL
       AND log.msg IN ('Telemetry trace finished', 'Telemetry trace failed')
  );

INSERT INTO argus_logs (
  ts, level, msg, data, root_trace_id, trace_id, span_id, agent_id, workflow_execution_id
)
SELECT
  COALESCE(span.ended_at, span.updated_at),
  CASE WHEN span.status = 'failed' THEN 'error' ELSE 'info' END,
  CASE WHEN span.status = 'failed' THEN 'Telemetry span failed' ELSE 'Telemetry span finished' END,
  jsonb_strip_nulls(jsonb_build_object(
    'rootTraceId', trace.root_trace_id,
    'traceId', trace.id,
    'spanId', span.id,
    'telemetryKind', span.kind,
    'telemetryName', span.name,
    'status', span.status,
    'durationMs', span.duration_ms,
    'inputTokens', span.input_tokens,
    'outputTokens', span.output_tokens,
    'error', span.error_message,
    'agentId', trace.agent_id,
    'workflowExecutionId', trace.workflow_execution_id,
    'backfilled', true
  )),
  trace.root_trace_id,
  trace.id,
  span.id,
  trace.agent_id,
  trace.workflow_execution_id
FROM mcp_observability_spans span
JOIN mcp_observability_traces trace ON trace.id = span.trace_id
WHERE span.status <> 'running'
  AND NOT EXISTS (
    SELECT 1 FROM argus_logs log
     WHERE log.span_id = span.id
       AND log.msg IN ('Telemetry span finished', 'Telemetry span failed')
  );

