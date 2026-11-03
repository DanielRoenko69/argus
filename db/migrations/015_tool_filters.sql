-- Migration 015: Message Filters (Webhook-Hooks vor Tool-Calls)
-- Erlaubt externe Compliance-Checks, Approval-Flows und Audit-Webhooks pro Tool-Aufruf.

CREATE TABLE IF NOT EXISTS mcp_tool_filters (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(128) NOT NULL UNIQUE,
  description    TEXT NOT NULL DEFAULT '',
  webhook_url    TEXT NOT NULL,
  hmac_secret    TEXT,                            -- NULL = keine HMAC-Signatur
  timeout_ms     INTEGER NOT NULL DEFAULT 3000,
  tool_patterns  TEXT[] NOT NULL DEFAULT '{}',   -- Glob-Patterns; leer = alle Tools
  enabled        BOOLEAN NOT NULL DEFAULT true,
  on_timeout     VARCHAR(16) NOT NULL DEFAULT 'allow'
                   CHECK (on_timeout IN ('allow', 'deny')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT filter_name_format CHECK (name ~ '^[a-z0-9_-]+$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_filters_enabled
  ON mcp_tool_filters (enabled);

CREATE OR REPLACE FUNCTION update_mcp_tool_filters_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_tool_filters_updated_at ON mcp_tool_filters;
CREATE TRIGGER trg_mcp_tool_filters_updated_at
  BEFORE UPDATE ON mcp_tool_filters
  FOR EACH ROW EXECUTE FUNCTION update_mcp_tool_filters_updated_at();

COMMENT ON TABLE mcp_tool_filters IS
  'Webhook-Filter die vor jeder Tool-Ausführung aufgerufen werden (Compliance, Approval-Flows).';
COMMENT ON COLUMN mcp_tool_filters.tool_patterns IS
  'Glob-Patterns wie k8s_*, kubectl_* — leer bedeutet alle Tools.';
COMMENT ON COLUMN mcp_tool_filters.on_timeout IS
  'Verhalten bei Webhook-Timeout/Fehler: allow = Tool trotzdem ausführen, deny = blockieren.';
