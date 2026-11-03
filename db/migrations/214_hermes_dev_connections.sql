-- Managed onboarding records for personal Hermes -> Argus Dev MCP connections.
-- The API key and the user policy remain in their canonical RBAC tables. This
-- table owns only the lifecycle relationship so rotation/revocation can remove
-- exactly the policy created for a connector without touching unrelated rules.

CREATE TABLE IF NOT EXISTS mcp_hermes_dev_connections (
  id                  SERIAL PRIMARY KEY,
  label               VARCHAR(128) NOT NULL,
  api_key_id          INTEGER NOT NULL UNIQUE REFERENCES mcp_api_keys(id),
  user_id             INTEGER NOT NULL REFERENCES mcp_users(id),
  user_tool_rule_id   INTEGER REFERENCES mcp_user_tool_rules(id) ON DELETE SET NULL,
  bundle_ids          INTEGER[] NOT NULL CHECK (cardinality(bundle_ids) > 0),
  last_tested_at      TIMESTAMPTZ,
  last_test_state     VARCHAR(16) CHECK (last_test_state IN ('ready', 'blocked', 'failed')),
  last_test_detail    TEXT,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hermes_dev_connections_user
  ON mcp_hermes_dev_connections (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_hermes_dev_connections_active
  ON mcp_hermes_dev_connections (created_at DESC)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE mcp_hermes_dev_connections IS
  'Lifecycle owner for narrowly scoped personal-Hermes MCP credentials and their user-policy grant.';
