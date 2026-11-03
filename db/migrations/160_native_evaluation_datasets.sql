-- Native, provider-neutral evaluation datasets and experiments.
-- Dataset content is explicitly redacted input/context, never an implicit copy
-- of production prompts. Credentials remain in the existing credential-profile
-- layer; this schema stores only a reference and reproducibility metadata.

CREATE TABLE IF NOT EXISTS mcp_evaluation_datasets (
  id                   BIGSERIAL PRIMARY KEY,
  dataset_key          VARCHAR(160) NOT NULL,
  version              INTEGER NOT NULL CHECK (version > 0),
  name                 VARCHAR(240) NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  bundle_ids           INTEGER[] NOT NULL DEFAULT '{}',
  agent_id             INTEGER REFERENCES mcp_agents(id) ON DELETE SET NULL,
  status               VARCHAR(16) NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'active', 'archived')),
  case_count           INTEGER NOT NULL DEFAULT 0 CHECK (case_count >= 0),
  content_sha256       CHAR(64),
  created_by_user_id    INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_key, version)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_datasets_scope
  ON mcp_evaluation_datasets (agent_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS mcp_evaluation_cases (
  id                   BIGSERIAL PRIMARY KEY,
  dataset_id           BIGINT NOT NULL REFERENCES mcp_evaluation_datasets(id) ON DELETE CASCADE,
  case_key             VARCHAR(160) NOT NULL,
  input_redacted       JSONB NOT NULL,
  expected_output      JSONB,
  context_redacted     JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_trace_id      UUID REFERENCES mcp_observability_traces(id) ON DELETE SET NULL,
  source_span_id       UUID REFERENCES mcp_observability_spans(id) ON DELETE SET NULL,
  input_sha256         CHAR(64) NOT NULL,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id    INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, case_key)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_cases_dataset
  ON mcp_evaluation_cases (dataset_id, id);
CREATE INDEX IF NOT EXISTS idx_evaluation_cases_source_trace
  ON mcp_evaluation_cases (source_trace_id)
  WHERE source_trace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mcp_evaluation_experiments (
  id                     BIGSERIAL PRIMARY KEY,
  dataset_id             BIGINT NOT NULL REFERENCES mcp_evaluation_datasets(id) ON DELETE RESTRICT,
  agent_id               INTEGER REFERENCES mcp_agents(id) ON DELETE SET NULL,
  model_ref              VARCHAR(240) NOT NULL,
  credential_ref         VARCHAR(240),
  evaluator_config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  baseline_experiment_id BIGINT REFERENCES mcp_evaluation_experiments(id) ON DELETE SET NULL,
  status                 VARCHAR(16) NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  created_by_user_id     INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_experiments_dataset
  ON mcp_evaluation_experiments (dataset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluation_experiments_status
  ON mcp_evaluation_experiments (status, created_at DESC);

CREATE TABLE IF NOT EXISTS mcp_evaluation_results (
  id                BIGSERIAL PRIMARY KEY,
  experiment_id     BIGINT NOT NULL REFERENCES mcp_evaluation_experiments(id) ON DELETE CASCADE,
  case_id           BIGINT NOT NULL REFERENCES mcp_evaluation_cases(id) ON DELETE RESTRICT,
  attempt           INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  trace_id          UUID REFERENCES mcp_observability_traces(id) ON DELETE SET NULL,
  status            VARCHAR(16) NOT NULL
                    CHECK (status IN ('passed', 'failed', 'error', 'skipped')),
  output_redacted   JSONB,
  latency_ms        INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  input_tokens      INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens     INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd          NUMERIC(12,8) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  scores            JSONB NOT NULL DEFAULT '{}'::jsonb,
  evaluator_version VARCHAR(120),
  error_message     VARCHAR(320),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, case_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_results_experiment
  ON mcp_evaluation_results (experiment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluation_results_trace
  ON mcp_evaluation_results (trace_id)
  WHERE trace_id IS NOT NULL;

COMMENT ON TABLE mcp_evaluation_datasets IS
  'Versioned, explicitly curated Argus evaluation datasets with bundle/agent scope.';
COMMENT ON TABLE mcp_evaluation_cases IS
  'Append-only API-owned redacted evaluation inputs and expected evidence; production content is never copied implicitly.';
COMMENT ON TABLE mcp_evaluation_experiments IS
  'Pinned dataset/model/evaluator runs; credential_ref points to the existing secret layer.';
COMMENT ON TABLE mcp_evaluation_results IS
  'Per-case evaluation evidence with bounded output, trace, latency, cost and score data.';
