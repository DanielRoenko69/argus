-- Provider-neutral feedback attached to native Argus traces and spans.
-- Human revisions are retained as inactive history; model/policy producers use
-- stable external IDs for idempotent writes.

CREATE TABLE IF NOT EXISTS mcp_observability_feedback (
  id                  BIGSERIAL PRIMARY KEY,
  trace_id            UUID NOT NULL REFERENCES mcp_observability_traces(id) ON DELETE CASCADE,
  span_id             UUID REFERENCES mcp_observability_spans(id) ON DELETE CASCADE,
  source              VARCHAR(16) NOT NULL
                      CHECK (source IN ('human', 'model', 'policy', 'import')),
  label               VARCHAR(64) NOT NULL DEFAULT 'overall',
  score               NUMERIC(6,5)
                      CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  sentiment           VARCHAR(16)
                      CHECK (sentiment IS NULL OR sentiment IN ('positive', 'neutral', 'negative', 'mixed')),
  comment             TEXT,
  tags                TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id  INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  external_id         TEXT,
  supersedes_id       BIGINT REFERENCES mcp_observability_feedback(id) ON DELETE SET NULL,
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (score IS NOT NULL OR sentiment IS NOT NULL OR comment IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_observability_feedback_trace
  ON mcp_observability_feedback (trace_id, active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observability_feedback_span
  ON mcp_observability_feedback (span_id, active, created_at DESC)
  WHERE span_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observability_feedback_label
  ON mcp_observability_feedback (label, source, active, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_observability_feedback_external
  ON mcp_observability_feedback (external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_observability_feedback_active_human
  ON mcp_observability_feedback (
    trace_id,
    COALESCE(span_id, '00000000-0000-0000-0000-000000000000'::uuid),
    label,
    created_by_user_id
  )
  WHERE active AND source='human' AND created_by_user_id IS NOT NULL;

COMMENT ON TABLE mcp_observability_feedback IS
  'Native human, model, policy and imported evaluation signals for Argus traces and spans.';
COMMENT ON COLUMN mcp_observability_feedback.comment IS
  'Bounded and PII-redacted reviewer note; never used as an executable replay instruction.';
COMMENT ON COLUMN mcp_observability_feedback.external_id IS
  'Stable producer-owned idempotency key, e.g. continuous-eval:<trace>:helpfulness.';
