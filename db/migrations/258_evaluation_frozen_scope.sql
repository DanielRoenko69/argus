-- Historical evidence remains explicitly incomplete: never invent old snapshots.
ALTER TABLE mcp_evaluation_datasets
  ADD COLUMN tenant_key TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN workspace_key TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 0 CHECK (contract_version IN (0,1));
ALTER TABLE mcp_evaluation_datasets ALTER COLUMN contract_version SET DEFAULT 1;
ALTER TABLE mcp_evaluation_datasets DROP CONSTRAINT mcp_evaluation_datasets_dataset_key_version_key;
ALTER TABLE mcp_evaluation_datasets ADD UNIQUE (tenant_key, workspace_key, dataset_key, version);
ALTER TABLE mcp_evaluation_cases ADD COLUMN rules JSONB;
ALTER TABLE mcp_evaluation_experiments
  ADD COLUMN tenant_key TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN workspace_key TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN evidence_kind TEXT NOT NULL DEFAULT 'legacy_smoke' CHECK (evidence_kind IN ('legacy_smoke','frozen_v1')),
  ADD COLUMN dataset_sha256 CHAR(64),
  ADD COLUMN expected_cases JSONB,
  ADD COLUMN configuration_snapshot JSONB,
  ADD COLUMN configuration_sha256 CHAR(64),
  ADD COLUMN evaluator_sha256 CHAR(64);
CREATE INDEX idx_evaluation_datasets_workspace ON mcp_evaluation_datasets(tenant_key,workspace_key,id);
CREATE INDEX idx_evaluation_experiments_workspace ON mcp_evaluation_experiments(tenant_key,workspace_key,id);

CREATE FUNCTION guard_evaluation_dataset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'EVALUATION_DATASET_IMMUTABLE' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF (NEW.tenant_key,NEW.workspace_key,NEW.contract_version) IS DISTINCT FROM
     (OLD.tenant_key,OLD.workspace_key,OLD.contract_version) THEN
    RAISE EXCEPTION 'EVALUATION_SCOPE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  -- FK tombstones for deleted users/agents are permitted; snapshots are separate.
  IF OLD.status <> 'draft' AND (
    (to_jsonb(NEW) - ARRAY['updated_at','status','agent_id','created_by_user_id']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['updated_at','status','agent_id','created_by_user_id'])
    OR (NEW.agent_id IS DISTINCT FROM OLD.agent_id AND NEW.agent_id IS NOT NULL)
    OR (NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id AND NEW.created_by_user_id IS NOT NULL)
    OR NOT (NEW.status = OLD.status OR (OLD.status='active' AND NEW.status='archived'))
  ) THEN RAISE EXCEPTION 'EVALUATION_DATASET_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF OLD.status='draft' AND NEW.status='active' AND NEW.contract_version=1 AND
     (NEW.content_sha256 IS NULL OR NEW.content_sha256 !~ '^[0-9a-f]{64}$' OR NEW.case_count<1) THEN
    RAISE EXCEPTION 'EVALUATION_DATASET_NOT_FROZEN' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_dataset_guard BEFORE UPDATE OR DELETE ON mcp_evaluation_datasets
  FOR EACH ROW EXECUTE FUNCTION guard_evaluation_dataset();

CREATE FUNCTION guard_evaluation_case() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ds mcp_evaluation_datasets%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['source_trace_id','source_span_id','created_by_user_id']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['source_trace_id','source_span_id','created_by_user_id'])
       OR (NEW.source_trace_id IS DISTINCT FROM OLD.source_trace_id AND NEW.source_trace_id IS NOT NULL)
       OR (NEW.source_span_id IS DISTINCT FROM OLD.source_span_id AND NEW.source_span_id IS NOT NULL)
       OR (NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id AND NEW.created_by_user_id IS NOT NULL)
    THEN RAISE EXCEPTION 'EVALUATION_CASE_IMMUTABLE' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  -- Same row lock as activation: no insert can slip between hashing and activation.
  SELECT * INTO ds FROM mcp_evaluation_datasets
    WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.dataset_id ELSE NEW.dataset_id END FOR UPDATE;
  IF ds.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'EVALUATION_DATASET_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF ds.contract_version=1 AND (NEW.rules IS NULL OR jsonb_typeof(NEW.rules)<>'object') THEN
      RAISE EXCEPTION 'EVALUATION_RULES_REQUIRED' USING ERRCODE='23514';
    END IF;
    UPDATE mcp_evaluation_datasets SET case_count=case_count+1,updated_at=now() WHERE id=ds.id;
    RETURN NEW;
  END IF;
  UPDATE mcp_evaluation_datasets SET case_count=case_count-1,updated_at=now() WHERE id=ds.id;
  RETURN OLD;
