-- Canonical workspace tags shared by Agents, Workflows, Knowledge, Skills,
-- repository snapshots, public channels and MCP Fabric resources.
--
-- Resource IDs stay opaque in the junction because Argus resources live in
-- different tables and use different integer widths. Application code owns
-- existence and authorization checks through a closed resource-type registry.

CREATE TABLE IF NOT EXISTS mcp_workspace_tags (
  id                  BIGSERIAL PRIMARY KEY,
  workspace_key       VARCHAR(128) NOT NULL DEFAULT 'default',
  slug                VARCHAR(64) NOT NULL,
  label               VARCHAR(128) NOT NULL,
  color               VARCHAR(9),
  description         VARCHAR(512) NOT NULL DEFAULT '',
  created_by_user_id  INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_workspace_tags_workspace_nonempty CHECK (length(btrim(workspace_key)) > 0),
  CONSTRAINT mcp_workspace_tags_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$'),
  CONSTRAINT mcp_workspace_tags_label_nonempty CHECK (length(btrim(label)) > 0),
  CONSTRAINT mcp_workspace_tags_color_format CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$'),
  UNIQUE (workspace_key, slug),
  UNIQUE (workspace_key, id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_tags_label
  ON mcp_workspace_tags (workspace_key, lower(label));

CREATE TABLE IF NOT EXISTS mcp_resource_tag_assignments (
  workspace_key       VARCHAR(128) NOT NULL DEFAULT 'default',
  tag_id              BIGINT NOT NULL,
  resource_type       VARCHAR(32) NOT NULL,
  resource_id         VARCHAR(128) NOT NULL,
  assigned_by_user_id INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  assigned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_resource_tag_assignment_tag_fk
    FOREIGN KEY (workspace_key, tag_id)
    REFERENCES mcp_workspace_tags(workspace_key, id)
    ON DELETE CASCADE,
  CONSTRAINT mcp_resource_tag_resource_type CHECK (resource_type IN (
    'agent',
    'blueprint',
    'public_widget',
    'knowledge_source',
    'repository_snapshot',
    'skill',
    'workflow',
    'workflow_template',
    'mcp_connection',
    'mcp_bundle',
    'mcp_tool',
    'mcp_capability'
  )),
  CONSTRAINT mcp_resource_tag_resource_id_nonempty CHECK (length(btrim(resource_id)) > 0),
  PRIMARY KEY (workspace_key, tag_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_tag_assignments_resource
  ON mcp_resource_tag_assignments (workspace_key, resource_type, resource_id, assigned_at);

CREATE INDEX IF NOT EXISTS idx_resource_tag_assignments_tag
  ON mcp_resource_tag_assignments (workspace_key, tag_id, resource_type);

CREATE OR REPLACE FUNCTION update_mcp_workspace_tags_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_workspace_tags_updated_at ON mcp_workspace_tags;
CREATE TRIGGER trg_mcp_workspace_tags_updated_at
  BEFORE UPDATE ON mcp_workspace_tags
  FOR EACH ROW EXECUTE FUNCTION update_mcp_workspace_tags_updated_at();

COMMENT ON TABLE mcp_workspace_tags IS
  'Canonical bounded tag registry. Tag labels are current catalog state; historical runs freeze their own TagRef snapshots.';
COMMENT ON TABLE mcp_resource_tag_assignments IS
  'Current audited tag assignments for a closed set of Argus resource types. Resource existence is enforced by the application service.';
