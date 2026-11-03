-- Migration 016: Composite MCP Server (Virtuelle Multi-Bundle Endpoints)
-- Aggregiert mehrere Bundles unter einem einzigen /mcp/composite/:name Endpoint.

CREATE TABLE IF NOT EXISTS mcp_composites (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(128) NOT NULL UNIQUE,
  description         TEXT NOT NULL DEFAULT '',
  included_bundle_ids INTEGER[] NOT NULL DEFAULT '{}',   -- leer = alle Bundles
  tool_allow_patterns TEXT[] NOT NULL DEFAULT '{}',      -- leer = alle Tools erlaubt
  tool_deny_patterns  TEXT[] NOT NULL DEFAULT '{}',      -- Blacklist
  system_prompt       TEXT,
  agent_role          VARCHAR(128),
  enabled             BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT composite_name_format CHECK (name ~ '^[a-z0-9_-]+$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_composites_enabled
  ON mcp_composites (enabled);

-- API-Keys können an einen Composite gebunden werden
ALTER TABLE mcp_api_keys
  ADD COLUMN IF NOT EXISTS composite_id INTEGER REFERENCES mcp_composites(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_composite
  ON mcp_api_keys (composite_id)
  WHERE composite_id IS NOT NULL;

CREATE OR REPLACE FUNCTION update_mcp_composites_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_composites_updated_at ON mcp_composites;
CREATE TRIGGER trg_mcp_composites_updated_at
  BEFORE UPDATE ON mcp_composites
  FOR EACH ROW EXECUTE FUNCTION update_mcp_composites_updated_at();

COMMENT ON TABLE mcp_composites IS
  'Virtuelle MCP-Endpoints die mehrere Bundles aggregieren unter /mcp/composite/:name.';
COMMENT ON COLUMN mcp_composites.included_bundle_ids IS
  'Bundle-IDs die enthalten sind (leer = alle Bundles des API-Keys).';
COMMENT ON COLUMN mcp_composites.tool_allow_patterns IS
  'Whitelist-Glob-Patterns für Tool-Namen (leer = alle erlaubt).';
