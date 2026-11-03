-- Bounded, machine-readable result projection returned by an external AIOps
-- Solution Pack. Raw provider telemetry and full agent output remain Pack-owned.

ALTER TABLE mcp_observability_incident_aiops_tasks
  ADD COLUMN IF NOT EXISTS result_json JSONB;

ALTER TABLE mcp_observability_incident_aiops_tasks
  DROP CONSTRAINT IF EXISTS mcp_observability_incident_aiops_result_size;

ALTER TABLE mcp_observability_incident_aiops_tasks
  ADD CONSTRAINT mcp_observability_incident_aiops_result_size CHECK (
    result_json IS NULL OR octet_length(result_json::text) <= 65536
  );

COMMENT ON COLUMN mcp_observability_incident_aiops_tasks.result_json IS
  'Core-normalized AIOps diagnosis projection; excludes raw telemetry and unrestricted agent output.';
