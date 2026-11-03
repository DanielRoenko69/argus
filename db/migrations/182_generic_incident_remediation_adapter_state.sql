-- Adapter-neutral immutable plan state and observed post-change state.
-- Replica columns remain as compatibility projections for kubernetes.scale.v1,
-- but are nullable so future adapters are not forced into scale semantics.

ALTER TABLE mcp_observability_incident_remediation_change_plans
  ADD COLUMN IF NOT EXISTS adapter_state JSONB;

UPDATE mcp_observability_incident_remediation_change_plans
   SET adapter_state = jsonb_build_object(
     'schemaVersion', 1,
     'before', jsonb_build_object('replicas', previous_replicas),
     'desired', jsonb_build_object('replicas', desired_replicas)
   )
 WHERE adapter_state IS NULL;

ALTER TABLE mcp_observability_incident_remediation_change_plans
  ALTER COLUMN adapter_state SET NOT NULL,
  ALTER COLUMN previous_replicas DROP NOT NULL,
  ALTER COLUMN desired_replicas DROP NOT NULL;

ALTER TABLE mcp_observability_incident_remediation_change_plans
  DROP CONSTRAINT IF EXISTS mcp_incident_change_plan_adapter_state_check;

ALTER TABLE mcp_observability_incident_remediation_change_plans
  ADD CONSTRAINT mcp_incident_change_plan_adapter_state_check CHECK (
    jsonb_typeof(adapter_state) = 'object'
    AND jsonb_typeof(adapter_state->'schemaVersion') = 'number'
    AND octet_length(adapter_state::text) <= 8192
  );

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
     OR NEW.adapter_state IS DISTINCT FROM OLD.adapter_state
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

ALTER TABLE mcp_observability_incident_remediation_post_change_monitors
  ADD COLUMN IF NOT EXISTS observed_state JSONB;

UPDATE mcp_observability_incident_remediation_post_change_monitors
   SET observed_state = jsonb_build_object(
     'schemaVersion', 1,
     'observed', jsonb_build_object('replicas', observed_replicas)
   )
 WHERE observed_state IS NULL AND observed_replicas IS NOT NULL;

ALTER TABLE mcp_observability_incident_remediation_post_change_monitors
  DROP CONSTRAINT IF EXISTS mcp_incident_post_change_observed_state_check;

ALTER TABLE mcp_observability_incident_remediation_post_change_monitors
  ADD CONSTRAINT mcp_incident_post_change_observed_state_check CHECK (
    observed_state IS NULL OR (
      jsonb_typeof(observed_state) = 'object'
      AND jsonb_typeof(observed_state->'schemaVersion') = 'number'
      AND octet_length(observed_state::text) <= 8192
    )
  );

COMMENT ON COLUMN mcp_observability_incident_remediation_change_plans.adapter_state IS
  'Immutable adapter-owned before and desired state included in the approved plan hash.';

COMMENT ON COLUMN mcp_observability_incident_remediation_post_change_monitors.observed_state IS
  'Adapter-owned normalized state observed during delayed post-change verification.';
