-- Native alerts may dispatch through an immutable AIOps Service Profile revision.
-- Legacy rule-owned execution context remains supported during migration.

ALTER TABLE mcp_observability_incident_aiops_dispatches
  ALTER COLUMN resource_scope DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS service_profile_id BIGINT,
  ADD COLUMN IF NOT EXISTS service_profile_revision INTEGER,
  ADD COLUMN IF NOT EXISTS service_profile_sha256 TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mcp_observability_incident_aiops_dispatches_profile_complete'
  ) THEN
    ALTER TABLE mcp_observability_incident_aiops_dispatches
      ADD CONSTRAINT mcp_observability_incident_aiops_dispatches_profile_complete
      CHECK (
        (service_profile_id IS NULL AND service_profile_revision IS NULL AND service_profile_sha256 IS NULL)
        OR
        (service_profile_id IS NOT NULL AND service_profile_revision IS NOT NULL AND service_profile_sha256 IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mcp_observability_incident_aiops_dispatches_profile_sha256'
  ) THEN
    ALTER TABLE mcp_observability_incident_aiops_dispatches
      ADD CONSTRAINT mcp_observability_incident_aiops_dispatches_profile_sha256
      CHECK (service_profile_sha256 IS NULL OR service_profile_sha256 ~ '^[a-f0-9]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mcp_observability_incident_aiops_dispatches_profile_revision_fk'
  ) THEN
    ALTER TABLE mcp_observability_incident_aiops_dispatches
      ADD CONSTRAINT mcp_observability_incident_aiops_dispatches_profile_revision_fk
      FOREIGN KEY (service_profile_id, service_profile_revision)
      REFERENCES mcp_observability_aiops_service_profile_revisions(profile_id, revision)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mcp_observability_incident_aiops_dispatches_profile
  ON mcp_observability_incident_aiops_dispatches(service_profile_id, created_at DESC)
  WHERE service_profile_id IS NOT NULL;
