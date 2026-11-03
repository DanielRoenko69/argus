-- Persistent alert rules and incidents backed by Argus native telemetry.

CREATE TABLE IF NOT EXISTS mcp_observability_alert_rules (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(160) NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  metric              VARCHAR(32) NOT NULL
                      CHECK (metric IN ('error_rate', 'success_rate', 'p95_latency_ms', 'total_cost_usd', 'failure_count')),
  operator            VARCHAR(4) NOT NULL
                      CHECK (operator IN ('gt', 'gte', 'lt', 'lte')),
  threshold           NUMERIC(18, 6) NOT NULL,
  window_minutes      INTEGER NOT NULL DEFAULT 15 CHECK (window_minutes BETWEEN 1 AND 10080),
  min_samples         INTEGER NOT NULL DEFAULT 1 CHECK (min_samples BETWEEN 1 AND 1000000),
  severity            VARCHAR(16) NOT NULL DEFAULT 'warning'
                      CHECK (severity IN ('info', 'warning', 'critical')),
  scope_kind          VARCHAR(16) NOT NULL DEFAULT 'all'
                      CHECK (scope_kind IN ('all', 'agent', 'workflow', 'model', 'tool')),
  scope_value         TEXT,
  cooldown_minutes    INTEGER NOT NULL DEFAULT 60 CHECK (cooldown_minutes BETWEEN 1 AND 10080),
  notify              BOOLEAN NOT NULL DEFAULT true,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  last_state          VARCHAR(16) NOT NULL DEFAULT 'no_data'
                      CHECK (last_state IN ('ok', 'firing', 'no_data')),
  last_value          NUMERIC(18, 6),
  last_sample_count   INTEGER NOT NULL DEFAULT 0,
  last_evaluated_at   TIMESTAMPTZ,
  last_triggered_at   TIMESTAMPTZ,
  created_by          INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_observability_alert_incidents (
  id                  BIGSERIAL PRIMARY KEY,
  rule_id             INTEGER NOT NULL REFERENCES mcp_observability_alert_rules(id) ON DELETE CASCADE,
  state               VARCHAR(16) NOT NULL DEFAULT 'firing'
                      CHECK (state IN ('firing', 'recovered')),
  severity            VARCHAR(16) NOT NULL
                      CHECK (severity IN ('info', 'warning', 'critical')),
  metric_value        NUMERIC(18, 6) NOT NULL,
  threshold           NUMERIC(18, 6) NOT NULL,
  sample_count        INTEGER NOT NULL DEFAULT 0,
  message             TEXT NOT NULL,
  context             JSONB NOT NULL DEFAULT '{}'::jsonb,
  triggered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  recovered_at        TIMESTAMPTZ,
  notified_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_observability_alert_incident_open
  ON mcp_observability_alert_incidents (rule_id)
  WHERE state = 'firing';
CREATE INDEX IF NOT EXISTS idx_observability_alert_rules_enabled
  ON mcp_observability_alert_rules (enabled, last_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_observability_alert_incidents_recent
  ON mcp_observability_alert_incidents (triggered_at DESC);

COMMENT ON TABLE mcp_observability_alert_rules IS
  'Persistent threshold rules evaluated against Argus native trace/span telemetry.';
COMMENT ON TABLE mcp_observability_alert_incidents IS
  'Deduplicated firing and recovered incidents created by native observability rules.';
