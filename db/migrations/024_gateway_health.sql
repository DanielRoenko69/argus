-- Migration 024: Gateway Deployment Health Tracking
-- Adds mcp_deployment_health table and fallback configuration

CREATE TABLE IF NOT EXISTS mcp_deployment_health (
  model_id          INTEGER PRIMARY KEY REFERENCES mcp_models(id) ON DELETE CASCADE,
  status            VARCHAR(16) DEFAULT 'healthy',
  last_checked      TIMESTAMPTZ DEFAULT now(),
  last_error        TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  latency_ms        INTEGER
);

COMMENT ON TABLE mcp_deployment_health IS 'Gateway deployment health tracking';

CREATE TABLE IF NOT EXISTS mcp_fallbacks (
  id                SERIAL PRIMARY KEY,
  model_group       VARCHAR(128) NOT NULL,
  fallback_group    VARCHAR(128) NOT NULL,
  trigger_errors    TEXT[] DEFAULT '{}',
  retry_count       INTEGER DEFAULT 1,
  retry_delay_ms    INTEGER DEFAULT 1000,
  enabled           BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fallbacks_group ON mcp_fallbacks(model_group, fallback_group);