END $$;
CREATE TRIGGER evaluation_case_guard BEFORE INSERT OR UPDATE OR DELETE ON mcp_evaluation_cases
  FOR EACH ROW EXECUTE FUNCTION guard_evaluation_case();

CREATE FUNCTION guard_evaluation_experiment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ds mcp_evaluation_datasets%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EVALUATION_SNAPSHOT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO ds FROM mcp_evaluation_datasets WHERE id=NEW.dataset_id FOR SHARE;
    IF (NEW.tenant_key,NEW.workspace_key) IS DISTINCT FROM (ds.tenant_key,ds.workspace_key) THEN
      RAISE EXCEPTION 'EVALUATION_SCOPE_MISMATCH' USING ERRCODE='23514';
    END IF;
    IF NEW.evidence_kind <> 'frozen_v1' OR ds.status <> 'active' OR ds.contract_version<>1
       OR NEW.dataset_sha256 IS DISTINCT FROM ds.content_sha256
       OR NEW.expected_cases IS NULL OR jsonb_typeof(NEW.expected_cases)<>'array'
       OR jsonb_array_length(NEW.expected_cases)<>ds.case_count
       OR NEW.configuration_snapshot IS NULL OR jsonb_typeof(NEW.configuration_snapshot)<>'object'
       OR NEW.configuration_sha256 IS NULL OR NEW.configuration_sha256 !~ '^[0-9a-f]{64}$'
       OR NEW.evaluator_sha256 IS NULL OR NEW.evaluator_sha256 !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'EVALUATION_SNAPSHOT_REQUIRED' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(DISTINCT item->>'id') FROM jsonb_array_elements(NEW.expected_cases) item)<>ds.case_count
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.expected_cases) item WHERE NOT EXISTS (
         SELECT 1 FROM mcp_evaluation_cases c WHERE c.dataset_id=ds.id AND c.id::text=item->>'id'
       )) THEN RAISE EXCEPTION 'EVALUATION_CASE_SET_MISMATCH' USING ERRCODE='23514'; END IF;
    IF NEW.baseline_experiment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM mcp_evaluation_experiments b WHERE b.id=NEW.baseline_experiment_id
        AND b.tenant_key=NEW.tenant_key AND b.workspace_key=NEW.workspace_key
        AND b.dataset_id=NEW.dataset_id AND b.evidence_kind='frozen_v1'
        AND b.dataset_sha256=NEW.dataset_sha256 AND b.evaluator_sha256=NEW.evaluator_sha256
    ) THEN RAISE EXCEPTION 'EVALUATION_BASELINE_INCOMPATIBLE' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['status','started_at','completed_at','agent_id','baseline_experiment_id','created_by_user_id'])
     IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','started_at','completed_at','agent_id','baseline_experiment_id','created_by_user_id'])
     OR (NEW.agent_id IS DISTINCT FROM OLD.agent_id AND NEW.agent_id IS NOT NULL)
     OR (NEW.baseline_experiment_id IS DISTINCT FROM OLD.baseline_experiment_id AND NEW.baseline_experiment_id IS NOT NULL)
     OR (NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id AND NEW.created_by_user_id IS NOT NULL)
  THEN RAISE EXCEPTION 'EVALUATION_SNAPSHOT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_experiment_guard BEFORE INSERT OR UPDATE OR DELETE ON mcp_evaluation_experiments
  FOR EACH ROW EXECUTE FUNCTION guard_evaluation_experiment();

CREATE FUNCTION guard_evaluation_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'EVALUATION_RESULT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'trace_id') IS DISTINCT FROM (to_jsonb(OLD)-'trace_id')
       OR NEW.trace_id IS NOT NULL THEN
      RAISE EXCEPTION 'EVALUATION_RESULT_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mcp_evaluation_experiments e JOIN mcp_evaluation_cases c ON c.dataset_id=e.dataset_id
      WHERE e.id=NEW.experiment_id AND c.id=NEW.case_id AND e.status='running'
        AND e.evidence_kind='frozen_v1'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.expected_cases) item WHERE item->>'id'=c.id::text)
  ) THEN RAISE EXCEPTION 'EVALUATION_RESULT_CASE_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_result_guard BEFORE INSERT OR UPDATE OR DELETE ON mcp_evaluation_results
  FOR EACH ROW EXECUTE FUNCTION guard_evaluation_result();
