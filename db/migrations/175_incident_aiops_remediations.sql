-- Governed remediation proposals derived from Core-normalized AIOps reviewer
-- results. Version 1 is deliberately proposal-only: approval never executes a
-- provider tool and the existing observe bundle remains read-only.

CREATE TABLE IF NOT EXISTS mcp_observability_incident_remediations (
  id                    BIGSERIAL PRIMARY KEY,
  incident_id           BIGINT NOT NULL
                        REFERENCES mcp_observability_alert_incidents(id) ON DELETE CASCADE,
  task_link_id          BIGINT NOT NULL
                        REFERENCES mcp_observability_incident_aiops_tasks(id) ON DELETE CASCADE,
  source_action_index   SMALLINT NOT NULL CHECK (source_action_index BETWEEN 0 AND 5),
  source_fingerprint    CHAR(64) NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  priority              VARCHAR(8) NOT NULL CHECK (priority IN ('now','next','later')),
  action                VARCHAR(800) NOT NULL CHECK (length(action) BETWEEN 1 AND 800),
  rationale             VARCHAR(800) NOT NULL CHECK (length(rationale) BETWEEN 1 AND 800),
  requires_approval     BOOLEAN NOT NULL DEFAULT true,
  risk_level            VARCHAR(8) NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  execution_mode        VARCHAR(24) NOT NULL DEFAULT 'proposal_only'
                        CHECK (execution_mode IN ('proposal_only','dry_run','governed_write')),
  executor_bundle_id    INTEGER REFERENCES mcp_service_bundles(id) ON DELETE SET NULL,
  executor_tool_name    VARCHAR(200),
  target_scope          JSONB,
  status                VARCHAR(16) NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','approved','rejected','executed','failed','verified')),
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by            INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  decided_by            INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  decided_by_username   VARCHAR(200),
  decision_comment      VARCHAR(2000),
  decided_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_incident_remediation_source_unique UNIQUE (task_link_id, source_action_index),
  CONSTRAINT mcp_incident_remediation_executor_check CHECK (
    (execution_mode = 'proposal_only' AND executor_bundle_id IS NULL AND executor_tool_name IS NULL)
    OR (execution_mode <> 'proposal_only' AND executor_bundle_id IS NOT NULL AND length(COALESCE(executor_tool_name, '')) BETWEEN 1 AND 200)
  ),
  CONSTRAINT mcp_incident_remediation_decision_check CHECK (
    (status = 'proposed' AND decided_at IS NULL AND decided_by_username IS NULL)
    OR (status <> 'proposed' AND decided_at IS NOT NULL AND length(COALESCE(decided_by_username, '')) BETWEEN 1 AND 200)
  ),
  CONSTRAINT mcp_incident_remediation_scope_size CHECK (
    target_scope IS NULL OR octet_length(target_scope::text) <= 8192
  )
);

CREATE INDEX IF NOT EXISTS idx_incident_remediations_incident
  ON mcp_observability_incident_remediations (incident_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_incident_remediations_status
  ON mcp_observability_incident_remediations (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS mcp_observability_incident_remediation_events (
  id              BIGSERIAL PRIMARY KEY,
  remediation_id  BIGINT NOT NULL
                  REFERENCES mcp_observability_incident_remediations(id) ON DELETE CASCADE,
  event_type      VARCHAR(16) NOT NULL
                  CHECK (event_type IN ('proposed','approved','rejected','executed','failed','verified')),
  actor_user_id   INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  actor_username  VARCHAR(200),
  comment         VARCHAR(2000),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_incident_remediation_event_metadata_size CHECK (
    octet_length(metadata::text) <= 8192
  )
);

CREATE INDEX IF NOT EXISTS idx_incident_remediation_events_proposal
  ON mcp_observability_incident_remediation_events (remediation_id, created_at, id);

CREATE OR REPLACE FUNCTION mcp_incident_remediation_event_block_modify()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'mcp_observability_incident_remediation_events is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mcp_incident_remediation_event_no_update
  ON mcp_observability_incident_remediation_events;
DROP TRIGGER IF EXISTS mcp_incident_remediation_event_no_delete
  ON mcp_observability_incident_remediation_events;
DROP TRIGGER IF EXISTS mcp_incident_remediation_event_no_truncate
  ON mcp_observability_incident_remediation_events;

CREATE TRIGGER mcp_incident_remediation_event_no_update
  BEFORE UPDATE ON mcp_observability_incident_remediation_events
  FOR EACH ROW EXECUTE FUNCTION mcp_incident_remediation_event_block_modify();

CREATE TRIGGER mcp_incident_remediation_event_no_delete
  BEFORE DELETE ON mcp_observability_incident_remediation_events
  FOR EACH ROW EXECUTE FUNCTION mcp_incident_remediation_event_block_modify();

CREATE TRIGGER mcp_incident_remediation_event_no_truncate
  BEFORE TRUNCATE ON mcp_observability_incident_remediation_events
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_incident_remediation_event_block_modify();

COMMENT ON TABLE mcp_observability_incident_remediations IS
  'Core-owned, non-executable remediation proposals derived from normalized AIOps reviewer actions.';
COMMENT ON TABLE mcp_observability_incident_remediation_events IS
  'Append-only audit history for remediation proposal lifecycle decisions.';
