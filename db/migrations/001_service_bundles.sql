-- ============================================================
-- Migration 001: Service Bundles
-- ============================================================
-- Adds service bundle grouping for backends and tools.
-- Safe to re-run (uses IF NOT EXISTS).
-- ============================================================

-- 1. Bundle table
CREATE TABLE IF NOT EXISTS mcp_service_bundles (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(128) NOT NULL UNIQUE,
  label       VARCHAR(256) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        VARCHAR(32) DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE mcp_service_bundles IS 'Logical grouping of backends and tools by application/service.';

CREATE OR REPLACE FUNCTION update_mcp_service_bundles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_service_bundles_updated_at ON mcp_service_bundles;
CREATE TRIGGER trg_mcp_service_bundles_updated_at
  BEFORE UPDATE ON mcp_service_bundles
  FOR EACH ROW EXECUTE FUNCTION update_mcp_service_bundles_updated_at();

-- 2. Add bundle_id to existing tables
ALTER TABLE mcp_backends ADD COLUMN IF NOT EXISTS bundle_id INTEGER REFERENCES mcp_service_bundles(id) ON DELETE SET NULL;
ALTER TABLE mcp_tools ADD COLUMN IF NOT EXISTS bundle_id INTEGER REFERENCES mcp_service_bundles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_backends_bundle ON mcp_backends (bundle_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_bundle ON mcp_tools (bundle_id);
