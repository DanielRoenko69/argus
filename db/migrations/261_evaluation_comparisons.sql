-- Paired, bounded repetitions. Saving a plan never dispatches a provider request.
CREATE TABLE mcp_evaluation_comparisons (
  id BIGSERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  environment TEXT NOT NULL,
  name TEXT NOT NULL,
  dataset_id BIGINT NOT NULL REFERENCES mcp_evaluation_datasets(id),
  repetitions INTEGER NOT NULL CHECK (repetitions BETWEEN 1 AND 10),
  order_mode TEXT NOT NULL CHECK (order_mode IN ('alternating','baseline_first')),
  plan JSONB NOT NULL CHECK (jsonb_typeof(plan)='array' AND jsonb_array_length(plan)=2*repetitions),
  plan_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled','interrupted')),
  token UUID,
  leased_until TIMESTAMPTZ,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  stop_reason TEXT,
  created_by_user_id INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX evaluation_comparison_scope ON mcp_evaluation_comparisons(tenant_key,workspace_key,id DESC);
CREATE INDEX evaluation_comparison_expiry ON mcp_evaluation_comparisons(leased_until) WHERE status='running';
CREATE TABLE mcp_evaluation_comparison_steps (
  comparison_id BIGINT NOT NULL REFERENCES mcp_evaluation_comparisons(id),
  experiment_id BIGINT NOT NULL UNIQUE REFERENCES mcp_evaluation_experiments(id),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 20),
  round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 10),
  variant TEXT NOT NULL CHECK (variant IN ('baseline','candidate')),
  PRIMARY KEY (comparison_id,position),
  UNIQUE (comparison_id,round,variant)
);
ALTER TABLE mcp_evaluation_workers ADD COLUMN comparison_id BIGINT REFERENCES mcp_evaluation_comparisons(id);
ALTER TABLE mcp_evaluation_workers ADD COLUMN comparison_token UUID;
ALTER TABLE mcp_evaluation_workers ADD CONSTRAINT evaluation_comparison_worker_pair
  CHECK ((comparison_id IS NULL)=(comparison_token IS NULL));

CREATE FUNCTION evaluation_comparison_lease_valid(worker mcp_evaluation_workers) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT worker.comparison_id IS NULL OR EXISTS (
    SELECT 1 FROM mcp_evaluation_comparisons c WHERE c.id=worker.comparison_id
      AND c.token=worker.comparison_token AND c.status='running' AND c.leased_until>clock_timestamp()
  )
$$;

CREATE FUNCTION guard_evaluation_comparison() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EVALUATION_COMPARISON_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['status','token','leased_until','cancel_requested','stop_reason','started_at','completed_at','created_by_user_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','token','leased_until','cancel_requested','stop_reason','started_at','completed_at','created_by_user_id'])
      OR (NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id AND NEW.created_by_user_id IS NOT NULL)
    THEN RAISE EXCEPTION 'EVALUATION_COMPARISON_IMMUTABLE' USING ERRCODE='23514'; END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status IN ('queued','failed','cancelled','interrupted') AND NEW.status='running') OR
      (OLD.status='queued' AND NEW.status='cancelled') OR
      (OLD.status='running' AND NEW.status IN ('completed','failed','cancelled','interrupted'))
    ) THEN RAISE EXCEPTION 'EVALUATION_COMPARISON_STATE' USING ERRCODE='23514'; END IF;
    IF NEW.status='completed' AND EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.plan) s
      LEFT JOIN mcp_evaluation_experiments e ON e.id=(s->>'experiment_id')::bigint
      WHERE e.id IS NULL OR e.status<>'completed')
    THEN RAISE EXCEPTION 'EVALUATION_COMPARISON_INCOMPLETE' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_comparison_guard BEFORE UPDATE OR DELETE ON mcp_evaluation_comparisons
  FOR EACH ROW EXECUTE FUNCTION guard_evaluation_comparison();

CREATE FUNCTION guard_evaluation_comparison_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EVALUATION_COMPARISON_STEP_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM mcp_evaluation_comparisons c
    JOIN mcp_evaluation_experiments e ON e.id=NEW.experiment_id
    WHERE c.id=NEW.comparison_id AND c.status='queued' AND e.status='queued' AND e.evidence_kind='frozen_v1'
      AND e.tenant_key=c.tenant_key AND e.workspace_key=c.workspace_key AND e.dataset_id=c.dataset_id
      AND c.plan @> jsonb_build_array(jsonb_build_object('experiment_id',NEW.experiment_id,'position',NEW.position,'round',NEW.round,'variant',NEW.variant)))
  THEN RAISE EXCEPTION 'EVALUATION_COMPARISON_STEP_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_comparison_step_guard BEFORE INSERT OR UPDATE OR DELETE ON mcp_evaluation_comparison_steps
  FOR EACH ROW EXECUTE FUNCTION guard_evaluation_comparison_step();

-- Fence grouped dispatch at the database boundary, including direct child /run requests.
CREATE FUNCTION fence_evaluation_comparison_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member mcp_evaluation_comparison_steps; worker mcp_evaluation_workers; parent mcp_evaluation_comparisons;
BEGIN
  IF NEW.status<>'running' OR OLD.status='running' THEN RETURN NEW; END IF;
  SELECT * INTO member FROM mcp_evaluation_comparison_steps WHERE experiment_id=NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO parent FROM mcp_evaluation_comparisons WHERE id=member.comparison_id;
  SELECT * INTO worker FROM mcp_evaluation_workers WHERE experiment_id=NEW.id;
  IF OLD.status='queued' THEN
    IF worker.comparison_id IS DISTINCT FROM parent.id OR NOT evaluation_comparison_lease_valid(worker) OR parent.cancel_requested
      OR EXISTS (SELECT 1 FROM mcp_evaluation_comparison_steps s JOIN mcp_evaluation_experiments e ON e.id=s.experiment_id
        WHERE s.comparison_id=parent.id AND s.position<member.position AND e.status<>'completed')
    THEN RAISE EXCEPTION 'EVALUATION_COMPARISON_ORDER' USING ERRCODE='23514'; END IF;
  ELSIF parent.status='running' OR worker.comparison_id IS NOT NULL THEN
    RAISE EXCEPTION 'EVALUATION_COMPARISON_RETRY_BLOCKED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_comparison_execution_fence BEFORE UPDATE OF status ON mcp_evaluation_experiments
  FOR EACH ROW EXECUTE FUNCTION fence_evaluation_comparison_execution();

CREATE FUNCTION fence_evaluation_comparison_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mcp_evaluation_workers w WHERE w.experiment_id=NEW.experiment_id
    AND (NOT evaluation_comparison_lease_valid(w) OR (TG_TABLE_NAME='mcp_evaluation_attempts' AND EXISTS (
      SELECT 1 FROM mcp_evaluation_comparisons c WHERE c.id=w.comparison_id AND c.cancel_requested))))
  THEN RAISE EXCEPTION 'EVALUATION_COMPARISON_WORKER_FENCED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_comparison_attempt_fence BEFORE INSERT ON mcp_evaluation_attempts
  FOR EACH ROW EXECUTE FUNCTION fence_evaluation_comparison_evidence();
CREATE TRIGGER evaluation_comparison_result_fence BEFORE INSERT ON mcp_evaluation_results
  FOR EACH ROW EXECUTE FUNCTION fence_evaluation_comparison_evidence();
