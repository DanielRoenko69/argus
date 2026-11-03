-- A code index is readable only through a bundle that was authorized when the
-- exact repository snapshot was ingested. Snapshot ids are not capabilities.

CREATE TABLE IF NOT EXISTS mcp_code_index_snapshot_bundles (
  index_id   BIGINT NOT NULL REFERENCES mcp_code_index_snapshots(id) ON DELETE CASCADE,
  bundle_id  INTEGER NOT NULL REFERENCES mcp_service_bundles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (index_id, bundle_id)
);

CREATE INDEX IF NOT EXISTS idx_code_index_snapshot_bundles_bundle
  ON mcp_code_index_snapshot_bundles (bundle_id, index_id);

COMMENT ON TABLE mcp_code_index_snapshot_bundles IS
  'Authorization boundary linking immutable code indexes to the MCP Bundles that supplied repository access.';

