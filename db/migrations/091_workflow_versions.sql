-- Migration 091: Workflow version history + spend-anomaly tracking.

CREATE TABLE IF NOT EXISTS mcp_workflow_versions (
  id              BIGSERIAL PRIMARY KEY,
  workflow_id     INTEGER NOT NULL REFERENCES mcp_workflows(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  steps           JSONB NOT NULL,
  input_params    JSONB NOT NULL DEFAULT '[]',
  canvas_state    JSONB NOT NULL DEFAULT '{}',
  block_definitions JSONB NOT NULL DEFAULT '[]',
  trigger_config  JSONB NOT NULL DEFAULT '{}',
  saved_by        VARCHAR(128),
  saved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  comment         TEXT,
  UNIQUE (workflow_id, version)
);
CREATE INDEX IF NOT EXISTS idx_wfv_workflow ON mcp_workflow_versions (workflow_id, version DESC);

COMMENT ON TABLE mcp_workflow_versions IS
  'Append-only version history. Created on every PUT /api/workflows/:id/flow.';

-- Spend-anomalies: cron writes a row when a user's spend exceeds 3× their 7-day average.
CREATE TABLE IF NOT EXISTS mcp_spend_anomalies (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER,
  username    VARCHAR(128),
  current_spend NUMERIC(10,4),
  avg_7d        NUMERIC(10,4),
  ratio         NUMERIC(6,2),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by VARCHAR(128)
);
-- Defensive: if an older table-version exists from a previous attempt, add the missing columns.
ALTER TABLE mcp_spend_anomalies
  ADD COLUMN IF NOT EXISTS user_id     INTEGER,
  ADD COLUMN IF NOT EXISTS username    VARCHAR(128),
  ADD COLUMN IF NOT EXISTS current_spend NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS avg_7d        NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS ratio         NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by VARCHAR(128);
CREATE INDEX IF NOT EXISTS idx_anomalies_unack ON mcp_spend_anomalies (detected_at DESC) WHERE acknowledged_at IS NULL;
COMMENT ON TABLE mcp_spend_anomalies IS
  'Per-user spend anomaly events. Surfaced in /admin/anomalies and via ALERTS_WEBHOOK_URL.';
