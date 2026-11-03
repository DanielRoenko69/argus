-- Immutable canonical-audit chain segment seals.
--
-- A seal proves that a complete chain range has a verified WORM copy and a
-- successful full-download restore drill. It records the cryptographic value
-- from which the next segment must continue. It deliberately grants no purge.

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_chain_segments (
  segment_id                    UUID PRIMARY KEY,
  segment_ordinal               INTEGER NOT NULL CHECK (segment_ordinal > 0),
  previous_segment_id           UUID REFERENCES mcp_canonical_audit_chain_segments(segment_id) ON DELETE RESTRICT,
  previous_segment_digest       TEXT NOT NULL CHECK (length(previous_segment_digest) IN (0, 64)),
  workspace_key                 VARCHAR(128) NOT NULL,
  tenant_key                    VARCHAR(128) NOT NULL,
  environment                   VARCHAR(64) NOT NULL,
  archive_id                    UUID NOT NULL UNIQUE REFERENCES mcp_canonical_audit_retention_archives(archive_id) ON DELETE RESTRICT,
  restore_drill_id              UUID NOT NULL REFERENCES mcp_canonical_audit_retention_restore_drills(drill_id) ON DELETE RESTRICT,
  first_sequence                BIGINT NOT NULL CHECK (first_sequence > 0),
  last_sequence                 BIGINT NOT NULL CHECK (last_sequence >= first_sequence),
  event_count                   INTEGER NOT NULL CHECK (event_count > 0),
  first_previous_hash           TEXT NOT NULL CHECK (length(first_previous_hash) IN (0, 64)),
  last_event_hash               CHAR(64) NOT NULL CHECK (last_event_hash ~ '^[0-9a-f]{64}$'),
  continuation_sequence         BIGINT NOT NULL CHECK (continuation_sequence = last_sequence + 1),
  continuation_previous_hash    CHAR(64) NOT NULL CHECK (continuation_previous_hash = last_event_hash),
  checkpoint_id                 UUID NOT NULL REFERENCES mcp_canonical_audit_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  checkpoint_digest             CHAR(64) NOT NULL CHECK (checkpoint_digest ~ '^[0-9a-f]{64}$'),
  archive_package_sha256        CHAR(64) NOT NULL CHECK (archive_package_sha256 ~ '^[0-9a-f]{64}$'),
  archive_receipt_sha256        CHAR(64) NOT NULL CHECK (archive_receipt_sha256 ~ '^[0-9a-f]{64}$'),
  segment_digest                CHAR(64) NOT NULL UNIQUE CHECK (segment_digest ~ '^[0-9a-f]{64}$'),
  verification_json             JSONB NOT NULL CHECK (jsonb_typeof(verification_json) = 'object'),
  sealed_at                     TIMESTAMPTZ NOT NULL,
  requested_by_id               VARCHAR(256) NOT NULL,
  actor_sso_subject             VARCHAR(512) NOT NULL,
  mfa_verified_at               TIMESTAMPTZ NOT NULL,
  mfa_method                    VARCHAR(160) NOT NULL,
  justification_sha256          CHAR(64) NOT NULL CHECK (justification_sha256 ~ '^[0-9a-f]{64}$'),
  producer_event_id             VARCHAR(256) NOT NULL,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_key, tenant_key, environment, segment_ordinal),
  UNIQUE (workspace_key, tenant_key, environment, first_sequence, last_sequence),
  UNIQUE (workspace_key, tenant_key, environment, producer_event_id),
  CONSTRAINT mcp_canonical_audit_segment_range_count CHECK (event_count = last_sequence - first_sequence + 1),
  CONSTRAINT mcp_canonical_audit_segment_predecessor_shape CHECK (
    (segment_ordinal = 1 AND previous_segment_id IS NULL AND previous_segment_digest = '' AND first_sequence = 1 AND first_previous_hash = '')
    OR
    (segment_ordinal > 1 AND previous_segment_id IS NOT NULL AND length(previous_segment_digest) = 64 AND first_sequence > 1 AND length(first_previous_hash) = 64)
  ),
  CONSTRAINT mcp_canonical_audit_segment_verification_size CHECK (pg_column_size(verification_json) <= 262144)
);

CREATE INDEX IF NOT EXISTS idx_mcp_canonical_audit_chain_segments_scope
  ON mcp_canonical_audit_chain_segments
    (workspace_key, tenant_key, environment, segment_ordinal DESC);

DROP TRIGGER IF EXISTS mcp_canonical_audit_chain_segments_no_update ON mcp_canonical_audit_chain_segments;
DROP TRIGGER IF EXISTS mcp_canonical_audit_chain_segments_no_delete ON mcp_canonical_audit_chain_segments;
DROP TRIGGER IF EXISTS mcp_canonical_audit_chain_segments_no_truncate ON mcp_canonical_audit_chain_segments;
CREATE TRIGGER mcp_canonical_audit_chain_segments_no_update
  BEFORE UPDATE ON mcp_canonical_audit_chain_segments
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_chain_segments_no_delete
  BEFORE DELETE ON mcp_canonical_audit_chain_segments
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_chain_segments_no_truncate
  BEFORE TRUNCATE ON mcp_canonical_audit_chain_segments
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_canonical_audit_chain_segments IS
  'Append-only chain segment seals bound to a verified WORM archive and successful restore drill. continuation_previous_hash anchors future segments; no row authorizes physical purge.';
