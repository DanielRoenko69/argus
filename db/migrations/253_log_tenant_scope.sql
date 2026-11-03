-- Structured logs are first-class workspace evidence. Persist their owner so
-- free-text search and index counts cannot become cross-tenant side channels.

ALTER TABLE argus_logs
  ADD COLUMN IF NOT EXISTS tenant_key VARCHAR(128) NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS workspace_key VARCHAR(128) NOT NULL DEFAULT 'default';

-- Prefer the immutable workflow execution owner for existing correlated logs.
UPDATE argus_logs log
   SET tenant_key = execution.tenant_key,
       workspace_key = execution.workspace_key
  FROM mcp_workflow_executions execution
 WHERE log.workflow_execution_id = execution.id;

-- Older child-agent logs may only point at the workflow root trace.
UPDATE argus_logs log
   SET tenant_key = execution.tenant_key,
       workspace_key = execution.workspace_key
  FROM mcp_observability_traces trace
  JOIN mcp_workflow_executions execution
    ON execution.id = trace.workflow_execution_id
 WHERE log.root_trace_id = trace.id;

-- Newer non-workflow traces carry their selected scope in bounded metadata.
UPDATE argus_logs log
   SET tenant_key = COALESCE(NULLIF(trace.metadata->>'tenantKey', ''), 'default'),
       workspace_key = COALESCE(NULLIF(trace.metadata->>'workspaceKey', ''), 'default')
  FROM mcp_observability_traces trace
 WHERE trace.id = COALESCE(log.trace_id, log.root_trace_id)
   AND NULLIF(trace.metadata->>'tenantKey', '') IS NOT NULL
   AND NULLIF(trace.metadata->>'workspaceKey', '') IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'argus_logs_tenant_key_chk') THEN
    ALTER TABLE argus_logs ADD CONSTRAINT argus_logs_tenant_key_chk
      CHECK (tenant_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'argus_logs_workspace_key_chk') THEN
    ALTER TABLE argus_logs ADD CONSTRAINT argus_logs_workspace_key_chk
      CHECK (workspace_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_argus_logs_scope_ts
  ON argus_logs (tenant_key, workspace_key, ts DESC);
CREATE INDEX IF NOT EXISTS idx_argus_logs_scope_root_trace
  ON argus_logs (tenant_key, workspace_key, root_trace_id, ts DESC)
  WHERE root_trace_id IS NOT NULL;

COMMENT ON COLUMN argus_logs.tenant_key IS
  'Server-authorized tenant owner used by every log read and export.';
COMMENT ON COLUMN argus_logs.workspace_key IS
  'Server-authorized workspace owner used by every log read and export.';
