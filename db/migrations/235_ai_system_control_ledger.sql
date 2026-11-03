-- Append-only AI Act control assessments bound to one immutable AI-system
-- revision and one server-owned control-catalog version.

CREATE TABLE IF NOT EXISTS mcp_ai_system_control_assessments (
  assessment_id          UUID PRIMARY KEY,
  ai_system_id           UUID NOT NULL,
  revision               INTEGER NOT NULL CHECK (revision > 0),
  control_id             VARCHAR(100) NOT NULL CHECK (control_id ~ '^AIA-[A-Z0-9-]+$'),
  sequence               INTEGER NOT NULL CHECK (sequence > 0),
  catalog_id             VARCHAR(160) NOT NULL,
  catalog_version        INTEGER NOT NULL CHECK (catalog_version > 0),
  catalog_sha256         CHAR(64) NOT NULL CHECK (catalog_sha256 ~ '^[0-9a-f]{64}$'),
  status                 VARCHAR(32) NOT NULL CHECK (status IN (
    'not_assessed', 'in_progress', 'satisfied', 'exception', 'not_applicable'
  )),
  owner_party            VARCHAR(32) NOT NULL CHECK (owner_party IN (
    'argus_platform', 'provider', 'deployer', 'external_assessor'
  )),
  owner_id               VARCHAR(200) NOT NULL CHECK (length(btrim(owner_id)) > 0),
  due_at                 TIMESTAMPTZ,
  reassessment_at        TIMESTAMPTZ,
  evidence_json          JSONB NOT NULL DEFAULT '[]'::jsonb,
  exception_json         JSONB,
  assessment_sha256      CHAR(64) NOT NULL CHECK (assessment_sha256 ~ '^[0-9a-f]{64}$'),
  assessment_json        JSONB NOT NULL,
  assessed_by_id         VARCHAR(200) NOT NULL CHECK (length(btrim(assessed_by_id)) > 0),
  actor_sso_subject      VARCHAR(512) NOT NULL CHECK (length(btrim(actor_sso_subject)) > 0),
  mfa_verified_at        TIMESTAMPTZ NOT NULL,
  mfa_method             VARCHAR(160) NOT NULL CHECK (length(btrim(mfa_method)) > 0),
  producer_event_id      VARCHAR(256) NOT NULL CHECK (length(btrim(producer_event_id)) > 0),
  created_at             TIMESTAMPTZ NOT NULL,
  CONSTRAINT mcp_ai_system_control_revision_fk
    FOREIGN KEY (ai_system_id, revision)
    REFERENCES mcp_ai_system_revisions(ai_system_id, revision) ON DELETE RESTRICT,
  CONSTRAINT mcp_ai_system_control_evidence_array CHECK (jsonb_typeof(evidence_json) = 'array'),
  CONSTRAINT mcp_ai_system_control_exception_object CHECK (
    exception_json IS NULL OR jsonb_typeof(exception_json) = 'object'
  ),
  CONSTRAINT mcp_ai_system_control_assessment_object CHECK (jsonb_typeof(assessment_json) = 'object'),
  CONSTRAINT mcp_ai_system_control_assessment_size CHECK (pg_column_size(assessment_json) <= 524288),
  CONSTRAINT mcp_ai_system_control_exception_shape CHECK (
    (status = 'exception' AND exception_json IS NOT NULL)
    OR (status <> 'exception' AND exception_json IS NULL)
  ),
  UNIQUE (ai_system_id, revision, control_id, sequence),
  UNIQUE (ai_system_id, revision, assessment_sha256),
  UNIQUE (ai_system_id, revision, producer_event_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_ai_system_control_latest
  ON mcp_ai_system_control_assessments
    (ai_system_id, revision, control_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_ai_system_control_due
  ON mcp_ai_system_control_assessments (due_at, reassessment_at)
  WHERE due_at IS NOT NULL OR reassessment_at IS NOT NULL;

DROP TRIGGER IF EXISTS mcp_ai_system_control_no_update ON mcp_ai_system_control_assessments;
DROP TRIGGER IF EXISTS mcp_ai_system_control_no_delete ON mcp_ai_system_control_assessments;
DROP TRIGGER IF EXISTS mcp_ai_system_control_no_truncate ON mcp_ai_system_control_assessments;
CREATE TRIGGER mcp_ai_system_control_no_update
  BEFORE UPDATE ON mcp_ai_system_control_assessments
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_control_no_delete
  BEFORE DELETE ON mcp_ai_system_control_assessments
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_control_no_truncate
  BEFORE TRUNCATE ON mcp_ai_system_control_assessments
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_ai_system_control_assessments IS
  'Append-only, SSO/MFA-bound implementation, evidence, exception and reassessment decisions for one legal control and immutable AI-system revision.';
