-- Audited, no-side-effect executor attempts for approved incident remediation
-- proposals. A dry run may execute only a Core-verified read-only tool from an
-- incident-scoped MCP bundle. Provider mutations remain out of scope.

ALTER TABLE mcp_observability_incident_remediation_events
  DROP CONSTRAINT IF EXISTS mcp_observability_incident_remediation_events_event_type_check;

ALTER TABLE mcp_observability_incident_remediation_events
  ALTER COLUMN event_type TYPE VARCHAR(32);

ALTER TABLE mcp_observability_incident_remediation_events
  ADD CONSTRAINT mcp_observability_incident_remediation_events_event_type_check
  CHECK (event_type IN (
    'proposed','approved','rejected','executed','failed','verified',
    'dry_run_started','dry_run_passed','dry_run_failed'
  ));

CREATE TABLE IF NOT EXISTS mcp_observability_incident_remediation_dry_runs (
  id                    BIGSERIAL PRIMARY KEY,
  remediation_id        BIGINT NOT NULL
                        REFERENCES mcp_observability_incident_remediations(id) ON DELETE CASCADE,
  bundle_id             INTEGER NOT NULL
                        REFERENCES mcp_service_bundles(id) ON DELETE RESTRICT,
  tool_name              VARCHAR(200) NOT NULL,
  arguments              JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                 VARCHAR(16) NOT NULL
                        CHECK (status IN ('running','passed','failed')),
  execution_trace_id     UUID NOT NULL UNIQUE,
  result_preview         TEXT,
  error_message          VARCHAR(1000),
  redaction_summary      JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_by             INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  started_by_username    VARCHAR(200) NOT NULL,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ,
  CONSTRAINT mcp_incident_remediation_dry_run_arguments_size CHECK (
    octet_length(arguments::text) <= 8192
  ),
  CONSTRAINT mcp_incident_remediation_dry_run_result_size CHECK (
    result_preview IS NULL OR octet_length(result_preview) <= 16384
  ),
  CONSTRAINT mcp_incident_remediation_dry_run_redaction_size CHECK (
    octet_length(redaction_summary::text) <= 2048
  ),
  CONSTRAINT mcp_incident_remediation_dry_run_terminal_check CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status IN ('passed','failed') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_incident_remediation_dry_runs_proposal
  ON mcp_observability_incident_remediation_dry_runs (remediation_id, started_at DESC, id DESC);

COMMENT ON TABLE mcp_observability_incident_remediation_dry_runs IS
  'Audited executions of explicitly selected, Core-verified read-only tools for approved AIOps remediation proposals.';
