-- Durable, privacy-minimized evidence for opt-in read-only CI provider canaries.
-- Credentials and provider response bodies are never stored.

CREATE TABLE IF NOT EXISTS mcp_observability_ci_canary_runs (
  id              BIGSERIAL PRIMARY KEY,
  provider        VARCHAR(16) NOT NULL
                  CHECK (provider IN ('gitea', 'github', 'gitlab', 'jenkins')),
  external_id     VARCHAR(200) NOT NULL,
  status          VARCHAR(16) NOT NULL
                  CHECK (status IN ('ok', 'failed', 'timeout', 'error')),
  http_status     INTEGER,
  latency_ms      INTEGER NOT NULL CHECK (latency_ms >= 0),
  provider_status VARCHAR(120),
  error_message   VARCHAR(320),
  source          VARCHAR(16) NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual', 'scheduled', 'internal')),
  triggered_by    VARCHAR(160),
  started_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_observability_ci_canary_recent
  ON mcp_observability_ci_canary_runs (completed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_observability_ci_canary_target
  ON mcp_observability_ci_canary_runs (provider, external_id, completed_at DESC);

COMMENT ON TABLE mcp_observability_ci_canary_runs IS
  'Persistent, read-only CI provider canary evidence; provider credentials and response bodies are excluded.';
