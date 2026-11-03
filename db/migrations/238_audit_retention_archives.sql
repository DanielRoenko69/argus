-- Externally stored audit-retention archives and their provider-signed WORM receipts.
-- The archive record is append-only and binds the exact source chain segment.

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_retention_archives (
  archive_id                   UUID PRIMARY KEY,
  plan_id                      UUID NOT NULL UNIQUE REFERENCES mcp_canonical_audit_retention_plans(plan_id) ON DELETE RESTRICT,
  workspace_key                VARCHAR(128) NOT NULL,
  tenant_key                   VARCHAR(128) NOT NULL,
  environment                  VARCHAR(64) NOT NULL,
  checkpoint_id                UUID NOT NULL REFERENCES mcp_canonical_audit_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  checkpoint_digest            CHAR(64) NOT NULL CHECK (checkpoint_digest ~ '^[0-9a-f]{64}$'),
  manifest_sha256              CHAR(64) NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  package_sha256               CHAR(64) NOT NULL CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
  package_bytes                BIGINT NOT NULL CHECK (package_bytes > 0),
  event_count                  INTEGER NOT NULL CHECK (event_count > 0),
  first_sequence               BIGINT NOT NULL CHECK (first_sequence = 1),
  last_sequence                BIGINT NOT NULL CHECK (last_sequence >= first_sequence),
  first_previous_hash          TEXT NOT NULL CHECK (first_previous_hash = ''),
  last_event_hash              CHAR(64) NOT NULL CHECK (last_event_hash ~ '^[0-9a-f]{64}$'),
  provider                     VARCHAR(240) NOT NULL CHECK (length(btrim(provider)) > 0),
  reference                    VARCHAR(1000) NOT NULL CHECK (length(btrim(reference)) > 0),
  archived_at                  TIMESTAMPTZ NOT NULL,
  retention_until              TIMESTAMPTZ NOT NULL CHECK (retention_until > archived_at),
  statement_sha256             CHAR(64) NOT NULL CHECK (statement_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_sha256               CHAR(64) NOT NULL UNIQUE CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  verification_key_id          VARCHAR(240) NOT NULL,
  verification_key_fingerprint CHAR(64) NOT NULL CHECK (verification_key_fingerprint ~ '^[0-9a-f]{64}$'),
  package_summary_json         JSONB NOT NULL CHECK (jsonb_typeof(package_summary_json) = 'object'),
  receipt_json                 JSONB NOT NULL CHECK (jsonb_typeof(receipt_json) = 'object'),
  requested_by_id              VARCHAR(256) NOT NULL,
  actor_sso_subject            VARCHAR(512) NOT NULL,
  mfa_verified_at              TIMESTAMPTZ NOT NULL,
  mfa_method                   VARCHAR(160) NOT NULL,
  producer_event_id            VARCHAR(256) NOT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_key, tenant_key, environment, producer_event_id, provider),
  CONSTRAINT mcp_retention_archive_package_summary_size CHECK (pg_column_size(package_summary_json) <= 262144),
  CONSTRAINT mcp_retention_archive_receipt_size CHECK (pg_column_size(receipt_json) <= 262144),
  CONSTRAINT mcp_retention_archive_range_count CHECK (event_count = last_sequence - first_sequence + 1)
);

CREATE INDEX IF NOT EXISTS idx_mcp_canonical_audit_retention_archives_scope
  ON mcp_canonical_audit_retention_archives (workspace_key, tenant_key, environment, archived_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_canonical_audit_retention_archives_plan
  ON mcp_canonical_audit_retention_archives (plan_id, archived_at DESC);

ALTER TABLE mcp_canonical_audit_retention_plan_actions
  ADD COLUMN IF NOT EXISTS archive_id UUID REFERENCES mcp_canonical_audit_retention_archives(archive_id) ON DELETE RESTRICT;

ALTER TABLE mcp_canonical_audit_retention_plan_actions
  DROP CONSTRAINT IF EXISTS mcp_retention_action_anchor_shape;

ALTER TABLE mcp_canonical_audit_retention_plan_actions
  ADD CONSTRAINT mcp_retention_action_anchor_shape CHECK (
    (action = 'archive_verified' AND (
      (archive_id IS NOT NULL AND anchor_id IS NULL)
      OR (archive_id IS NULL AND anchor_id IS NOT NULL)
    ))
    OR (action <> 'archive_verified' AND archive_id IS NULL AND anchor_id IS NULL)
  );

DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_archives_no_update ON mcp_canonical_audit_retention_archives;
DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_archives_no_delete ON mcp_canonical_audit_retention_archives;
DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_archives_no_truncate ON mcp_canonical_audit_retention_archives;
CREATE TRIGGER mcp_canonical_audit_retention_archives_no_update
  BEFORE UPDATE ON mcp_canonical_audit_retention_archives
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_retention_archives_no_delete
  BEFORE DELETE ON mcp_canonical_audit_retention_archives
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_retention_archives_no_truncate
  BEFORE TRUNCATE ON mcp_canonical_audit_retention_archives
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_canonical_audit_retention_archives IS
  'Append-only provider-signed receipts for complete canonical audit-chain prefix packages stored in external WORM infrastructure.';
