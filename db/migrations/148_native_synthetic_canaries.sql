-- Restart-safe execution evidence for native synthetic Agent canaries.
-- Runtime configuration lives in mcp_platform_settings under
-- category='synthetic_canaries', key='config'; secrets remain environment/Vault-only.

CREATE TABLE IF NOT EXISTS mcp_observability_canary_runs (
  id              BIGSERIAL PRIMARY KEY,
  agent_id        INTEGER NOT NULL,
  agent_name      VARCHAR(160) NOT NULL,
  status          VARCHAR(16) NOT NULL
                  CHECK (status IN ('ok', 'failed', 'timeout', 'error')),
  latency_ms      INTEGER NOT NULL CHECK (latency_ms >= 0),
  error_message   VARCHAR(320),
  source          VARCHAR(16) NOT NULL DEFAULT 'scheduled'
                  CHECK (source IN ('scheduled', 'manual')),
  triggered_by    VARCHAR(160),
  started_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_observability_canary_runs_recent
  ON mcp_observability_canary_runs (completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_observability_canary_runs_agent
  ON mcp_observability_canary_runs (agent_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_observability_canary_runs_schedule
  ON mcp_observability_canary_runs (source, completed_at DESC);

COMMENT ON TABLE mcp_observability_canary_runs IS
  'Persistent, privacy-minimized execution evidence for scheduled and manually triggered synthetic Agent canaries.';
COMMENT ON COLUMN mcp_observability_canary_runs.error_message IS
  'Bounded operational failure reason; model response content and credentials are never persisted.';
