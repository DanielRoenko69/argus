-- Immutable, tenant-bound proof that both product Golden Paths were executed
-- successfully. These records are operational execution evidence; they are
-- deliberately not named or presented as an external/legal certification.

CREATE TABLE IF NOT EXISTS mcp_platform_execution_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_key TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  environment TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT 'pilot-demo',
  source_schema TEXT NOT NULL,
  source_mode TEXT NOT NULL CHECK (source_mode IN ('execute', 'verify-only')),
  generated_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Deliberately a snapshot identifier, not an FK: actor deletion must not
  -- mutate or block deletion because this evidence table is append-only.
  recorded_by_user_id BIGINT,
  recorded_by_username TEXT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  passed BOOLEAN NOT NULL CHECK (passed = true),
  dev_passed BOOLEAN NOT NULL CHECK (dev_passed = true),
  aiops_passed BOOLEAN NOT NULL CHECK (aiops_passed = true),
  dev_task_id UUID NOT NULL,
  dev_root_trace_id UUID NOT NULL,
  aiops_task_id UUID NOT NULL,
  aiops_root_trace_id UUID NOT NULL,
  evidence JSONB NOT NULL,
  CONSTRAINT mcp_platform_execution_certificates_scope_digest_unique
    UNIQUE (workspace_key, tenant_key, environment, profile_id, payload_sha256)
);

CREATE INDEX IF NOT EXISTS idx_platform_execution_certificates_scope_recorded
  ON mcp_platform_execution_certificates
  (workspace_key, tenant_key, environment, profile_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION mcp_platform_execution_certificate_block_modify()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'mcp_platform_execution_certificates is append-only (% blocked); import a new proof instead',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mcp_platform_execution_certificate_no_update ON mcp_platform_execution_certificates;
DROP TRIGGER IF EXISTS mcp_platform_execution_certificate_no_delete ON mcp_platform_execution_certificates;
DROP TRIGGER IF EXISTS mcp_platform_execution_certificate_no_truncate ON mcp_platform_execution_certificates;

CREATE TRIGGER mcp_platform_execution_certificate_no_update
  BEFORE UPDATE ON mcp_platform_execution_certificates
  FOR EACH ROW EXECUTE FUNCTION mcp_platform_execution_certificate_block_modify();

CREATE TRIGGER mcp_platform_execution_certificate_no_delete
  BEFORE DELETE ON mcp_platform_execution_certificates
  FOR EACH ROW EXECUTE FUNCTION mcp_platform_execution_certificate_block_modify();

CREATE TRIGGER mcp_platform_execution_certificate_no_truncate
  BEFORE TRUNCATE ON mcp_platform_execution_certificates
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_platform_execution_certificate_block_modify();

COMMENT ON TABLE mcp_platform_execution_certificates IS
  'Append-only operational Golden Path proofs. Not an external compliance or product certification.';
