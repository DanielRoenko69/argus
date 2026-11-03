CREATE TABLE IF NOT EXISTS mcp_transforms (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(64) NOT NULL UNIQUE,
  description     TEXT,
  phase           VARCHAR(16) NOT NULL CHECK (phase IN ('request','response')),
  target_type     VARCHAR(16) DEFAULT 'global'
                  CHECK (target_type IN ('global','model','key','team')),
  target_id       VARCHAR(64) DEFAULT NULL,
  transform_type  VARCHAR(32) NOT NULL
                  CHECK (transform_type IN ('model_override','message_inject','param_override','header_inject','regex_replace')),
  config          JSONB NOT NULL DEFAULT '{}',
  priority        INTEGER DEFAULT 0,
  enabled         BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_transforms_active
  ON mcp_transforms(phase, enabled, priority)
  WHERE enabled = true;
