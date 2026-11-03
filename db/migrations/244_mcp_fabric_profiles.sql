-- Migration 244: portable, secret-free MCP Fabric profiles (bundle sets).
-- Profiles capture desired bundle/policy topology. Credentials and endpoints
-- remain owned by the local backend connection records and are never copied.

CREATE TABLE IF NOT EXISTS mcp_fabric_profiles (
  id                   BIGSERIAL PRIMARY KEY,
  name                 VARCHAR(128) NOT NULL UNIQUE,
  label                VARCHAR(256) NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  manifest_version     VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  revision             INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  manifest             JSONB NOT NULL,
  manifest_digest      CHAR(64) NOT NULL,
  source               VARCHAR(24) NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'imported')),
  installed_bundle_ids INTEGER[] NOT NULL DEFAULT '{}',
  created_by           VARCHAR(256),
  updated_by           VARCHAR(256),
  last_applied_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_fabric_profile_name_format CHECK (name ~ '^[a-z0-9][a-z0-9_-]*$'),
  CONSTRAINT mcp_fabric_profile_manifest_object CHECK (jsonb_typeof(manifest) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_mcp_fabric_profiles_updated_at
  ON mcp_fabric_profiles (updated_at DESC);

COMMENT ON TABLE mcp_fabric_profiles IS
  'Versioned secret-free MCP bundle-set manifests for repeatable Fabric provisioning.';
