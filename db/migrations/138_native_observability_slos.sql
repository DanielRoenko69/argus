-- Configurable service-level objectives evaluated against Argus native telemetry.

CREATE TABLE IF NOT EXISTS mcp_observability_slos (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(160) NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  metric              VARCHAR(32) NOT NULL
                      CHECK (metric IN ('success_rate', 'p95_latency_ms')),
  target              NUMERIC(18, 6) NOT NULL CHECK (target > 0),
  window_minutes      INTEGER NOT NULL DEFAULT 1440 CHECK (window_minutes BETWEEN 1 AND 129600),
  min_samples         INTEGER NOT NULL DEFAULT 20 CHECK (min_samples BETWEEN 1 AND 1000000),
  scope_kind          VARCHAR(16) NOT NULL DEFAULT 'all'
                      CHECK (scope_kind IN ('all', 'agent', 'workflow', 'model', 'tool')),
  scope_value         TEXT,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  created_by          INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (metric <> 'success_rate' OR target <= 100)
);

CREATE INDEX IF NOT EXISTS idx_observability_slos_enabled
  ON mcp_observability_slos (enabled, scope_kind, updated_at DESC);

INSERT INTO mcp_observability_slos
  (name, description, metric, target, window_minutes, min_samples, scope_kind, enabled)
SELECT
  'Platform reliability',
  'At least 95% of terminal agent and workflow executions complete successfully.',
  'success_rate', 95, 1440, 20, 'all', true
WHERE NOT EXISTS (
  SELECT 1 FROM mcp_observability_slos WHERE name='Platform reliability'
);

INSERT INTO mcp_observability_slos
  (name, description, metric, target, window_minutes, min_samples, scope_kind, enabled)
SELECT
  'Platform P95 latency',
  'Native end-to-end execution latency remains at or below 30 seconds.',
  'p95_latency_ms', 30000, 1440, 10, 'all', true
WHERE NOT EXISTS (
  SELECT 1 FROM mcp_observability_slos WHERE name='Platform P95 latency'
);

COMMENT ON TABLE mcp_observability_slos IS
  'Component-scoped reliability and latency objectives evaluated against native telemetry.';
