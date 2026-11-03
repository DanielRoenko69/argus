-- Immutable, offline-verifiable AI compliance dossiers. Every dossier freezes
-- the exact released AI-system revision, the signed source evidence pack and
-- the bytes of all exported artifacts used to calculate the manifest digest.

CREATE TABLE IF NOT EXISTS mcp_ai_compliance_dossiers (
  dossier_id               UUID PRIMARY KEY,
  ai_system_id             UUID NOT NULL REFERENCES mcp_ai_systems(id) ON DELETE RESTRICT,
  ai_system_revision       INTEGER NOT NULL CHECK (ai_system_revision > 0),
  ai_system_revision_id    UUID NOT NULL,
  workspace_key            VARCHAR(128) NOT NULL,
  tenant_key               VARCHAR(128) NOT NULL,
  environment              VARCHAR(64) NOT NULL,
  source_report_run_id     UUID NOT NULL REFERENCES mcp_audit_report_runs(id) ON DELETE RESTRICT,
  source_pack_id           UUID NOT NULL,
  source_pack_digest       CHAR(64) NOT NULL CHECK (source_pack_digest ~ '^[0-9a-f]{64}$'),
  manifest_json            JSONB NOT NULL,
  dossier_sha256           CHAR(64) NOT NULL CHECK (dossier_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_json_artifact   BYTEA NOT NULL CHECK (octet_length(evidence_json_artifact) > 0),
  pdf_artifact             BYTEA NOT NULL CHECK (octet_length(pdf_artifact) > 0),
  checkpoint_signature     BYTEA NOT NULL CHECK (octet_length(checkpoint_signature) > 0),
  generated_by_actor_type  VARCHAR(32) NOT NULL CHECK (generated_by_actor_type IN ('user','service','system','external_reviewer')),
  generated_by_actor_id    VARCHAR(200) NOT NULL,
  generated_at             TIMESTAMPTZ NOT NULL,
  CONSTRAINT mcp_ai_compliance_dossier_revision_fk
    FOREIGN KEY (ai_system_id, ai_system_revision)
    REFERENCES mcp_ai_system_revisions(ai_system_id, revision) ON DELETE RESTRICT,
  CONSTRAINT mcp_ai_compliance_dossier_manifest_identity CHECK (
    manifest_json->>'dossierId' = dossier_id::text
    AND manifest_json->>'dossierSha256' = dossier_sha256
    AND manifest_json->'aiSystem'->>'aiSystemId' = ai_system_id::text
    AND (manifest_json->'aiSystem'->>'revision')::integer = ai_system_revision
    AND manifest_json->'aiSystem'->>'revisionId' = ai_system_revision_id::text
    AND manifest_json->'sourceEvidencePack'->>'evidencePackId' = source_pack_id::text
    AND manifest_json->'sourceEvidencePack'->>'sha256' = source_pack_digest
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_compliance_dossier_source
  ON mcp_ai_compliance_dossiers
    (workspace_key, tenant_key, environment, ai_system_id, ai_system_revision, source_pack_digest);
CREATE INDEX IF NOT EXISTS idx_ai_compliance_dossier_system
  ON mcp_ai_compliance_dossiers
    (workspace_key, tenant_key, ai_system_id, generated_at DESC, dossier_id);

DROP TRIGGER IF EXISTS mcp_ai_compliance_dossiers_no_update ON mcp_ai_compliance_dossiers;
DROP TRIGGER IF EXISTS mcp_ai_compliance_dossiers_no_delete ON mcp_ai_compliance_dossiers;
DROP TRIGGER IF EXISTS mcp_ai_compliance_dossiers_no_truncate ON mcp_ai_compliance_dossiers;
CREATE TRIGGER mcp_ai_compliance_dossiers_no_update
  BEFORE UPDATE ON mcp_ai_compliance_dossiers
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_compliance_dossiers_no_delete
  BEFORE DELETE ON mcp_ai_compliance_dossiers
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_compliance_dossiers_no_truncate
  BEFORE TRUNCATE ON mcp_ai_compliance_dossiers
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_ai_compliance_dossiers IS
  'Append-only AI compliance dossiers pinned to one released revision and one verified signed evidence pack; exports remain evidence support, not automatic conformity declarations.';
