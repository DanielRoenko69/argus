-- Reviews annotate evidence; they never rewrite trace status or evaluation results.
CREATE TABLE IF NOT EXISTS mcp_quality_reviews (
  id BIGSERIAL PRIMARY KEY,
  tenant_key VARCHAR(128) NOT NULL,
  workspace_key VARCHAR(128) NOT NULL,
  trace_id UUID NOT NULL,
  source_sha256 CHAR(64) NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  status VARCHAR(16) NOT NULL CHECK (status IN ('open','reviewed','resolved')),
  verdict VARCHAR(24) NOT NULL CHECK (verdict IN ('needs_review','confirmed_issue','acceptable')),
  note VARCHAR(2000) NOT NULL,
  reviewer_user_id INTEGER NOT NULL,
  previous_review_id BIGINT REFERENCES mcp_quality_reviews(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status='open' OR verdict<>'needs_review')
);
CREATE INDEX IF NOT EXISTS idx_quality_reviews_scope_trace
  ON mcp_quality_reviews(tenant_key,workspace_key,trace_id,id DESC);

CREATE OR REPLACE FUNCTION reject_quality_review_rewrite() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Quality reviews are append-only' USING ERRCODE='23514';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS quality_reviews_append_only ON mcp_quality_reviews;
CREATE TRIGGER quality_reviews_append_only BEFORE UPDATE OR DELETE ON mcp_quality_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_quality_review_rewrite();
COMMENT ON TABLE mcp_quality_reviews IS
  'Scoped human triage revisions, atomically audited. Trace/user IDs are retained references, not retention-blocking FKs. No raw trace payloads.';
