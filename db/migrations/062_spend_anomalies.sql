-- Migration 062: Spend anomaly tracking
-- Detects runaway agent loops by comparing 15min window spend against
-- a trailing-7d hourly baseline. When ratio > threshold the key is
-- auto-throttled (rpm_limit clamped down) and an alert is fired.

CREATE TABLE IF NOT EXISTS mcp_spend_anomalies (
  id              SERIAL PRIMARY KEY,
  key_prefix      VARCHAR(8) NOT NULL,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_minutes  INTEGER     NOT NULL,
  window_spend    NUMERIC(16,8) NOT NULL,  -- USD spend in the detection window
  baseline_hourly NUMERIC(16,8) NOT NULL,  -- trailing 7d hourly average
  ratio           NUMERIC(8,2)  NOT NULL,  -- window_hourly / baseline_hourly
  action          VARCHAR(16) NOT NULL,    -- 'throttle' | 'alert' | 'block'
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_spend_anomalies_key
  ON mcp_spend_anomalies (key_prefix, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_spend_anomalies_open
  ON mcp_spend_anomalies (key_prefix)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE mcp_spend_anomalies IS
  'Auto-detected runaway spend events. Action throttle means rpm_limit was clamped.';
