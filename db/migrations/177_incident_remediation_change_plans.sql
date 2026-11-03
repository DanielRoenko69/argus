-- Immutable, human-approved execution plans for narrowly scoped AIOps
-- remediations. The first adapter is Kubernetes scale: Core discovers a
-- dedicated write connector, records the current replica count, hashes the
-- exact requested change, and requires a second approval before execution.

ALTER TABLE mcp_observability_incident_remediation_events
  DROP CONSTRAINT IF EXISTS mcp_observability_incident_remediation_events_event_type_check;

ALTER TABLE mcp_observability_incident_remediation_events
  ALTER COLUMN event_type TYPE VARCHAR(32);

ALTER TABLE mcp_observability_incident_remediation_events
  ADD CONSTRAINT mcp_observability_incident_remediation_events_event_type_check
  CHECK (event_type IN (
    'proposed','approved','rejected','executed','failed','verified',
    'dry_run_started','dry_run_passed','dry_run_failed',
    'change_plan_created','change_plan_approved','change_plan_rejected',
    'execution_started','execution_succeeded','execution_failed',
    'verification_passed','verification_failed',
    'rollback_succeeded','rollback_failed'
  ));

CREATE TABLE IF NOT EXISTS mcp_observability_incident_remediation_change_plans (
  id                    BIGSERIAL PRIMARY KEY,
  remediation_id        BIGINT NOT NULL
                        REFERENCES mcp_observability_incident_remediations(id) ON DELETE CASCADE,
  adapter_key           VARCHAR(80) NOT NULL,
  bundle_id             INTEGER NOT NULL
                        REFERENCES mcp_service_bundles(id) ON DELETE RESTRICT,
  write_backend_id      INTEGER NOT NULL
                        REFERENCES mcp_backends(id) ON DELETE RESTRICT,
  write_tool_name       VARCHAR(200) NOT NULL,
  status                VARCHAR(24) NOT NULL DEFAULT 'awaiting_approval'
                        CHECK (status IN (
                          'awaiting_approval','approved','rejected','executing',
                          'verified','failed','rolled_back','rollback_failed'
                        )),
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  plan_hash             CHAR(64) NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
  target_scope          JSONB NOT NULL,
  preview               JSONB NOT NULL,
  write_arguments       JSONB NOT NULL,
  verify_arguments      JSONB NOT NULL,
  rollback_arguments    JSONB NOT NULL,
  previous_replicas     INTEGER NOT NULL CHECK (previous_replicas BETWEEN 0 AND 10000),
  desired_replicas      INTEGER NOT NULL CHECK (desired_replicas BETWEEN 1 AND 50),
  created_by            INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_by_username   VARCHAR(200) NOT NULL,
  approved_by           INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  approved_by_username  VARCHAR(200),
  approval_comment      VARCHAR(2000),
  approved_at           TIMESTAMPTZ,
  execution_trace_id    UUID UNIQUE,
  execution_result      TEXT,
  execution_error       VARCHAR(1000),
  executed_at           TIMESTAMPTZ,
  verification_trace_id UUID UNIQUE,
  verification_result   TEXT,
  verification_error    VARCHAR(1000),
  verified_at           TIMESTAMPTZ,
  rollback_trace_id     UUID UNIQUE,
  rollback_result       TEXT,
  rollback_error        VARCHAR(1000),
  rolled_back_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_incident_change_plan_payload_size CHECK (
    octet_length(target_scope::text) <= 4096
    AND octet_length(preview::text) <= 8192
    AND octet_length(write_arguments::text) <= 8192
    AND octet_length(verify_arguments::text) <= 8192
    AND octet_length(rollback_arguments::text) <= 8192
  ),
  CONSTRAINT mcp_incident_change_plan_approval_check CHECK (
    (status = 'awaiting_approval' AND approved_at IS NULL AND approved_by_username IS NULL)
    OR (status <> 'awaiting_approval' AND status <> 'rejected'
        AND approved_at IS NOT NULL AND length(COALESCE(approved_by_username, '')) BETWEEN 1 AND 200)
    OR (status = 'rejected' AND approved_at IS NOT NULL
        AND length(COALESCE(approved_by_username, '')) BETWEEN 1 AND 200)
  )
);

CREATE INDEX IF NOT EXISTS idx_incident_change_plans_remediation
  ON mcp_observability_incident_remediation_change_plans (remediation_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_change_plans_one_active
  ON mcp_observability_incident_remediation_change_plans (remediation_id)
  WHERE status IN ('awaiting_approval','approved','executing');

CREATE OR REPLACE FUNCTION mcp_incident_change_plan_block_payload_modify()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.adapter_key IS DISTINCT FROM OLD.adapter_key
     OR NEW.bundle_id IS DISTINCT FROM OLD.bundle_id
     OR NEW.write_backend_id IS DISTINCT FROM OLD.write_backend_id
     OR NEW.write_tool_name IS DISTINCT FROM OLD.write_tool_name
     OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash
     OR NEW.target_scope IS DISTINCT FROM OLD.target_scope
     OR NEW.preview IS DISTINCT FROM OLD.preview
     OR NEW.write_arguments IS DISTINCT FROM OLD.write_arguments
     OR NEW.verify_arguments IS DISTINCT FROM OLD.verify_arguments
     OR NEW.rollback_arguments IS DISTINCT FROM OLD.rollback_arguments
     OR NEW.previous_replicas IS DISTINCT FROM OLD.previous_replicas
     OR NEW.desired_replicas IS DISTINCT FROM OLD.desired_replicas
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_by_username IS DISTINCT FROM OLD.created_by_username
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'incident remediation change-plan payload is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mcp_incident_change_plan_payload_immutable
  ON mcp_observability_incident_remediation_change_plans;

CREATE TRIGGER mcp_incident_change_plan_payload_immutable
  BEFORE UPDATE ON mcp_observability_incident_remediation_change_plans
  FOR EACH ROW EXECUTE FUNCTION mcp_incident_change_plan_block_payload_modify();

COMMENT ON TABLE mcp_observability_incident_remediation_change_plans IS
  'Immutable, hash-bound and separately approved provider mutation plans with execution, verification and rollback evidence.';
