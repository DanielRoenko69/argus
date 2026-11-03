-- Server-side tenant/workspace authorization for interactive sessions.
--
-- Client supplied scope headers are selectors only. The application resolves
-- them against this membership set and fails with an opaque not-found result
-- when a selector is not authorized.

CREATE TABLE IF NOT EXISTS mcp_workspace_memberships (
  user_id        INTEGER NOT NULL REFERENCES mcp_users(id) ON DELETE CASCADE,
  tenant_key     VARCHAR(128) NOT NULL,
  workspace_key  VARCHAR(128) NOT NULL,
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_key, workspace_key),
  CONSTRAINT mcp_workspace_membership_tenant_key CHECK (
    tenant_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
  ),
  CONSTRAINT mcp_workspace_membership_workspace_key CHECK (
    workspace_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_workspace_memberships_default
  ON mcp_workspace_memberships (user_id)
  WHERE is_default = TRUE;

CREATE INDEX IF NOT EXISTS idx_mcp_workspace_memberships_scope
  ON mcp_workspace_memberships (tenant_key, workspace_key, user_id);

-- Existing single-workspace installations retain their current behaviour.
INSERT INTO mcp_workspace_memberships (user_id, tenant_key, workspace_key, is_default)
SELECT id, 'default', 'default', TRUE
  FROM mcp_users
ON CONFLICT (user_id, tenant_key, workspace_key) DO NOTHING;

CREATE OR REPLACE FUNCTION ensure_mcp_user_default_workspace_membership()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO mcp_workspace_memberships (user_id, tenant_key, workspace_key, is_default)
  VALUES (NEW.id, 'default', 'default', TRUE)
  ON CONFLICT (user_id, tenant_key, workspace_key) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_user_default_workspace_membership ON mcp_users;
CREATE TRIGGER trg_mcp_user_default_workspace_membership
  AFTER INSERT ON mcp_users
  FOR EACH ROW EXECUTE FUNCTION ensure_mcp_user_default_workspace_membership();

COMMENT ON TABLE mcp_workspace_memberships IS
  'Server-side authorization boundary for tenant/workspace scoped UI and API reads and writes.';
