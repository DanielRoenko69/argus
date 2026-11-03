-- AI Act compliance enablement registry.
-- Stable AI-system rows own lifecycle and current-revision pointers. Revisions,
-- market-role assignments and assessments are immutable evidence records.

CREATE TABLE IF NOT EXISTS mcp_ai_systems (
  id                    UUID PRIMARY KEY,
  workspace_key         VARCHAR(128) NOT NULL DEFAULT 'default',
  tenant_key            VARCHAR(128) NOT NULL DEFAULT 'default',
  display_name          VARCHAR(240) NOT NULL,
  lifecycle_state       VARCHAR(40) NOT NULL DEFAULT 'not_assessed'
    CHECK (lifecycle_state IN (
      'not_assessed',
      'assessment_in_progress',
      'blocked',
      'controls_incomplete',
      'ready_for_independent_review',
      'externally_assessed',
      'released',
      'suspended',
      'retired'
    )),
  owner_actor_type      VARCHAR(32) NOT NULL
    CHECK (owner_actor_type IN ('user', 'service', 'system', 'external_reviewer')),
  owner_actor_id        VARCHAR(200) NOT NULL,
  current_revision      INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_ai_system_scope_nonempty CHECK (
    length(btrim(workspace_key)) > 0 AND length(btrim(tenant_key)) > 0
  ),
  CONSTRAINT mcp_ai_system_display_name_nonempty CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT mcp_ai_system_owner_nonempty CHECK (length(btrim(owner_actor_id)) > 0),
  UNIQUE (id, workspace_key, tenant_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_ai_system_display_name
  ON mcp_ai_systems (workspace_key, tenant_key, lower(display_name));
CREATE INDEX IF NOT EXISTS idx_mcp_ai_system_lifecycle
  ON mcp_ai_systems (workspace_key, tenant_key, lifecycle_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS mcp_ai_system_revisions (
  ai_system_id          UUID NOT NULL REFERENCES mcp_ai_systems(id) ON DELETE RESTRICT,
  revision              INTEGER NOT NULL CHECK (revision > 0),
  revision_id           UUID NOT NULL UNIQUE,
  schema_version        INTEGER NOT NULL CHECK (schema_version > 0),
  revision_sha256       CHAR(64) NOT NULL CHECK (revision_sha256 ~ '^[0-9a-f]{64}$'),
  revision_json         JSONB NOT NULL,
  created_by_actor_type VARCHAR(32) NOT NULL
    CHECK (created_by_actor_type IN ('user', 'service', 'system', 'external_reviewer')),
  created_by_actor_id   VARCHAR(200) NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at           TIMESTAMPTZ,
  PRIMARY KEY (ai_system_id, revision),
  UNIQUE (ai_system_id, revision_sha256),
  CONSTRAINT mcp_ai_system_revision_json_object CHECK (jsonb_typeof(revision_json) = 'object'),
  CONSTRAINT mcp_ai_system_revision_json_size CHECK (pg_column_size(revision_json) <= 1048576),
  CONSTRAINT mcp_ai_system_revision_actor_nonempty CHECK (length(btrim(created_by_actor_id)) > 0)
);

ALTER TABLE mcp_ai_systems
  DROP CONSTRAINT IF EXISTS mcp_ai_system_current_revision_fk,
  ADD CONSTRAINT mcp_ai_system_current_revision_fk
    FOREIGN KEY (id, current_revision)
    REFERENCES mcp_ai_system_revisions(ai_system_id, revision)
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS idx_mcp_ai_system_revisions_latest
  ON mcp_ai_system_revisions (ai_system_id, revision DESC);

CREATE TABLE IF NOT EXISTS mcp_ai_system_role_assignments (
  assignment_id         UUID PRIMARY KEY,
  ai_system_id          UUID NOT NULL,
  revision              INTEGER NOT NULL,
  market_role           VARCHAR(40) NOT NULL CHECK (market_role IN (
    'provider',
    'deployer',
    'importer',
    'distributor',
    'authorised_representative',
    'product_manufacturer',
    'data_controller',
    'data_processor'
  )),
  organisation_id       VARCHAR(200) NOT NULL,
  organisation_name     VARCHAR(240) NOT NULL,
  role_json             JSONB NOT NULL,
  confirmed_by_type     VARCHAR(32) NOT NULL
    CHECK (confirmed_by_type IN ('user', 'service', 'system', 'external_reviewer')),
  confirmed_by_id       VARCHAR(200) NOT NULL,
  confirmed_at          TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_ai_system_role_revision_fk
    FOREIGN KEY (ai_system_id, revision)
    REFERENCES mcp_ai_system_revisions(ai_system_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT mcp_ai_system_role_identity_nonempty CHECK (
    length(btrim(organisation_id)) > 0
    AND length(btrim(organisation_name)) > 0
    AND length(btrim(confirmed_by_id)) > 0
  ),
  CONSTRAINT mcp_ai_system_role_json_object CHECK (jsonb_typeof(role_json) = 'object'),
  CONSTRAINT mcp_ai_system_role_json_size CHECK (pg_column_size(role_json) <= 65536),
  UNIQUE (ai_system_id, revision, market_role)
);

CREATE INDEX IF NOT EXISTS idx_mcp_ai_system_roles_revision
  ON mcp_ai_system_role_assignments (ai_system_id, revision, market_role);

CREATE TABLE IF NOT EXISTS mcp_ai_system_assessments (
  assessment_id         UUID PRIMARY KEY,
  ai_system_id          UUID NOT NULL,
  revision              INTEGER NOT NULL,
  assessment_type       VARCHAR(40) NOT NULL CHECK (assessment_type IN (
    'prohibited_practices',
    'classification',
    'substantial_change'
  )),
  decision              VARCHAR(40) NOT NULL,
  assessment_sha256     CHAR(64) NOT NULL CHECK (assessment_sha256 ~ '^[0-9a-f]{64}$'),
  assessment_json       JSONB NOT NULL,
  assessed_by_type      VARCHAR(32) NOT NULL
    CHECK (assessed_by_type IN ('user', 'service', 'system', 'external_reviewer')),
  assessed_by_id        VARCHAR(200) NOT NULL,
  assessed_at           TIMESTAMPTZ NOT NULL,
  next_review_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_ai_system_assessment_revision_fk
    FOREIGN KEY (ai_system_id, revision)
    REFERENCES mcp_ai_system_revisions(ai_system_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT mcp_ai_system_assessment_decision CHECK (
    (assessment_type = 'prohibited_practices' AND decision IN ('clear', 'blocked', 'external_review_required'))
    OR (assessment_type = 'classification' AND decision IN (
      'assessment_required', 'prohibited', 'high_risk', 'limited_transparency',
      'minimal_or_no_risk', 'out_of_scope'
    ))
    OR (assessment_type = 'substantial_change' AND decision IN ('no_change', 'reassessment_required'))
  ),
  CONSTRAINT mcp_ai_system_assessment_actor_nonempty CHECK (length(btrim(assessed_by_id)) > 0),
  CONSTRAINT mcp_ai_system_assessment_json_object CHECK (jsonb_typeof(assessment_json) = 'object'),
  CONSTRAINT mcp_ai_system_assessment_json_size CHECK (pg_column_size(assessment_json) <= 262144),
  UNIQUE (ai_system_id, revision, assessment_type),
  UNIQUE (ai_system_id, assessment_sha256)
);

CREATE INDEX IF NOT EXISTS idx_mcp_ai_system_assessments_review
  ON mcp_ai_system_assessments (next_review_at, assessment_type)
  WHERE next_review_at IS NOT NULL;

CREATE OR REPLACE FUNCTION update_mcp_ai_system_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_ai_system_updated_at ON mcp_ai_systems;
CREATE TRIGGER trg_mcp_ai_system_updated_at
  BEFORE UPDATE ON mcp_ai_systems
  FOR EACH ROW EXECUTE FUNCTION update_mcp_ai_system_updated_at();

-- Immutable evidence tables. New facts create a new system revision or
-- assessment row; no historical row can be rewritten or hard-deleted.
DROP TRIGGER IF EXISTS mcp_ai_system_revisions_no_update ON mcp_ai_system_revisions;
DROP TRIGGER IF EXISTS mcp_ai_system_revisions_no_delete ON mcp_ai_system_revisions;
DROP TRIGGER IF EXISTS mcp_ai_system_revisions_no_truncate ON mcp_ai_system_revisions;
CREATE TRIGGER mcp_ai_system_revisions_no_update
  BEFORE UPDATE ON mcp_ai_system_revisions
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_revisions_no_delete
  BEFORE DELETE ON mcp_ai_system_revisions
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_revisions_no_truncate
  BEFORE TRUNCATE ON mcp_ai_system_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

DROP TRIGGER IF EXISTS mcp_ai_system_roles_no_update ON mcp_ai_system_role_assignments;
DROP TRIGGER IF EXISTS mcp_ai_system_roles_no_delete ON mcp_ai_system_role_assignments;
DROP TRIGGER IF EXISTS mcp_ai_system_roles_no_truncate ON mcp_ai_system_role_assignments;
CREATE TRIGGER mcp_ai_system_roles_no_update
  BEFORE UPDATE ON mcp_ai_system_role_assignments
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_roles_no_delete
  BEFORE DELETE ON mcp_ai_system_role_assignments
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_roles_no_truncate
  BEFORE TRUNCATE ON mcp_ai_system_role_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

DROP TRIGGER IF EXISTS mcp_ai_system_assessments_no_update ON mcp_ai_system_assessments;
DROP TRIGGER IF EXISTS mcp_ai_system_assessments_no_delete ON mcp_ai_system_assessments;
DROP TRIGGER IF EXISTS mcp_ai_system_assessments_no_truncate ON mcp_ai_system_assessments;
CREATE TRIGGER mcp_ai_system_assessments_no_update
  BEFORE UPDATE ON mcp_ai_system_assessments
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_assessments_no_delete
  BEFORE DELETE ON mcp_ai_system_assessments
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_ai_system_assessments_no_truncate
  BEFORE TRUNCATE ON mcp_ai_system_assessments
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

-- AI systems join the shared workspace taxonomy instead of introducing a
-- compliance-only tagging implementation.
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
    'aiops_service_profile',
    'ai_system'
  ));

COMMENT ON TABLE mcp_ai_systems IS
  'Stable tenant-scoped AI-system identities and current immutable revision pointers.';
COMMENT ON TABLE mcp_ai_system_revisions IS
  'Immutable content-addressed intended-purpose, classification and component revision snapshots.';
COMMENT ON TABLE mcp_ai_system_role_assignments IS
  'Immutable provider/deployer and adjacent market-role assignments for one AI-system revision.';
COMMENT ON TABLE mcp_ai_system_assessments IS
  'Immutable prohibited-practice, classification and substantial-change assessments.';
