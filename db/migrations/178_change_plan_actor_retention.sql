-- Keep immutable plan authorship text while allowing the mcp_users foreign key
-- to perform its declared ON DELETE SET NULL lifecycle.

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
     OR NEW.created_by_username IS DISTINCT FROM OLD.created_by_username
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'incident remediation change-plan payload is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
