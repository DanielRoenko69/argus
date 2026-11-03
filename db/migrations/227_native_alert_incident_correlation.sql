-- Explainable, service-scoped correlation for native observability alerts.
-- Signal incidents remain the immutable rule-level evidence. Correlation groups
-- add a durable incident identity without rewriting or deleting those signals.

CREATE TABLE IF NOT EXISTS mcp_observability_alert_incident_groups (
  id                         BIGSERIAL PRIMARY KEY,
  correlation_key            CHAR(64) NOT NULL UNIQUE
                               CHECK (correlation_key ~ '^[0-9a-f]{64}$'),
  workspace_key              VARCHAR(128) NOT NULL DEFAULT 'default',
  tenant_key                 VARCHAR(128) NOT NULL DEFAULT 'default',
  service                    VARCHAR(160) NOT NULL,
  environment                VARCHAR(120) NOT NULL,
  state                      VARCHAR(16) NOT NULL DEFAULT 'firing'
                               CHECK (state IN ('firing', 'recovered')),
  severity                   VARCHAR(16) NOT NULL
                               CHECK (severity IN ('info', 'warning', 'critical')),
  correlation_window_minutes INTEGER NOT NULL CHECK (correlation_window_minutes BETWEEN 5 AND 360),
  primary_incident_id        BIGINT NOT NULL
                               REFERENCES mcp_observability_alert_incidents(id) ON DELETE RESTRICT,
  primary_service_profile_id BIGINT,
  primary_service_profile_revision INTEGER,
  primary_service_profile_sha256 CHAR(64),
  signal_count               INTEGER NOT NULL DEFAULT 1 CHECK (signal_count > 0),
  first_triggered_at         TIMESTAMPTZ NOT NULL,
  last_signal_at             TIMESTAMPTZ NOT NULL,
  recovered_at               TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_alert_group_scope_nonempty CHECK (
    length(btrim(service)) > 0 AND length(btrim(environment)) > 0
  ),
  CONSTRAINT mcp_alert_group_profile_complete CHECK (
    (primary_service_profile_id IS NULL
      AND primary_service_profile_revision IS NULL
      AND primary_service_profile_sha256 IS NULL)
    OR
    (primary_service_profile_id IS NOT NULL
      AND primary_service_profile_revision IS NOT NULL
      AND primary_service_profile_sha256 IS NOT NULL)
  ),
  CONSTRAINT mcp_alert_group_profile_sha256 CHECK (
    primary_service_profile_sha256 IS NULL
      OR primary_service_profile_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT mcp_alert_group_profile_revision_fk
    FOREIGN KEY (primary_service_profile_id, primary_service_profile_revision)
    REFERENCES mcp_observability_aiops_service_profile_revisions(profile_id, revision)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS mcp_observability_alert_incident_group_members (
  group_id                   BIGINT NOT NULL
                               REFERENCES mcp_observability_alert_incident_groups(id) ON DELETE RESTRICT,
  incident_id                BIGINT NOT NULL UNIQUE
                               REFERENCES mcp_observability_alert_incidents(id) ON DELETE RESTRICT,
  role                       VARCHAR(16) NOT NULL CHECK (role IN ('primary', 'member')),
  grouping_reasons           JSONB NOT NULL DEFAULT '[]'::jsonb,
  service_profile_id         BIGINT,
  service_profile_revision   INTEGER,
  service_profile_sha256     CHAR(64),
  grouped_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, incident_id),
  CONSTRAINT mcp_alert_group_member_reasons_array CHECK (
    jsonb_typeof(grouping_reasons) = 'array' AND pg_column_size(grouping_reasons) <= 32768
  ),
  CONSTRAINT mcp_alert_group_member_profile_complete CHECK (
    (service_profile_id IS NULL AND service_profile_revision IS NULL AND service_profile_sha256 IS NULL)
    OR
    (service_profile_id IS NOT NULL AND service_profile_revision IS NOT NULL AND service_profile_sha256 IS NOT NULL)
  ),
  CONSTRAINT mcp_alert_group_member_profile_sha256 CHECK (
    service_profile_sha256 IS NULL OR service_profile_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT mcp_alert_group_member_profile_revision_fk
    FOREIGN KEY (service_profile_id, service_profile_revision)
    REFERENCES mcp_observability_aiops_service_profile_revisions(profile_id, revision)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_alert_group_primary_member
  ON mcp_observability_alert_incident_group_members(group_id)
  WHERE role='primary';

CREATE INDEX IF NOT EXISTS idx_mcp_alert_groups_scope_window
  ON mcp_observability_alert_incident_groups
    (workspace_key, tenant_key, lower(service), lower(environment), last_signal_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_alert_group_members_grouped
  ON mcp_observability_alert_incident_group_members(group_id, grouped_at, incident_id);

-- Membership and its grouping explanation are append-only audit evidence.
DROP TRIGGER IF EXISTS mcp_alert_group_members_no_update
  ON mcp_observability_alert_incident_group_members;
DROP TRIGGER IF EXISTS mcp_alert_group_members_no_delete
  ON mcp_observability_alert_incident_group_members;
DROP TRIGGER IF EXISTS mcp_alert_group_members_no_truncate
  ON mcp_observability_alert_incident_group_members;
CREATE TRIGGER mcp_alert_group_members_no_update
  BEFORE UPDATE ON mcp_observability_alert_incident_group_members
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_alert_group_members_no_delete
  BEFORE DELETE ON mcp_observability_alert_incident_group_members
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_alert_group_members_no_truncate
  BEFORE TRUNCATE ON mcp_observability_alert_incident_group_members
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_observability_alert_incident_groups IS
  'Service/environment-scoped incident identities that deduplicate related native alert signals.';
COMMENT ON COLUMN mcp_observability_alert_incident_group_members.grouping_reasons IS
  'Append-only, machine-readable explanation of why this signal belongs to the group.';
