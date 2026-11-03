-- Migration 094: IT-Ops-specific workflow extras
-- - maintenance_window: workflow runs only during allowed hours
-- - subscribers: per-user notification on success/failure
-- - pagerduty_integration_key per workflow
-- - compliance preset tags are stored in existing tags[] array (no schema change)

ALTER TABLE mcp_workflows
  ADD COLUMN IF NOT EXISTS maintenance_window JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS pagerduty_key VARCHAR(64);

COMMENT ON COLUMN mcp_workflows.maintenance_window IS
  'Optional time-window for cron/webhook triggers. Schema: { days: ["mon","tue","wed","thu","fri"], from: "09:00", to: "17:00", timezone: "Europe/Berlin" }';

COMMENT ON COLUMN mcp_workflows.pagerduty_key IS
  'PagerDuty integration key. If set, workflow failures POST to PD events API.';

CREATE TABLE IF NOT EXISTS mcp_workflow_subscribers (
  user_id      INTEGER NOT NULL,
  workflow_id  INTEGER NOT NULL REFERENCES mcp_workflows(id) ON DELETE CASCADE,
  on_success   BOOLEAN NOT NULL DEFAULT false,
  on_failure   BOOLEAN NOT NULL DEFAULT true,
  channel      VARCHAR(16) NOT NULL DEFAULT 'slack',
  channel_target VARCHAR(256),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workflow_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_wf_subscribers_wf ON mcp_workflow_subscribers (workflow_id);

COMMENT ON TABLE mcp_workflow_subscribers IS
  'Per-user subscription to workflow events. channel = slack|email|teams, channel_target = user/channel id.';
