-- Additive: old results remain visibly without deterministic execution evidence.
ALTER TABLE mcp_evaluation_results ADD COLUMN evidence JSONB;
ALTER TABLE mcp_evaluation_results ADD CONSTRAINT evaluation_result_evidence_object
  CHECK (evidence IS NULL OR jsonb_typeof(evidence)='object');

CREATE FUNCTION guard_evaluation_execution_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='queued' AND NEW.status='running') OR
    (OLD.status='running' AND NEW.status IN ('completed','failed','cancelled'))
  ) THEN RAISE EXCEPTION 'EVALUATION_EXECUTION_ALREADY_CLAIMED' USING ERRCODE='23514'; END IF;
  IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed' AND (
    NEW.evidence_kind<>'frozen_v1' OR
    (SELECT count(*) FROM mcp_evaluation_results WHERE experiment_id=NEW.id)
      <> jsonb_array_length(NEW.expected_cases) OR
    EXISTS (SELECT 1 FROM mcp_evaluation_results WHERE experiment_id=NEW.id AND
      (attempt<>1 OR status NOT IN ('passed','failed') OR evidence IS NULL))
  ) THEN RAISE EXCEPTION 'EVALUATION_RESULTS_INCOMPLETE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_execution_state_guard BEFORE UPDATE ON mcp_evaluation_experiments
  FOR EACH ROW EXECUTE FUNCTION guard_evaluation_execution_state();
