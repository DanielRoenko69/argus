-- A lease authorizes a worker, never an automatic retry of a provider request.
ALTER TABLE mcp_evaluation_experiments DROP CONSTRAINT mcp_evaluation_experiments_status_check;
ALTER TABLE mcp_evaluation_experiments ADD CONSTRAINT mcp_evaluation_experiments_status_check
  CHECK (status IN ('queued','running','completed','failed','cancelled','interrupted'));

CREATE TABLE mcp_evaluation_workers (
  experiment_id BIGINT PRIMARY KEY REFERENCES mcp_evaluation_experiments(id),
  token UUID NOT NULL,
  environment TEXT NOT NULL,
  leased_until TIMESTAMPTZ NOT NULL,
  cancel_requested BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX evaluation_worker_expiry ON mcp_evaluation_workers(leased_until);
CREATE TABLE mcp_evaluation_attempts (
  experiment_id BIGINT NOT NULL REFERENCES mcp_evaluation_experiments(id),
  case_id BIGINT NOT NULL REFERENCES mcp_evaluation_cases(id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  worker_token UUID NOT NULL,
  trace_id UUID REFERENCES mcp_observability_traces(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id,case_id,attempt)
);

CREATE FUNCTION guard_evaluation_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EVALUATION_ATTEMPT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'trace_id') IS DISTINCT FROM (to_jsonb(OLD)-'trace_id') OR NEW.trace_id IS NOT NULL THEN
      RAISE EXCEPTION 'EVALUATION_ATTEMPT_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Same experiment lock as cancel, recovery and result commit.
  PERFORM 1 FROM mcp_evaluation_experiments WHERE id=NEW.experiment_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM mcp_evaluation_workers w JOIN mcp_evaluation_experiments e ON e.id=w.experiment_id
      JOIN mcp_evaluation_cases c ON c.dataset_id=e.dataset_id
      WHERE e.id=NEW.experiment_id AND c.id=NEW.case_id AND e.status='running'
        AND e.evidence_kind='frozen_v1' AND w.token=NEW.worker_token
        AND NOT w.cancel_requested AND w.leased_until>clock_timestamp())
    OR EXISTS (SELECT 1 FROM mcp_evaluation_results WHERE experiment_id=NEW.experiment_id AND case_id=NEW.case_id AND status IN ('passed','failed'))
    OR NEW.attempt <> 1 + GREATEST(
      COALESCE((SELECT max(attempt) FROM mcp_evaluation_attempts WHERE experiment_id=NEW.experiment_id AND case_id=NEW.case_id),0),
      COALESCE((SELECT max(attempt) FROM mcp_evaluation_results WHERE experiment_id=NEW.experiment_id AND case_id=NEW.case_id),0))
  THEN RAISE EXCEPTION 'EVALUATION_ATTEMPT_NOT_CLAIMED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON mcp_evaluation_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_evaluation_attempt();

CREATE OR REPLACE FUNCTION guard_evaluation_execution_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='queued' AND NEW.status IN ('running','cancelled')) OR
    (OLD.status='running' AND NEW.status IN ('completed','failed','cancelled','interrupted')) OR
    (OLD.status IN ('failed','cancelled','interrupted') AND NEW.status='running' AND EXISTS (
      SELECT 1 FROM mcp_evaluation_workers WHERE experiment_id=NEW.id AND NOT cancel_requested AND leased_until>clock_timestamp()))
  ) THEN RAISE EXCEPTION 'EVALUATION_EXECUTION_ALREADY_CLAIMED' USING ERRCODE='23514'; END IF;
  IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed' AND (
    NEW.evidence_kind<>'frozen_v1' OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.expected_cases) c WHERE NOT EXISTS (
        SELECT 1 FROM mcp_evaluation_results r WHERE r.experiment_id=NEW.id AND r.case_id::text=c->>'id'
          AND r.status IN ('passed','failed') AND r.evidence IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM mcp_evaluation_attempts a WHERE a.experiment_id=r.experiment_id AND a.case_id=r.case_id AND a.attempt>r.attempt)
          AND NOT EXISTS (SELECT 1 FROM mcp_evaluation_results x WHERE x.experiment_id=r.experiment_id AND x.case_id=r.case_id AND x.attempt>r.attempt)
      ))) THEN RAISE EXCEPTION 'EVALUATION_RESULTS_INCOMPLETE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

-- Keep the original immutable-result guard; add fencing for new managed runs.
CREATE FUNCTION fence_evaluation_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM mcp_evaluation_experiments WHERE id=NEW.experiment_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM mcp_evaluation_workers WHERE experiment_id=NEW.experiment_id)
    AND NOT EXISTS (SELECT 1 FROM mcp_evaluation_attempts a JOIN mcp_evaluation_workers w USING (experiment_id)
      WHERE a.experiment_id=NEW.experiment_id AND a.case_id=NEW.case_id AND a.attempt=NEW.attempt
        AND a.worker_token=w.token AND a.trace_id IS NOT DISTINCT FROM NEW.trace_id AND w.leased_until>clock_timestamp())
  THEN RAISE EXCEPTION 'EVALUATION_WORKER_FENCED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_result_fence BEFORE INSERT ON mcp_evaluation_results
  FOR EACH ROW EXECUTE FUNCTION fence_evaluation_result();
