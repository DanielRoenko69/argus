-- Persistent trust state for remote MCP server tool catalogs.

CREATE TABLE IF NOT EXISTS mcp_registry_entries (
  backend_id           INTEGER PRIMARY KEY REFERENCES mcp_backends(id) ON DELETE CASCADE,
  trust_status         VARCHAR(16) NOT NULL DEFAULT 'unverified'
    CHECK (trust_status IN ('unverified', 'trusted', 'changed', 'quarantined')),
  catalog_fingerprint  VARCHAR(64) NOT NULL,
  trusted_fingerprint  VARCHAR(64),
  previous_fingerprint VARCHAR(64),
  tool_count           INTEGER NOT NULL DEFAULT 0 CHECK (tool_count >= 0),
  change_summary       JSONB NOT NULL DEFAULT '{"added":[],"removed":[],"changed":[]}'::jsonb,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at           TIMESTAMPTZ,
  verified_at          TIMESTAMPTZ,
  verified_by_user_id  INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  verification_comment TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_registry_trust_status
  ON mcp_registry_entries (trust_status, last_seen_at DESC);

COMMENT ON TABLE mcp_registry_entries IS
  'Trust state and cryptographic catalog identity for federated remote MCP servers.';
COMMENT ON COLUMN mcp_registry_entries.catalog_fingerprint IS
  'SHA-256 of the normalized, sorted remote tool catalog.';
COMMENT ON COLUMN mcp_registry_entries.trust_status IS
  'unverified=first observation, trusted=approved catalog, changed=unexpected catalog drift, quarantined=explicitly blocked.';
