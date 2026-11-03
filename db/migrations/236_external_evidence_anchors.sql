-- Detached, provider-signed receipts proving that an immutable Evidence Pack
-- was written to an external WORM/timestamp/transparency trust boundary.

CREATE TABLE IF NOT EXISTS mcp_external_evidence_anchors (
  anchor_id                    UUID PRIMARY KEY,
  report_run_id                UUID NOT NULL REFERENCES mcp_audit_report_runs(id) ON DELETE RESTRICT,
  workspace_key                VARCHAR(128) NOT NULL CHECK (length(btrim(workspace_key)) > 0),
  tenant_key                   VARCHAR(128) NOT NULL CHECK (length(btrim(tenant_key)) > 0),
  environment                  VARCHAR(64) NOT NULL CHECK (length(btrim(environment)) > 0),
  pack_id                      UUID NOT NULL,
  pack_sha256                  CHAR(64) NOT NULL CHECK (pack_sha256 ~ '^[0-9a-f]{64}$'),
  anchor_kind                  VARCHAR(32) NOT NULL CHECK (anchor_kind IN ('worm_object','qualified_timestamp','transparency_log')),
  provider                     VARCHAR(240) NOT NULL CHECK (length(btrim(provider)) > 0),
  reference                    VARCHAR(1000) NOT NULL CHECK (length(btrim(reference)) > 0),
  anchored_at                  TIMESTAMPTZ NOT NULL,
  retention_until              TIMESTAMPTZ,
  statement_sha256             CHAR(64) NOT NULL CHECK (statement_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_sha256               CHAR(64) NOT NULL UNIQUE CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  verification_key_id          VARCHAR(240) NOT NULL,
  verification_key_fingerprint CHAR(64) NOT NULL CHECK (verification_key_fingerprint ~ '^[0-9a-f]{64}$'),
  receipt_json                 JSONB NOT NULL,
  requested_by_id              VARCHAR(200) NOT NULL,
  actor_sso_subject            VARCHAR(512) NOT NULL,
  mfa_verified_at              TIMESTAMPTZ NOT NULL,
  mfa_method                   VARCHAR(160) NOT NULL,
  producer_event_id            VARCHAR(256) NOT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_external_anchor_receipt_object CHECK (jsonb_typeof(receipt_json) = 'object'),
  CONSTRAINT mcp_external_anchor_receipt_size CHECK (pg_column_size(receipt_json) <= 262144),
  CONSTRAINT mcp_external_anchor_worm_retention CHECK (anchor_kind <> 'worm_object' OR retention_until > anchored_at),
  UNIQUE (report_run_id, anchor_kind, provider, reference),
  UNIQUE (workspace_key, tenant_key, environment, producer_event_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_mcp_external_evidence_anchors_report
  ON mcp_external_evidence_anchors (report_run_id, anchored_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_external_evidence_anchors_scope
  ON mcp_external_evidence_anchors (workspace_key, tenant_key, environment, anchored_at DESC);

DROP TRIGGER IF EXISTS mcp_external_evidence_anchors_no_update ON mcp_external_evidence_anchors;
DROP TRIGGER IF EXISTS mcp_external_evidence_anchors_no_delete ON mcp_external_evidence_anchors;
DROP TRIGGER IF EXISTS mcp_external_evidence_anchors_no_truncate ON mcp_external_evidence_anchors;
CREATE TRIGGER mcp_external_evidence_anchors_no_update
  BEFORE UPDATE ON mcp_external_evidence_anchors
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_external_evidence_anchors_no_delete
  BEFORE DELETE ON mcp_external_evidence_anchors
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_external_evidence_anchors_no_truncate
  BEFORE TRUNCATE ON mcp_external_evidence_anchors
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_external_evidence_anchors IS
  'Append-only signed receipts for externally anchored audit Evidence Packs; detached from the immutable source artifact to avoid circular digests.';
