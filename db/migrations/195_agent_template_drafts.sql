-- Draft workspace for Agent preset authoring. Draft definitions are isolated
-- from the published template catalog until an explicit, version-checked
-- publish transaction succeeds.

CREATE TABLE IF NOT EXISTS mcp_agent_template_drafts (
  name          VARCHAR(128) PRIMARY KEY,
  definition    JSONB NOT NULL,
  base_version  INTEGER NOT NULL DEFAULT 0 CHECK (base_version >= 0),
  preflight_definition_sha256 VARCHAR(64),
  preflight_evidence JSONB,
  preflight_checked_at TIMESTAMPTZ,
  created_by    INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_template_draft_name_format CHECK (name ~ '^[a-z0-9_-]+$'),
  CONSTRAINT agent_template_draft_preflight_hash_format CHECK (
    preflight_definition_sha256 IS NULL OR preflight_definition_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT agent_template_draft_preflight_complete CHECK (
    (preflight_definition_sha256 IS NULL AND preflight_evidence IS NULL AND preflight_checked_at IS NULL)
    OR
    (preflight_definition_sha256 IS NOT NULL AND preflight_evidence IS NOT NULL AND preflight_checked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_template_drafts_updated
  ON mcp_agent_template_drafts (updated_at DESC);

CREATE OR REPLACE FUNCTION update_mcp_agent_template_drafts_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_agent_template_drafts_updated_at ON mcp_agent_template_drafts;
CREATE TRIGGER trg_mcp_agent_template_drafts_updated_at
  BEFORE UPDATE ON mcp_agent_template_drafts
  FOR EACH ROW EXECUTE FUNCTION update_mcp_agent_template_drafts_updated_at();

COMMENT ON TABLE mcp_agent_template_drafts IS
  'Unpublished Agent preset definitions with optimistic base-version locking and hash-bound execution proof.';
