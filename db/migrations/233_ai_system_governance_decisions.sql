-- Immutable, MFA-bound governance decisions for AI-system revisions,
-- classifications and production releases. Lifecycle changes never rewrite a
-- historical revision; every applied decision creates a new content-addressed
-- revision and an append-only decision record.

CREATE TABLE IF NOT EXISTS mcp_ai_system_governance_decisions (
  decision_id          UUID PRIMARY KEY,
  ai_system_id         UUID NOT NULL REFERENCES mcp_ai_systems(id) ON DELETE RESTRICT,
  action                VARCHAR(32) NOT NULL
    CHECK (action IN ('revision', 'classification', 'release')),
  source_revision       INTEGER NOT NULL CHECK (source_revision > 0),
  result_revision       INTEGER NOT NULL CHECK (result_revision > source_revision),
  actor_type            VARCHAR(32) NOT NULL CHECK (actor_type = 'user'),
  actor_id              VARCHAR(200) NOT NULL,
  actor_sso_subject     VARCHAR(512) NOT NULL,
  mfa_verified_at       TIMESTAMPTZ NOT NULL,
  mfa_method            VARCHAR(160) NOT NULL,
  decision_sha256       CHAR(64) NOT NULL CHECK (decision_sha256 ~ '^[0-9a-f]{64}$'),
  decision_json         JSONB NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_ai_system_governance_source_fk
    FOREIGN KEY (ai_system_id, source_revision)
    REFERENCES mcp_ai_system_revisions(ai_system_id, revision) ON DELETE RESTRICT,
  CONSTRAINT mcp_ai_system_governance_result_fk
    FOREIGN KEY (ai_system_id, result_revision)
    REFERENCES mcp_ai_system_revisions(ai_system_id, revision) ON DELETE RESTRICT,
  CONSTRAINT mcp_ai_system_governance_actor_nonempty CHECK (
    length(btrim(actor_id)) > 0 AND length(btrim(actor_sso_subject)) > 0
  ),
  CONSTRAINT mcp_ai_system_governance_mfa_nonempty CHECK (length(btrim(mfa_method)) > 0),
  CONSTRAINT mcp_ai_system_governance_json_object CHECK (jsonb_typeof(decision_json) = 'object'),
  CONSTRAINT mcp_ai_system_governance_json_size CHECK (pg_column_size(decision_json) <= 262144),
  UNIQUE (ai_system_id, result_revision),
  UNIQUE (ai_system_id, decision_sha256)
);

CREATE INDEX IF NOT EXISTS idx_mcp_ai_system_governance_history
  ON mcp_ai_system_governance_decisions (ai_system_id, result_revision DESC);

DROP TRIGGER IF EXISTS mcp_ai_system_governance_no_update ON mcp_ai_system_governance_decisions;
DROP TRIGGER IF EXISTS mcp_ai_system_governance_no_delete ON mcp_ai_system_governance_decisions;
DROP TRIGGER IF EXISTS mcp_ai_system_governance_no_truncate ON mcp_ai_system_governance_decisions;
CREATE TRIGGER mcp_ai_system_governance_no_update
  BEFORE UPDATE ON mcp_ai_system_governance_decisions
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_governance_no_delete
  BEFORE DELETE ON mcp_ai_system_governance_decisions
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_governance_no_truncate
  BEFORE TRUNCATE ON mcp_ai_system_governance_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_ai_system_governance_decisions IS
  'Append-only SSO/MFA assurance and separation-of-duties evidence for AI-system lifecycle decisions.';
