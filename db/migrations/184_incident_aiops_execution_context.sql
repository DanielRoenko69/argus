-- Freeze the exact execution boundary used when an incident investigation is
-- started. Remediation must never inherit later edits to the source alert rule.

ALTER TABLE mcp_observability_incident_aiops_tasks
  ADD COLUMN IF NOT EXISTS execution_bundle_ids INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS execution_resource_scope JSONB,
  ADD COLUMN IF NOT EXISTS execution_service VARCHAR(200),
  ADD COLUMN IF NOT EXISTS execution_environment VARCHAR(120),
  ADD COLUMN IF NOT EXISTS execution_context_captured_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE mcp_observability_incident_aiops_tasks task
   SET execution_bundle_ids=COALESCE(dispatch.bundle_ids, rule.aiops_bundle_ids, '{}'),
       execution_resource_scope=COALESCE(dispatch.resource_scope, rule.aiops_resource_scope),
       execution_service=COALESCE(dispatch.service, rule.aiops_service),
       execution_environment=COALESCE(dispatch.environment, rule.aiops_environment),
       execution_context_captured_at=task.created_at
  FROM mcp_observability_alert_incidents incident
  JOIN mcp_observability_alert_rules rule ON rule.id=incident.rule_id
  LEFT JOIN mcp_observability_incident_aiops_dispatches dispatch
    ON dispatch.incident_id=incident.id
 WHERE task.incident_id=incident.id;

ALTER TABLE mcp_observability_incident_aiops_tasks
  DROP CONSTRAINT IF EXISTS mcp_incident_aiops_execution_bundle_limit,
  ADD CONSTRAINT mcp_incident_aiops_execution_bundle_limit
    CHECK (cardinality(execution_bundle_ids) <= 64),
  DROP CONSTRAINT IF EXISTS mcp_incident_aiops_execution_service_length,
  ADD CONSTRAINT mcp_incident_aiops_execution_service_length
    CHECK (execution_service IS NULL OR length(execution_service) BETWEEN 1 AND 200),
  DROP CONSTRAINT IF EXISTS mcp_incident_aiops_execution_environment_length,
  ADD CONSTRAINT mcp_incident_aiops_execution_environment_length
    CHECK (execution_environment IS NULL OR length(execution_environment) BETWEEN 1 AND 120);

CREATE OR REPLACE FUNCTION prevent_incident_aiops_execution_context_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.execution_bundle_ids IS DISTINCT FROM OLD.execution_bundle_ids
     OR NEW.execution_resource_scope IS DISTINCT FROM OLD.execution_resource_scope
     OR NEW.execution_service IS DISTINCT FROM OLD.execution_service
     OR NEW.execution_environment IS DISTINCT FROM OLD.execution_environment
     OR NEW.execution_context_captured_at IS DISTINCT FROM OLD.execution_context_captured_at THEN
    RAISE EXCEPTION 'incident AIOps execution context is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_incident_aiops_execution_context_immutable
  ON mcp_observability_incident_aiops_tasks;
CREATE TRIGGER trg_incident_aiops_execution_context_immutable
BEFORE UPDATE OF execution_bundle_ids, execution_resource_scope, execution_service,
                 execution_environment, execution_context_captured_at
ON mcp_observability_incident_aiops_tasks
FOR EACH ROW EXECUTE FUNCTION prevent_incident_aiops_execution_context_update();

COMMENT ON COLUMN mcp_observability_incident_aiops_tasks.execution_bundle_ids IS
  'Immutable MCP bundle authorization boundary captured when the investigation starts.';
COMMENT ON COLUMN mcp_observability_incident_aiops_tasks.execution_resource_scope IS
  'Immutable provider resource scope captured from the validated execution grant.';
