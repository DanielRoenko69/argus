-- Delayed, persistent observation of a successfully verified provider change.
-- A detected regression creates a hash-bound rollback proposal; it never
-- executes a delayed rollback without a separate operator decision.

ALTER TABLE mcp_observability_incident_remediation_events
  DROP CONSTRAINT IF EXISTS mcp_observability_incident_remediation_events_event_type_check;

ALTER TABLE mcp_observability_incident_remediation_events
  ADD CONSTRAINT mcp_observability_incident_remediation_events_event_type_check
  CHECK (event_type IN (
    'proposed','approved','rejected','executed','failed','verified',
    'dry_run_started','dry_run_passed','dry_run_failed',
    'change_plan_created','change_plan_approved','change_plan_rejected',
    'execution_started','execution_succeeded','execution_failed',
    'verification_passed','verification_failed',
    'rollback_succeeded','rollback_failed',
    'post_change_monitor_scheduled','post_change_monitor_started',
    'post_change_healthy','post_change_regressed','post_change_check_failed',
    'post_change_rollback_approved','post_change_rollback_rejected',
    'post_change_rollback_started'
  ));

CREATE TABLE IF NOT EXISTS mcp_observability_incident_remediation_post_change_monitors (
  id                    BIGSERIAL PRIMARY KEY,
  remediation_id        BIGINT NOT NULL
                        REFERENCES mcp_observability_incident_remediations(id) ON DELETE CASCADE,
  plan_id               BIGINT NOT NULL UNIQUE
                        REFERENCES mcp_observability_incident_remediation_change_plans(id) ON DELETE CASCADE,
  status                VARCHAR(32) NOT NULL DEFAULT 'scheduled'
                        CHECK (status IN (
                          'scheduled','checking','healthy','regression_detected','check_failed',
                          'rollback_approved','rollback_rejected','rolling_back',
                          'rolled_back','rollback_failed'
                        )),
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  rollback_hash         CHAR(64) NOT NULL CHECK (rollback_hash ~ '^[0-9a-f]{64}$'),
  scheduled_for         TIMESTAMPTZ NOT NULL,
  observation_trace_id  UUID UNIQUE,
  observed_replicas     INTEGER CHECK (observed_replicas BETWEEN 0 AND 10000),
  observation_result    TEXT,
  observation_error     VARCHAR(1000),
  observed_at           TIMESTAMPTZ,
  decided_by            INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  decided_by_username   VARCHAR(200),
  decision_comment      VARCHAR(2000),
  decided_at            TIMESTAMPTZ,
  rollback_trace_id     UUID UNIQUE,
  rollback_result       TEXT,
  rollback_error        VARCHAR(1000),
  rolled_back_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_incident_post_change_monitor_result_size CHECK (
    octet_length(COALESCE(observation_result, '')) <= 16000
    AND octet_length(COALESCE(rollback_result, '')) <= 16000
  ),
  CONSTRAINT mcp_incident_post_change_monitor_decision_check CHECK (
    (status IN ('rollback_approved','rollback_rejected','rolling_back','rolled_back','rollback_failed')
      AND decided_at IS NOT NULL AND length(COALESCE(decided_by_username, '')) BETWEEN 1 AND 200)
    OR (status NOT IN ('rollback_approved','rollback_rejected','rolling_back','rolled_back','rollback_failed')
      AND decided_at IS NULL AND decided_by_username IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_incident_post_change_monitors_due
  ON mcp_observability_incident_remediation_post_change_monitors (scheduled_for, id)
  WHERE status='scheduled';

CREATE OR REPLACE FUNCTION mcp_incident_post_change_monitor_block_payload_modify()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.remediation_id IS DISTINCT FROM OLD.remediation_id
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.rollback_hash IS DISTINCT FROM OLD.rollback_hash
     OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'incident post-change monitor payload is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mcp_incident_post_change_monitor_payload_immutable
  ON mcp_observability_incident_remediation_post_change_monitors;

CREATE TRIGGER mcp_incident_post_change_monitor_payload_immutable
  BEFORE UPDATE ON mcp_observability_incident_remediation_post_change_monitors
  FOR EACH ROW EXECUTE FUNCTION mcp_incident_post_change_monitor_block_payload_modify();

COMMENT ON TABLE mcp_observability_incident_remediation_post_change_monitors IS
  'Delayed verification and separately approved rollback evidence for a successfully applied immutable remediation plan.';
