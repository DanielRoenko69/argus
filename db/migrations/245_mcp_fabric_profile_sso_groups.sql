-- Migration 245: environment-local SSO group mappings for portable Fabric profiles.
-- The manifest carries logical aliases only. Concrete Entra/SSO group names stay
-- local and the provenance table makes access reconciliation reviewable.

ALTER TABLE mcp_fabric_profiles
  ADD COLUMN IF NOT EXISTS applied_mappings JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS mcp_fabric_profile_group_bindings (
  profile_id         BIGINT NOT NULL REFERENCES mcp_fabric_profiles(id) ON DELETE CASCADE,
  logical_name       VARCHAR(128) NOT NULL,
  group_name         VARCHAR(128) NOT NULL,
  composite_id       INTEGER NOT NULL REFERENCES mcp_composites(id) ON DELETE CASCADE,
  assignment_owned   BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, logical_name),
  CONSTRAINT mcp_fabric_profile_group_logical_name CHECK (logical_name ~ '^[a-z0-9][a-z0-9_-]*$'),
  CONSTRAINT mcp_fabric_profile_group_name_nonempty CHECK (length(btrim(group_name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_mcp_fabric_profile_group_bindings_target
  ON mcp_fabric_profile_group_bindings (group_name, composite_id);

COMMENT ON TABLE mcp_fabric_profile_group_bindings IS
  'Local SSO group mappings applied by a portable Fabric profile; no identity-provider credentials are stored.';
