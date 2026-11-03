-- ============================================================
-- Migration 005: Many-to-Many Backend/Tool ↔ Bundle relationship
-- ============================================================
-- Replaces the single bundle_id FK with junction tables so that
-- one backend or tool can belong to multiple service bundles.
-- ============================================================

-- 1. Junction table: backends ↔ bundles
CREATE TABLE IF NOT EXISTS mcp_backend_bundles (
  backend_id  INTEGER NOT NULL REFERENCES mcp_backends(id) ON DELETE CASCADE,
  bundle_id   INTEGER NOT NULL REFERENCES mcp_service_bundles(id) ON DELETE CASCADE,
  PRIMARY KEY (backend_id, bundle_id)
);

-- 2. Junction table: tools ↔ bundles
CREATE TABLE IF NOT EXISTS mcp_tool_bundles (
  tool_id     INTEGER NOT NULL REFERENCES mcp_tools(id) ON DELETE CASCADE,
  bundle_id   INTEGER NOT NULL REFERENCES mcp_service_bundles(id) ON DELETE CASCADE,
  PRIMARY KEY (tool_id, bundle_id)
);

-- 3. Migrate existing bundle_id data into junction tables (idempotent)
INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT id, bundle_id FROM mcp_backends WHERE bundle_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
SELECT id, bundle_id FROM mcp_tools WHERE bundle_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 4. Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_mcp_backend_bundles_bundle ON mcp_backend_bundles (bundle_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_bundles_bundle ON mcp_tool_bundles (bundle_id);

-- Note: The old bundle_id columns on mcp_backends and mcp_tools are kept for
-- backwards compatibility but no longer used by the application code.
-- They can be dropped in a future migration once all deployments are updated.
