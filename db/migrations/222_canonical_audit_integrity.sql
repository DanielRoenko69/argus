-- Signed integrity checkpoints for the canonical business-audit chain.
--
-- Private signing keys are deliberately not represented in this schema. Core
-- only persists immutable public verification material and append-only signed
-- chain heads so historical evidence survives signing-key rotation.

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_signing_keys (
  key_id                  VARCHAR(256) PRIMARY KEY,
  algorithm               VARCHAR(32) NOT NULL CHECK (algorithm = 'Ed25519'),
  public_key_pem          TEXT NOT NULL CHECK (length(public_key_pem) BETWEEN 64 AND 8192),
  public_key_fingerprint  CHAR(64) NOT NULL UNIQUE
    CHECK (public_key_fingerprint ~ '^[0-9a-f]{64}$'),
  registered_at           TIMESTAMPTZ NOT NULL,
  source                  VARCHAR(64) NOT NULL DEFAULT 'external-secret'
    CHECK (source IN ('external-secret', 'kms', 'hsm'))
);

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_checkpoints (
  checkpoint_id              UUID PRIMARY KEY,
  schema_version             SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  workspace_key              VARCHAR(128) NOT NULL,
  tenant_key                 VARCHAR(128) NOT NULL,
  environment                VARCHAR(64) NOT NULL,
  last_sequence              BIGINT NOT NULL CHECK (last_sequence > 0),
  last_event_id              UUID NOT NULL REFERENCES mcp_canonical_audit_events(event_id) ON DELETE RESTRICT,
  last_event_hash            CHAR(64) NOT NULL CHECK (last_event_hash ~ '^[0-9a-f]{64}$'),
  previous_checkpoint_id     UUID REFERENCES mcp_canonical_audit_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  previous_checkpoint_digest TEXT NOT NULL CHECK (length(previous_checkpoint_digest) IN (0, 64)),
  created_at                 TIMESTAMPTZ NOT NULL,
  algorithm                  VARCHAR(32) NOT NULL CHECK (algorithm = 'Ed25519'),
  key_id                     VARCHAR(256) NOT NULL REFERENCES mcp_canonical_audit_signing_keys(key_id) ON DELETE RESTRICT,
  public_key_fingerprint     CHAR(64) NOT NULL CHECK (public_key_fingerprint ~ '^[0-9a-f]{64}$'),
  checkpoint_digest          CHAR(64) NOT NULL UNIQUE CHECK (checkpoint_digest ~ '^[0-9a-f]{64}$'),
  signature                  TEXT NOT NULL CHECK (length(signature) BETWEEN 32 AND 4096),
  UNIQUE (workspace_key, tenant_key, environment, last_sequence),
  CHECK ((previous_checkpoint_id IS NULL) = (previous_checkpoint_digest = ''))
);

CREATE INDEX IF NOT EXISTS idx_canonical_audit_checkpoints_scope
  ON mcp_canonical_audit_checkpoints
    (workspace_key, tenant_key, environment, last_sequence DESC);

CREATE OR REPLACE FUNCTION mcp_canonical_audit_integrity_block_modify()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mcp_canonical_audit_signing_keys_no_update ON mcp_canonical_audit_signing_keys;
DROP TRIGGER IF EXISTS mcp_canonical_audit_signing_keys_no_delete ON mcp_canonical_audit_signing_keys;
DROP TRIGGER IF EXISTS mcp_canonical_audit_signing_keys_no_truncate ON mcp_canonical_audit_signing_keys;
CREATE TRIGGER mcp_canonical_audit_signing_keys_no_update
  BEFORE UPDATE ON mcp_canonical_audit_signing_keys
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_signing_keys_no_delete
  BEFORE DELETE ON mcp_canonical_audit_signing_keys
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_signing_keys_no_truncate
  BEFORE TRUNCATE ON mcp_canonical_audit_signing_keys
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

DROP TRIGGER IF EXISTS mcp_canonical_audit_checkpoints_no_update ON mcp_canonical_audit_checkpoints;
DROP TRIGGER IF EXISTS mcp_canonical_audit_checkpoints_no_delete ON mcp_canonical_audit_checkpoints;
DROP TRIGGER IF EXISTS mcp_canonical_audit_checkpoints_no_truncate ON mcp_canonical_audit_checkpoints;
CREATE TRIGGER mcp_canonical_audit_checkpoints_no_update
  BEFORE UPDATE ON mcp_canonical_audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_checkpoints_no_delete
  BEFORE DELETE ON mcp_canonical_audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_checkpoints_no_truncate
  BEFORE TRUNCATE ON mcp_canonical_audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_canonical_audit_signing_keys IS
  'Immutable public Ed25519 verification keys. Private key material must remain in external secret management.';
COMMENT ON TABLE mcp_canonical_audit_checkpoints IS
  'Append-only signatures over scoped canonical audit chain heads, linked across signing-key rotations.';
