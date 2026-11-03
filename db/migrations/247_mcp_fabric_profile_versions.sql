-- Migration 247: append-only history for MCP Fabric Bundle Sets.
-- Every saved or applied profile revision receives a complete secret-free
-- snapshot. The history is database-enforced immutable so review evidence and
-- future rollback requests can bind to an exact digest.

CREATE TABLE IF NOT EXISTS mcp_fabric_profile_versions (
  id                   BIGSERIAL PRIMARY KEY,
  profile_id           BIGINT NOT NULL REFERENCES mcp_fabric_profiles(id) ON DELETE CASCADE,
  revision             INTEGER NOT NULL CHECK (revision > 0),
  manifest_version     VARCHAR(32) NOT NULL,
  manifest             JSONB NOT NULL,
  manifest_digest      CHAR(64) NOT NULL,
  source               VARCHAR(24) NOT NULL CHECK (source IN ('local', 'imported')),
  installed_bundle_ids INTEGER[] NOT NULL DEFAULT '{}',
  applied_mappings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  change_kind          VARCHAR(24) NOT NULL CHECK (change_kind IN ('created', 'exported', 'applied')),
  applied              BOOLEAN NOT NULL DEFAULT false,
  created_by           VARCHAR(256),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, revision),
  CONSTRAINT mcp_fabric_profile_version_manifest_object CHECK (jsonb_typeof(manifest) = 'object'),
  CONSTRAINT mcp_fabric_profile_version_mappings_object CHECK (jsonb_typeof(applied_mappings) = 'object')
);

INSERT INTO mcp_fabric_profile_versions (
  profile_id, revision, manifest_version, manifest, manifest_digest, source,
  installed_bundle_ids, applied_mappings, change_kind, applied, created_by, created_at
)
SELECT profile.id, profile.revision, profile.manifest_version, profile.manifest,
       profile.manifest_digest, profile.source, profile.installed_bundle_ids,
       COALESCE(profile.applied_mappings, '{}'::jsonb),
       CASE WHEN profile.last_applied_at IS NULL THEN 'created' ELSE 'applied' END,
       profile.last_applied_at IS NOT NULL, profile.updated_by, profile.updated_at
  FROM mcp_fabric_profiles profile
ON CONFLICT (profile_id, revision) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_mcp_fabric_profile_versions_history
  ON mcp_fabric_profile_versions (profile_id, revision DESC);

CREATE OR REPLACE FUNCTION reject_mcp_fabric_profile_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('argus.allow_fabric_profile_version_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'MCP Fabric profile versions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_mcp_fabric_profile_versions_immutable ON mcp_fabric_profile_versions;
CREATE TRIGGER trg_mcp_fabric_profile_versions_immutable
  BEFORE UPDATE OR DELETE ON mcp_fabric_profile_versions
  FOR EACH ROW EXECUTE FUNCTION reject_mcp_fabric_profile_version_mutation();

COMMENT ON TABLE mcp_fabric_profile_versions IS
  'Append-only secret-free Bundle Set revision snapshots used for review, evidence and approval-bound rollback.';
