-- 049: Enhanced Logs — request/response capture, gateway admin audit log, soft-delete for keys/teams

-- 1. Enrich spend logs with request/response content
ALTER TABLE mcp_spend_logs
  ADD COLUMN IF NOT EXISTS messages    JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS response    JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS session_id  VARCHAR(128) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS requester_ip VARCHAR(64)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS team_id     INTEGER DEFAULT NULL;

-- 2. Gateway admin audit log (who created/updated/deleted what)
CREATE TABLE IF NOT EXISTS mcp_gateway_admin_audit_log (
  id                  BIGSERIAL PRIMARY KEY,
  action              VARCHAR(32)  NOT NULL,   -- created | updated | deleted | rotated
  table_name          VARCHAR(64)  NOT NULL,   -- mcp_api_keys | mcp_teams | mcp_models | ...
  object_id           VARCHAR(128) NOT NULL,   -- key_prefix, team id, model id
  object_label        VARCHAR(256),            -- human-readable name
  changed_by          VARCHAR(128),            -- username or 'key:<prefix>'
  changed_by_api_key  VARCHAR(16),             -- api key prefix of admin actor
  before_state        JSONB,
  after_state         JSONB,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gw_audit_log_time      ON mcp_gateway_admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gw_audit_log_table     ON mcp_gateway_admin_audit_log (table_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gw_audit_log_action    ON mcp_gateway_admin_audit_log (action);
CREATE INDEX IF NOT EXISTS idx_gw_audit_log_actor     ON mcp_gateway_admin_audit_log (changed_by);

-- 3. Soft-delete for keys and teams
ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE mcp_teams    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_not_deleted ON mcp_api_keys (key_prefix) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_teams_not_deleted    ON mcp_teams (id)            WHERE deleted_at IS NULL;
