-- Immutable AI-system binding for governed production workflow root runs.
-- Existing workflows stay ungoverned until an operator explicitly binds an
-- immutable AI-system revision. This keeps local/sandbox execution compatible
-- while making the opted-in production boundary fail closed.

ALTER TABLE mcp_workflows
  ADD COLUMN IF NOT EXISTS ai_act_governed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_system_id UUID,
  ADD COLUMN IF NOT EXISTS ai_system_revision INTEGER;

ALTER TABLE mcp_workflows
  DROP CONSTRAINT IF EXISTS mcp_workflows_ai_act_binding_complete,
  ADD CONSTRAINT mcp_workflows_ai_act_binding_complete CHECK (
    (ai_act_governed = false AND ai_system_id IS NULL AND ai_system_revision IS NULL)
    OR
    (ai_act_governed = true AND ai_system_id IS NOT NULL AND ai_system_revision IS NOT NULL)
  );

ALTER TABLE mcp_workflows
  DROP CONSTRAINT IF EXISTS mcp_workflows_ai_system_revision_fk,
  ADD CONSTRAINT mcp_workflows_ai_system_revision_fk
    FOREIGN KEY (ai_system_id, ai_system_revision)
    REFERENCES mcp_ai_system_revisions(ai_system_id, revision)
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_mcp_workflows_ai_system
  ON mcp_workflows (ai_system_id, ai_system_revision)
  WHERE ai_act_governed = true;

CREATE TABLE IF NOT EXISTS mcp_ai_system_run_bindings (
  binding_id              UUID PRIMARY KEY,
  workflow_execution_id   BIGINT NOT NULL UNIQUE
    REFERENCES mcp_workflow_executions(id) ON DELETE RESTRICT,
  ai_system_id            UUID NOT NULL,
  ai_system_revision      INTEGER NOT NULL,
  ai_system_revision_id   UUID NOT NULL,
  production              BOOLEAN NOT NULL,
  execution_authorized    BOOLEAN NOT NULL,
  environment             VARCHAR(120) NOT NULL,
  binding_sha256          CHAR(64) NOT NULL CHECK (binding_sha256 ~ '^[0-9a-f]{64}$'),
  binding_json            JSONB NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_ai_system_run_binding_revision_fk
    FOREIGN KEY (ai_system_id, ai_system_revision)
    REFERENCES mcp_ai_system_revisions(ai_system_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT mcp_ai_system_run_binding_revision_id_fk
    FOREIGN KEY (ai_system_revision_id)
    REFERENCES mcp_ai_system_revisions(revision_id)
    ON DELETE RESTRICT,
  CONSTRAINT mcp_ai_system_run_binding_json_object
    CHECK (jsonb_typeof(binding_json) = 'object'),
  CONSTRAINT mcp_ai_system_run_binding_json_size
    CHECK (pg_column_size(binding_json) <= 1048576),
  CONSTRAINT mcp_ai_system_run_binding_environment_nonempty
    CHECK (length(btrim(environment)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_mcp_ai_system_run_bindings_system
  ON mcp_ai_system_run_bindings (ai_system_id, ai_system_revision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_ai_system_run_bindings_blocked
  ON mcp_ai_system_run_bindings (created_at DESC)
  WHERE production = true AND execution_authorized = false;

DROP TRIGGER IF EXISTS mcp_ai_system_run_bindings_no_update ON mcp_ai_system_run_bindings;
DROP TRIGGER IF EXISTS mcp_ai_system_run_bindings_no_delete ON mcp_ai_system_run_bindings;
DROP TRIGGER IF EXISTS mcp_ai_system_run_bindings_no_truncate ON mcp_ai_system_run_bindings;
CREATE TRIGGER mcp_ai_system_run_bindings_no_update
  BEFORE UPDATE ON mcp_ai_system_run_bindings
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_run_bindings_no_delete
  BEFORE DELETE ON mcp_ai_system_run_bindings
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_run_bindings_no_truncate
  BEFORE TRUNCATE ON mcp_ai_system_run_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON COLUMN mcp_workflows.ai_act_governed IS
  'Opt-in production boundary. Governed root runs must pass the AI-system release gate before side effects execute.';
COMMENT ON TABLE mcp_ai_system_run_bindings IS
  'Immutable fail-closed release-gate decisions binding a workflow root run to an exact AI-system revision.';
