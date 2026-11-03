-- Append-only proof that an external WORM archive was downloaded and independently reverified.

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_retention_restore_drills (
  drill_id                     UUID PRIMARY KEY,
  archive_id                   UUID NOT NULL REFERENCES mcp_canonical_audit_retention_archives(archive_id) ON DELETE RESTRICT,
  workspace_key                VARCHAR(128) NOT NULL,
  tenant_key                   VARCHAR(128) NOT NULL,
  environment                  VARCHAR(64) NOT NULL,
  provider                     VARCHAR(240) NOT NULL CHECK (length(btrim(provider)) > 0),
  reference                    VARCHAR(1000) NOT NULL CHECK (length(btrim(reference)) > 0),
  package_sha256               CHAR(64) NOT NULL CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_sha256               CHAR(64) NOT NULL CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  checkpoint_digest            CHAR(64) NOT NULL CHECK (checkpoint_digest ~ '^[0-9a-f]{64}$'),
  event_count                  INTEGER NOT NULL CHECK (event_count > 0),
  first_sequence               BIGINT NOT NULL CHECK (first_sequence = 1),
  last_sequence                BIGINT NOT NULL CHECK (last_sequence >= first_sequence),
  last_event_hash              CHAR(64) NOT NULL CHECK (last_event_hash ~ '^[0-9a-f]{64}$'),
  retrieved_bytes              BIGINT NOT NULL CHECK (retrieved_bytes > 0),
  retrieved_at                 TIMESTAMPTZ NOT NULL,
  verified_at                  TIMESTAMPTZ NOT NULL,
  duration_ms                  INTEGER NOT NULL CHECK (duration_ms >= 0),
  verification_status          VARCHAR(24) NOT NULL CHECK (verification_status = 'verified'),
  verification_json            JSONB NOT NULL CHECK (jsonb_typeof(verification_json) = 'object'),
  requested_by_id              VARCHAR(256) NOT NULL,
  actor_sso_subject            VARCHAR(512) NOT NULL,
  mfa_verified_at              TIMESTAMPTZ NOT NULL,
  mfa_method                   VARCHAR(160) NOT NULL,
  justification_sha256         CHAR(64) NOT NULL CHECK (justification_sha256 ~ '^[0-9a-f]{64}$'),
  producer_event_id            VARCHAR(256) NOT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_key, tenant_key, environment, producer_event_id),
  CONSTRAINT mcp_retention_restore_scope_event_count CHECK (event_count = last_sequence - first_sequence + 1),
  CONSTRAINT mcp_retention_restore_verification_size CHECK (pg_column_size(verification_json) <= 262144)
);

CREATE INDEX IF NOT EXISTS idx_mcp_canonical_audit_retention_restore_drills_archive
  ON mcp_canonical_audit_retention_restore_drills (archive_id, verified_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_canonical_audit_retention_restore_drills_scope
  ON mcp_canonical_audit_retention_restore_drills (workspace_key, tenant_key, environment, verified_at DESC);

DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_restore_drills_no_update ON mcp_canonical_audit_retention_restore_drills;
DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_restore_drills_no_delete ON mcp_canonical_audit_retention_restore_drills;
DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_restore_drills_no_truncate ON mcp_canonical_audit_retention_restore_drills;
CREATE TRIGGER mcp_canonical_audit_retention_restore_drills_no_update
  BEFORE UPDATE ON mcp_canonical_audit_retention_restore_drills
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_retention_restore_drills_no_delete
  BEFORE DELETE ON mcp_canonical_audit_retention_restore_drills
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_retention_restore_drills_no_truncate
  BEFORE TRUNCATE ON mcp_canonical_audit_retention_restore_drills
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_canonical_audit_retention_restore_drills IS
  'Append-only successful full-download restore drills proving receipt, package, checkpoint and canonical event-chain verification.';
