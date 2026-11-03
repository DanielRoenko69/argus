-- Approval-gated restore of immutable MCP Fabric Bundle Set revisions.
-- A request is bound to both the historical target digest and the exact
-- current head. Any intervening change makes the request stale at apply time.

CREATE TABLE IF NOT EXISTS mcp_fabric_profile_restore_requests (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id                    INTEGER NOT NULL REFERENCES mcp_fabric_profiles(id) ON DELETE CASCADE,
  target_revision               INTEGER NOT NULL CHECK (target_revision > 0),
  target_manifest_digest        VARCHAR(64) NOT NULL CHECK (target_manifest_digest ~ '^[0-9a-f]{64}$'),
  requested_from_revision       INTEGER NOT NULL CHECK (requested_from_revision > 0),
  requested_from_manifest_digest VARCHAR(64) NOT NULL CHECK (requested_from_manifest_digest ~ '^[0-9a-f]{64}$'),
  mappings                      JSONB NOT NULL DEFAULT '{}'::jsonb,
  plan_token                    VARCHAR(64) NOT NULL CHECK (plan_token ~ '^[0-9a-f]{64}$'),
  plan_snapshot                 JSONB NOT NULL,
  status                        VARCHAR(16) NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'stale')),
  requested_by                  INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  requested_by_username         VARCHAR(160) NOT NULL,
  request_comment               TEXT NOT NULL DEFAULT '',
  decided_by                    INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  decided_by_username           VARCHAR(160),
  decision_comment              TEXT,
  requested_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at                    TIMESTAMPTZ,
  applied_at                    TIMESTAMPTZ,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_fabric_profile_one_open_restore
  ON mcp_fabric_profile_restore_requests (profile_id)
  WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS idx_mcp_fabric_profile_restore_history
  ON mcp_fabric_profile_restore_requests (profile_id, requested_at DESC);

COMMENT ON TABLE mcp_fabric_profile_restore_requests IS
  'Separation-of-duties approval records for digest-bound Bundle Set restores.';
