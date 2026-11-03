-- ============================================================
-- 007: Persistent Metrics Snapshots & Server Events
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_metrics_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
  metric_name     VARCHAR(128) NOT NULL,
  metric_value    DOUBLE PRECISION NOT NULL,
  labels          JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_mcp_metrics_ts ON mcp_metrics_snapshots (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_metrics_name_ts ON mcp_metrics_snapshots (metric_name, timestamp DESC);

CREATE TABLE IF NOT EXISTS mcp_metrics_hourly (
  id              BIGSERIAL PRIMARY KEY,
  hour            TIMESTAMPTZ NOT NULL,
  metric_name     VARCHAR(128) NOT NULL,
  sum_value       DOUBLE PRECISION NOT NULL DEFAULT 0,
  count_value     INTEGER NOT NULL DEFAULT 0,
  min_value       DOUBLE PRECISION,
  max_value       DOUBLE PRECISION,
  avg_value       DOUBLE PRECISION,
  labels          JSONB DEFAULT '{}',
  UNIQUE (hour, metric_name, labels)
);

CREATE INDEX IF NOT EXISTS idx_mcp_metrics_hourly_ts ON mcp_metrics_hourly (hour DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_metrics_hourly_name ON mcp_metrics_hourly (metric_name, hour DESC);

CREATE TABLE IF NOT EXISTS mcp_server_events (
  id              BIGSERIAL PRIMARY KEY,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type      VARCHAR(32) NOT NULL CHECK (event_type IN ('start', 'stop', 'error')),
  details         JSONB DEFAULT '{}'
);
