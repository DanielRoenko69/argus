-- Adaptive native alert signals compare a current observation window with a
-- historical 7-day baseline (and a 30-day fallback when evidence is sparse).

ALTER TABLE mcp_observability_alert_rules
  DROP CONSTRAINT IF EXISTS mcp_observability_alert_rules_metric_check;

ALTER TABLE mcp_observability_alert_rules
  ADD CONSTRAINT mcp_observability_alert_rules_metric_check
  CHECK (metric IN (
    'error_rate', 'success_rate', 'p95_latency_ms', 'total_cost_usd', 'failure_count',
    'latency_regression_percent', 'cost_regression_percent'
  ));

INSERT INTO mcp_observability_alert_rules
  (name, description, metric, operator, threshold, window_minutes, min_samples,
   severity, scope_kind, scope_value, cooldown_minutes, notify, enabled, created_by)
SELECT
  'Adaptive · Execution latency regression',
  'Detects a sustained P95 latency increase against the preceding 7-day baseline, with a 30-day fallback.',
  'latency_regression_percent', 'gt', 50, 30, 10,
  'warning', 'all', NULL, 60, false, true, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM mcp_observability_alert_rules
   WHERE name = 'Adaptive · Execution latency regression'
);

INSERT INTO mcp_observability_alert_rules
  (name, description, metric, operator, threshold, window_minutes, min_samples,
   severity, scope_kind, scope_value, cooldown_minutes, notify, enabled, created_by)
SELECT
  'Adaptive · Cost per execution regression',
  'Detects a sustained increase in average trace-attributed cost against the preceding 7-day baseline, with a 30-day fallback.',
  'cost_regression_percent', 'gt', 75, 60, 10,
  'warning', 'all', NULL, 120, false, true, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM mcp_observability_alert_rules
   WHERE name = 'Adaptive · Cost per execution regression'
);

COMMENT ON COLUMN mcp_observability_alert_rules.metric IS
  'Absolute or adaptive native telemetry signal. Regression metrics are percentages relative to a historical baseline.';
