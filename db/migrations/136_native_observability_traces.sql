-- Native, provider-neutral execution telemetry for Argus Observability.
-- This store complements optional OpenTelemetry/Langfuse exports and keeps
-- the core trace explorer functional without an external observability SaaS.

CREATE TABLE IF NOT EXISTS mcp_observability_traces (
  id                    UUID PRIMARY KEY,
  external_trace_id     TEXT,
  name                  VARCHAR(160) NOT NULL,
  kind                  VARCHAR(24) NOT NULL
                        CHECK (kind IN ('agent', 'workflow', 'compliance', 'evaluation', 'unknown')),
  status                VARCHAR(16) NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  session_id            TEXT,
  user_id               INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  agent_id              INTEGER REFERENCES mcp_agents(id) ON DELETE SET NULL,
  workflow_execution_id BIGINT REFERENCES mcp_workflow_executions(id) ON DELETE SET NULL,
  model                 TEXT,
  provider              VARCHAR(64),
  started_at            TIMESTAMPTZ NOT NULL,
  ended_at              TIMESTAMPTZ,
  duration_ms           BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  input_preview         JSONB,
  output_preview        JSONB,
  error_message         TEXT,
  input_tokens          BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens         BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_cost_usd        NUMERIC(16, 8) NOT NULL DEFAULT 0 CHECK (total_cost_usd >= 0),
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_observability_spans (
  id                UUID PRIMARY KEY,
  trace_id          UUID NOT NULL REFERENCES mcp_observability_traces(id) ON DELETE CASCADE,
  parent_span_id    UUID REFERENCES mcp_observability_spans(id) ON DELETE SET NULL,
  name              VARCHAR(240) NOT NULL,
  kind              VARCHAR(24) NOT NULL
                    CHECK (kind IN ('llm', 'tool', 'rag', 'workflow', 'approval', 'memory', 'event', 'unknown')),
  status            VARCHAR(16) NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  model             TEXT,
  provider          VARCHAR(64),
  tool_name         VARCHAR(256),
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  duration_ms       BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  input_preview     JSONB,
  output_preview    JSONB,
  error_message     TEXT,
  input_tokens      BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens     BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_cost_usd    NUMERIC(16, 8) NOT NULL DEFAULT 0 CHECK (total_cost_usd >= 0),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_observability_traces_started
  ON mcp_observability_traces (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_observability_traces_status_kind
  ON mcp_observability_traces (status, kind, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_observability_traces_session
  ON mcp_observability_traces (session_id, started_at DESC)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observability_traces_user
  ON mcp_observability_traces (user_id, started_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observability_traces_agent
  ON mcp_observability_traces (agent_id, started_at DESC)
  WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observability_spans_trace
  ON mcp_observability_spans (trace_id, started_at, id);
CREATE INDEX IF NOT EXISTS idx_observability_spans_tool
  ON mcp_observability_spans (tool_name, started_at DESC)
  WHERE tool_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observability_spans_model
  ON mcp_observability_spans (model, started_at DESC)
  WHERE model IS NOT NULL;

COMMENT ON TABLE mcp_observability_traces IS
  'Provider-neutral root executions for native Argus trace exploration and analytics.';
COMMENT ON TABLE mcp_observability_spans IS
  'Hierarchical LLM, tool, RAG, workflow and governance spans belonging to an Argus trace.';
COMMENT ON COLUMN mcp_observability_traces.input_preview IS
  'Bounded and redacted preview; never a source for replaying an execution.';
COMMENT ON COLUMN mcp_observability_spans.input_preview IS
  'Bounded and redacted span input; credential-like fields are replaced before enqueueing.';
