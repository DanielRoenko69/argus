-- Tool-level permissions per Bundle × Connection.
--
-- mode = all      → every current and future tool from the connection is allowed
-- mode = selected → only names in allowed_tool_names are allowed (future tools fail closed)

CREATE TABLE IF NOT EXISTS mcp_bundle_backend_tool_policies (
  backend_id        INTEGER NOT NULL,
  bundle_id         INTEGER NOT NULL,
  mode              VARCHAR(16) NOT NULL DEFAULT 'all'
                    CHECK (mode IN ('all', 'selected')),
  allowed_tool_names TEXT[] NOT NULL DEFAULT '{}',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (backend_id, bundle_id),
  FOREIGN KEY (backend_id, bundle_id)
    REFERENCES mcp_backend_bundles(backend_id, bundle_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bundle_backend_tool_policies_bundle
  ON mcp_bundle_backend_tool_policies(bundle_id);

COMMENT ON TABLE mcp_bundle_backend_tool_policies IS
  'Tool-level allow policy for a backend inside a bundle. selected mode is fail-closed for newly discovered tools.';
