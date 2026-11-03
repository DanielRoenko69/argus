-- Service-specific AIOps profiles. Profile definitions are immutable,
-- content-addressed revisions; the mutable profile row only owns lifecycle
-- state and the explicit pointer to the active revision.

CREATE TABLE IF NOT EXISTS mcp_observability_aiops_service_profiles (
  id                    BIGSERIAL PRIMARY KEY,
  workspace_key         VARCHAR(128) NOT NULL DEFAULT 'default',
  tenant_key            VARCHAR(128) NOT NULL DEFAULT 'default',
  service_name          VARCHAR(160) NOT NULL,
  environment           VARCHAR(120) NOT NULL,
  display_name          VARCHAR(160) NOT NULL,
  description           VARCHAR(2000) NOT NULL DEFAULT '',
  status                VARCHAR(16) NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  active_revision       INTEGER,
  created_by_user_id    INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_aiops_profile_workspace_nonempty CHECK (length(btrim(workspace_key)) > 0),
  CONSTRAINT mcp_aiops_profile_tenant_nonempty CHECK (length(btrim(tenant_key)) > 0),
  CONSTRAINT mcp_aiops_profile_service_nonempty CHECK (length(btrim(service_name)) > 0),
  CONSTRAINT mcp_aiops_profile_environment_nonempty CHECK (length(btrim(environment)) > 0),
  CONSTRAINT mcp_aiops_profile_display_name_nonempty CHECK (length(btrim(display_name)) > 0),
  UNIQUE (id, workspace_key, tenant_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_aiops_profile_service_environment
  ON mcp_observability_aiops_service_profiles
    (workspace_key, tenant_key, lower(service_name), lower(environment));

CREATE TABLE IF NOT EXISTS mcp_observability_aiops_service_profile_revisions (
  profile_id            BIGINT NOT NULL REFERENCES mcp_observability_aiops_service_profiles(id) ON DELETE RESTRICT,
  revision              INTEGER NOT NULL CHECK (revision > 0),
  schema_version        INTEGER NOT NULL CHECK (schema_version > 0),
  profile_sha256        CHAR(64) NOT NULL CHECK (profile_sha256 ~ '^[0-9a-f]{64}$'),
  profile_json          JSONB NOT NULL,
  created_by_user_id    INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_by_actor_id   INTEGER NOT NULL CHECK (created_by_actor_id > 0),
  created_by_username   VARCHAR(160) NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, revision),
  UNIQUE (profile_id, profile_sha256),
  CONSTRAINT mcp_aiops_profile_revision_json_object CHECK (jsonb_typeof(profile_json) = 'object'),
  CONSTRAINT mcp_aiops_profile_revision_size CHECK (pg_column_size(profile_json) <= 262144)
);

ALTER TABLE mcp_observability_aiops_service_profiles
  DROP CONSTRAINT IF EXISTS mcp_aiops_profile_active_revision_fk,
  ADD CONSTRAINT mcp_aiops_profile_active_revision_fk
    FOREIGN KEY (id, active_revision)
    REFERENCES mcp_observability_aiops_service_profile_revisions(profile_id, revision)
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS idx_aiops_profiles_lifecycle
  ON mcp_observability_aiops_service_profiles
    (workspace_key, tenant_key, status, lower(service_name), lower(environment));

CREATE INDEX IF NOT EXISTS idx_aiops_profile_revisions_latest
  ON mcp_observability_aiops_service_profile_revisions (profile_id, revision DESC);

CREATE TABLE IF NOT EXISTS mcp_observability_aiops_profile_validations (
  id                    BIGSERIAL PRIMARY KEY,
  profile_id            BIGINT NOT NULL,
  revision              INTEGER NOT NULL,
  profile_sha256        CHAR(64) NOT NULL CHECK (profile_sha256 ~ '^[0-9a-f]{64}$'),
  status                VARCHAR(16) NOT NULL CHECK (status IN ('passed', 'warning', 'failed')),
  readiness_json        JSONB NOT NULL,
  validated_by_user_id  INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  validated_by_actor_id INTEGER NOT NULL CHECK (validated_by_actor_id > 0),
  validated_by_username VARCHAR(160) NOT NULL,
  validated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_aiops_profile_validation_revision_fk
    FOREIGN KEY (profile_id, revision)
    REFERENCES mcp_observability_aiops_service_profile_revisions(profile_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT mcp_aiops_profile_validation_json_object CHECK (jsonb_typeof(readiness_json) = 'object'),
  CONSTRAINT mcp_aiops_profile_validation_size CHECK (pg_column_size(readiness_json) <= 262144)
);

CREATE INDEX IF NOT EXISTS idx_aiops_profile_validations_latest
  ON mcp_observability_aiops_profile_validations (profile_id, revision, validated_at DESC, id DESC);

-- Freeze the exact profile revision used by every incident investigation.
-- Legacy tasks remain valid with NULL profile fields during the additive
-- alert-rule migration window.
ALTER TABLE mcp_observability_incident_aiops_tasks
  ADD COLUMN IF NOT EXISTS service_profile_id BIGINT,
  ADD COLUMN IF NOT EXISTS service_profile_revision INTEGER,
  ADD COLUMN IF NOT EXISTS service_profile_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS trigger_kind VARCHAR(32),
  ADD COLUMN IF NOT EXISTS trigger_ref VARCHAR(256),
  ADD CONSTRAINT mcp_incident_aiops_profile_revision_fk
    FOREIGN KEY (service_profile_id, service_profile_revision)
    REFERENCES mcp_observability_aiops_service_profile_revisions(profile_id, revision)
    ON DELETE RESTRICT,
  ADD CONSTRAINT mcp_incident_aiops_profile_identity_complete CHECK (
    (service_profile_id IS NULL AND service_profile_revision IS NULL AND service_profile_sha256 IS NULL)
    OR
    (service_profile_id IS NOT NULL AND service_profile_revision IS NOT NULL AND service_profile_sha256 IS NOT NULL)
  ),
  ADD CONSTRAINT mcp_incident_aiops_profile_sha256_format CHECK (
    service_profile_sha256 IS NULL OR service_profile_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT mcp_incident_aiops_trigger_complete CHECK (
    (trigger_kind IS NULL AND trigger_ref IS NULL)
    OR
    (trigger_kind IN ('manual', 'native-alert', 'provider-incident', 'schedule', 'api'))
  );

CREATE OR REPLACE FUNCTION prevent_incident_aiops_execution_context_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.execution_bundle_ids IS DISTINCT FROM OLD.execution_bundle_ids
     OR NEW.execution_resource_scope IS DISTINCT FROM OLD.execution_resource_scope
     OR NEW.execution_service IS DISTINCT FROM OLD.execution_service
     OR NEW.execution_environment IS DISTINCT FROM OLD.execution_environment
     OR NEW.execution_context_captured_at IS DISTINCT FROM OLD.execution_context_captured_at
     OR NEW.service_profile_id IS DISTINCT FROM OLD.service_profile_id
     OR NEW.service_profile_revision IS DISTINCT FROM OLD.service_profile_revision
     OR NEW.service_profile_sha256 IS DISTINCT FROM OLD.service_profile_sha256
     OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
     OR NEW.trigger_ref IS DISTINCT FROM OLD.trigger_ref THEN
    RAISE EXCEPTION 'incident AIOps execution context is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_incident_aiops_execution_context_immutable
  ON mcp_observability_incident_aiops_tasks;
CREATE TRIGGER trg_incident_aiops_execution_context_immutable
BEFORE UPDATE OF execution_bundle_ids, execution_resource_scope, execution_service,
                 execution_environment, execution_context_captured_at,
                 service_profile_id, service_profile_revision, service_profile_sha256,
                 trigger_kind, trigger_ref
ON mcp_observability_incident_aiops_tasks
FOR EACH ROW EXECUTE FUNCTION prevent_incident_aiops_execution_context_update();

CREATE OR REPLACE FUNCTION update_mcp_aiops_service_profile_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_aiops_service_profile_updated_at
  ON mcp_observability_aiops_service_profiles;
CREATE TRIGGER trg_mcp_aiops_service_profile_updated_at
  BEFORE UPDATE ON mcp_observability_aiops_service_profiles
  FOR EACH ROW EXECUTE FUNCTION update_mcp_aiops_service_profile_updated_at();

-- Revision and validation evidence is append-only. Revalidation appends a new
-- record instead of replacing the previous result.
DROP TRIGGER IF EXISTS mcp_aiops_profile_revisions_no_update
  ON mcp_observability_aiops_service_profile_revisions;
DROP TRIGGER IF EXISTS mcp_aiops_profile_revisions_no_delete
  ON mcp_observability_aiops_service_profile_revisions;
DROP TRIGGER IF EXISTS mcp_aiops_profile_revisions_no_truncate
  ON mcp_observability_aiops_service_profile_revisions;
CREATE TRIGGER mcp_aiops_profile_revisions_no_update
  BEFORE UPDATE ON mcp_observability_aiops_service_profile_revisions
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_aiops_profile_revisions_no_delete
  BEFORE DELETE ON mcp_observability_aiops_service_profile_revisions
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_aiops_profile_revisions_no_truncate
  BEFORE TRUNCATE ON mcp_observability_aiops_service_profile_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

DROP TRIGGER IF EXISTS mcp_aiops_profile_validations_no_update
  ON mcp_observability_aiops_profile_validations;
DROP TRIGGER IF EXISTS mcp_aiops_profile_validations_no_delete
  ON mcp_observability_aiops_profile_validations;
DROP TRIGGER IF EXISTS mcp_aiops_profile_validations_no_truncate
  ON mcp_observability_aiops_profile_validations;
CREATE TRIGGER mcp_aiops_profile_validations_no_update
  BEFORE UPDATE ON mcp_observability_aiops_profile_validations
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_aiops_profile_validations_no_delete
  BEFORE DELETE ON mcp_observability_aiops_profile_validations
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_aiops_profile_validations_no_truncate
  BEFORE TRUNCATE ON mcp_observability_aiops_profile_validations
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

-- Extend the canonical shared taxonomy instead of creating AIOps-only tags.
ALTER TABLE mcp_resource_tag_assignments
  DROP CONSTRAINT IF EXISTS mcp_resource_tag_resource_type;
ALTER TABLE mcp_resource_tag_assignments
  ADD CONSTRAINT mcp_resource_tag_resource_type CHECK (resource_type IN (
    'agent',
    'blueprint',
    'public_widget',
    'knowledge_source',
    'repository_snapshot',
    'skill',
    'workflow',
    'workflow_template',
    'mcp_connection',
    'mcp_bundle',
    'mcp_tool',
    'mcp_capability',
    'aiops_service_profile'
  ));

COMMENT ON TABLE mcp_observability_aiops_service_profiles IS
  'Stable service/environment identities and explicit AIOps profile lifecycle pointers.';
COMMENT ON TABLE mcp_observability_aiops_service_profile_revisions IS
  'Immutable, content-addressed AIOps service profile definitions.';
COMMENT ON TABLE mcp_observability_aiops_profile_validations IS
  'Append-only readiness evidence for an exact AIOps service profile revision.';
COMMENT ON COLUMN mcp_observability_incident_aiops_tasks.service_profile_sha256 IS
  'Immutable content hash of the exact service profile revision used by the investigation.';
