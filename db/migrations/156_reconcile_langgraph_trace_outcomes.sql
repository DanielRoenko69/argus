-- Keep the native workflow trace aligned with the durable LangGraph outcome.
-- Older runtimes treated reaching END as success even when workflow delivery
-- criteria were not met; the durable thread is the corrected source of truth.
--
-- LangGraph owns argus_langgraph_threads and creates it when its service starts.
-- Core migrations run first on a clean Compose install, so this reconciliation
-- must be a no-op until the optional LangGraph schema exists. Dynamic SQL keeps
-- PostgreSQL from resolving the absent relation while parsing the migration.
DO $migration$
BEGIN
  IF to_regclass('public.argus_langgraph_threads') IS NULL THEN
    RAISE NOTICE 'Skipping LangGraph outcome reconciliation: argus_langgraph_threads is not installed yet';
  ELSE
    EXECUTE $sql$
      UPDATE mcp_observability_traces trace
         SET status = 'failed',
             error_message = thread.error,
             ended_at = COALESCE(trace.ended_at, thread.updated_at),
             duration_ms = COALESCE(
               trace.duration_ms,
               GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (COALESCE(trace.ended_at, thread.updated_at) - trace.started_at)) * 1000)::bigint)
             ),
             metadata = trace.metadata || jsonb_build_object('outcomeReconciled', true),
             updated_at = NOW()
        FROM argus_langgraph_threads thread
       WHERE trace.id = thread.thread_id
         AND trace.kind = 'workflow'
         AND thread.status = 'failed'
         AND trace.status <> 'failed'
    $sql$;

    EXECUTE $sql$
      INSERT INTO argus_logs (
        ts, level, msg, data, root_trace_id, trace_id, agent_id, workflow_execution_id
      )
      SELECT
        COALESCE(trace.ended_at, trace.updated_at),
        'error',
        'Telemetry trace failed',
        jsonb_strip_nulls(jsonb_build_object(
          'rootTraceId', trace.root_trace_id,
          'traceId', trace.id,
          'telemetryKind', trace.kind,
          'telemetryName', trace.name,
          'status', 'failed',
          'durationMs', trace.duration_ms,
          'inputTokens', trace.input_tokens,
          'outputTokens', trace.output_tokens,
          'error', trace.error_message,
          'outcomeReconciled', true
        )),
        trace.root_trace_id,
        trace.id,
        trace.agent_id,
        trace.workflow_execution_id
      FROM mcp_observability_traces trace
      JOIN argus_langgraph_threads thread ON thread.thread_id = trace.id
      WHERE trace.kind = 'workflow'
        AND trace.status = 'failed'
        AND thread.status = 'failed'
        AND NOT EXISTS (
          SELECT 1 FROM argus_logs log
           WHERE log.trace_id = trace.id
             AND log.span_id IS NULL
             AND log.msg = 'Telemetry trace failed'
        )
    $sql$;
  END IF;
END
$migration$;
