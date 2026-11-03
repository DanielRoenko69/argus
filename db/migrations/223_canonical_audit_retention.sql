-- Versioned retention configuration and non-mutating legal-hold overlays.
-- Lifecycle changes are append-only; Core writes matching canonical audit
-- events in the same transaction through src/audit/retention.ts.

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_retention_policies (
  policy_id       UUID PRIMARY KEY,
  workspace_key   VARCHAR(128) NOT NULL,
  tenant_key      VARCHAR(128) NOT NULL,
  environment     VARCHAR(64) NOT NULL,
  retention_class VARCHAR(64) NOT NULL,
  version          INTEGER NOT NULL CHECK (version > 0),
  duration_days    INTEGER CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 36500),
  region           VARCHAR(64) NOT NULL,
  effective_from   TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL,
  created_by       VARCHAR(256) NOT NULL,
  policy_digest    CHAR(64) NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
  UNIQUE (workspace_key, tenant_key, environment, retention_class, version)
);

CREATE INDEX IF NOT EXISTS idx_canonical_audit_retention_policy_lookup
  ON mcp_canonical_audit_retention_policies
    (workspace_key, tenant_key, environment, retention_class, effective_from DESC, version DESC);

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_legal_hold_actions (
  hold_action_id       UUID PRIMARY KEY,
  hold_id              UUID NOT NULL,
  action               VARCHAR(16) NOT NULL CHECK (action IN ('placed', 'released')),
  workspace_key        VARCHAR(128) NOT NULL,
  tenant_key           VARCHAR(128) NOT NULL,
  environment          VARCHAR(64) NOT NULL,
  from_sequence        BIGINT NOT NULL DEFAULT 1 CHECK (from_sequence > 0),
  through_sequence     BIGINT CHECK (through_sequence IS NULL OR through_sequence >= from_sequence),
  resource_type        VARCHAR(64),
  resource_id          VARCHAR(256),
  justification_digest CHAR(64) NOT NULL CHECK (justification_digest ~ '^[0-9a-f]{64}$'),
  actor_id              VARCHAR(256) NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL,
  producer_event_id     VARCHAR(256) NOT NULL,
  UNIQUE (workspace_key, tenant_key, environment, hold_id, action),
  UNIQUE (workspace_key, tenant_key, environment, producer_event_id),
  CHECK ((resource_type IS NULL) = (resource_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_canonical_audit_legal_hold_scope
  ON mcp_canonical_audit_legal_hold_actions
    (workspace_key, tenant_key, environment, hold_id, occurred_at DESC);

DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_policies_no_update ON mcp_canonical_audit_retention_policies;
DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_policies_no_delete ON mcp_canonical_audit_retention_policies;
DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_policies_no_truncate ON mcp_canonical_audit_retention_policies;
CREATE TRIGGER mcp_canonical_audit_retention_policies_no_update
  BEFORE UPDATE ON mcp_canonical_audit_retention_policies
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_retention_policies_no_delete
  BEFORE DELETE ON mcp_canonical_audit_retention_policies
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_retention_policies_no_truncate
  BEFORE TRUNCATE ON mcp_canonical_audit_retention_policies
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

DROP TRIGGER IF EXISTS mcp_canonical_audit_legal_hold_actions_no_update ON mcp_canonical_audit_legal_hold_actions;
DROP TRIGGER IF EXISTS mcp_canonical_audit_legal_hold_actions_no_delete ON mcp_canonical_audit_legal_hold_actions;
DROP TRIGGER IF EXISTS mcp_canonical_audit_legal_hold_actions_no_truncate ON mcp_canonical_audit_legal_hold_actions;
CREATE TRIGGER mcp_canonical_audit_legal_hold_actions_no_update
  BEFORE UPDATE ON mcp_canonical_audit_legal_hold_actions
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_legal_hold_actions_no_delete
  BEFORE DELETE ON mcp_canonical_audit_legal_hold_actions
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_legal_hold_actions_no_truncate
  BEFORE TRUNCATE ON mcp_canonical_audit_legal_hold_actions
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_canonical_audit_retention_policies IS
  'Append-only, scoped and region-aware retention policy versions. NULL duration means indefinite retention.';
COMMENT ON TABLE mcp_canonical_audit_legal_hold_actions IS
  'Append-only placed/released legal-hold actions. Effective hold state is derived without modifying canonical events.';
