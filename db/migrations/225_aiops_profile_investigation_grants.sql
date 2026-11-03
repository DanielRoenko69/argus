ALTER TABLE argus_execution_grants
  ADD COLUMN IF NOT EXISTS tool_names TEXT[],
  ADD COLUMN IF NOT EXISTS aiops_service_profile_id BIGINT,
  ADD COLUMN IF NOT EXISTS aiops_service_profile_revision INTEGER,
  ADD COLUMN IF NOT EXISTS aiops_service_profile_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS aiops_resolved_context_sha256 CHAR(64);

ALTER TABLE argus_execution_grants
  DROP CONSTRAINT IF EXISTS argus_execution_grants_aiops_profile_complete,
  DROP CONSTRAINT IF EXISTS argus_execution_grants_aiops_profile_revision_fk;

ALTER TABLE argus_execution_grants
  ADD CONSTRAINT argus_execution_grants_aiops_profile_revision_fk
    FOREIGN KEY (aiops_service_profile_id, aiops_service_profile_revision)
    REFERENCES mcp_observability_aiops_service_profile_revisions(profile_id, revision)
    ON DELETE RESTRICT,
  ADD CONSTRAINT argus_execution_grants_aiops_profile_complete CHECK (
    (aiops_service_profile_id IS NULL
      AND aiops_service_profile_revision IS NULL
      AND aiops_service_profile_sha256 IS NULL
      AND aiops_resolved_context_sha256 IS NULL)
    OR
    (pack_id = 'argus.aiops'
      AND aiops_service_profile_id IS NOT NULL
      AND aiops_service_profile_revision > 0
      AND aiops_service_profile_sha256 ~ '^[a-f0-9]{64}$'
      AND aiops_resolved_context_sha256 ~ '^[a-f0-9]{64}$'
      AND tool_names IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_argus_execution_grants_aiops_profile
  ON argus_execution_grants (aiops_service_profile_id, aiops_service_profile_revision, issued_at DESC)
  WHERE aiops_service_profile_id IS NOT NULL;

COMMENT ON COLUMN argus_execution_grants.tool_names IS
  'Optional exact task-level tool subset, always narrower than the selected MCP Bundle policies.';
COMMENT ON COLUMN argus_execution_grants.aiops_service_profile_id IS
  'Immutable active AIOps service profile selected by Core when the investigation started.';
COMMENT ON COLUMN argus_execution_grants.aiops_service_profile_sha256 IS
  'Content hash of the selected profile revision.';
COMMENT ON COLUMN argus_execution_grants.aiops_resolved_context_sha256 IS
  'Content hash of the complete server-resolved service context sent to Argus AIOps.';
