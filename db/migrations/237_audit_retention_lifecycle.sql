-- Governed audit-retention lifecycle. Plans and decisions are append-only.
-- This migration intentionally does not create a physical DELETE function:
-- archive verification is a mandatory, separately attestable gate first.

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_retention_plans (
  plan_id               UUID PRIMARY KEY,
  workspace_key         VARCHAR(128) NOT NULL,
  tenant_key            VARCHAR(128) NOT NULL,
  environment           VARCHAR(64) NOT NULL,
  retention_class       VARCHAR(64) NOT NULL,
  checkpoint_id         UUID NOT NULL REFERENCES mcp_canonical_audit_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  checkpoint_digest     CHAR(64) NOT NULL CHECK (checkpoint_digest ~ '^[0-9a-f]{64}$'),
  through_sequence      BIGINT NOT NULL CHECK (through_sequence > 0),
  evaluated_at          TIMESTAMPTZ NOT NULL,
  eligible_prefix_count INTEGER NOT NULL CHECK (eligible_prefix_count >= 0),
  first_sequence        BIGINT CHECK (first_sequence IS NULL OR first_sequence > 0),
  last_sequence         BIGINT CHECK (last_sequence IS NULL OR last_sequence >= first_sequence),
  blocker_code          VARCHAR(32) NOT NULL CHECK (blocker_code IN ('empty','legal_hold','not_due','indefinite','batch_limit','checkpoint_boundary')),
  blocker_sequence      BIGINT CHECK (blocker_sequence IS NULL OR blocker_sequence > 0),
  manifest_sha256       CHAR(64) NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_json         JSONB NOT NULL CHECK (jsonb_typeof(manifest_json) = 'object'),
  requested_by_id       VARCHAR(256) NOT NULL,
  requester_sso_subject VARCHAR(512) NOT NULL,
  mfa_verified_at       TIMESTAMPTZ NOT NULL,
  mfa_method            VARCHAR(160) NOT NULL,
  producer_event_id     VARCHAR(256) NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_key, tenant_key, environment, producer_event_id),
  CONSTRAINT mcp_retention_plan_sequence_shape CHECK (
    (eligible_prefix_count = 0 AND first_sequence IS NULL AND last_sequence IS NULL)
    OR (eligible_prefix_count > 0 AND first_sequence IS NOT NULL AND last_sequence IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_mcp_canonical_audit_retention_plans_scope
  ON mcp_canonical_audit_retention_plans
    (workspace_key, tenant_key, environment, created_at DESC);

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_retention_plan_actions (
  action_id          UUID PRIMARY KEY,
  plan_id            UUID NOT NULL REFERENCES mcp_canonical_audit_retention_plans(plan_id) ON DELETE RESTRICT,
  action             VARCHAR(24) NOT NULL CHECK (action IN ('approved','rejected','archive_verified','purge_executed','failed')),
  actor_id           VARCHAR(256) NOT NULL,
  actor_sso_subject  VARCHAR(512) NOT NULL,
  mfa_verified_at    TIMESTAMPTZ NOT NULL,
  mfa_method         VARCHAR(160) NOT NULL,
  justification_sha256 CHAR(64) NOT NULL CHECK (justification_sha256 ~ '^[0-9a-f]{64}$'),
  anchor_id          UUID REFERENCES mcp_external_evidence_anchors(anchor_id) ON DELETE RESTRICT,
  producer_event_id  VARCHAR(256) NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL,
  UNIQUE (plan_id, action),
  UNIQUE (producer_event_id),
  CONSTRAINT mcp_retention_action_anchor_shape CHECK (
    (action = 'archive_verified' AND anchor_id IS NOT NULL)
    OR (action <> 'archive_verified' AND anchor_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_canonical_audit_retention_plan_decision
  ON mcp_canonical_audit_retention_plan_actions (plan_id)
  WHERE action IN ('approved','rejected');

CREATE INDEX IF NOT EXISTS idx_mcp_canonical_audit_retention_plan_actions_plan
  ON mcp_canonical_audit_retention_plan_actions (plan_id, occurred_at DESC);

DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_plans_no_update ON mcp_canonical_audit_retention_plans;
DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_plans_no_delete ON mcp_canonical_audit_retention_plans;
DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_plans_no_truncate ON mcp_canonical_audit_retention_plans;
CREATE TRIGGER mcp_canonical_audit_retention_plans_no_update
  BEFORE UPDATE ON mcp_canonical_audit_retention_plans
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_retention_plans_no_delete
  BEFORE DELETE ON mcp_canonical_audit_retention_plans
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_retention_plans_no_truncate
  BEFORE TRUNCATE ON mcp_canonical_audit_retention_plans
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_plan_actions_no_update ON mcp_canonical_audit_retention_plan_actions;
DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_plan_actions_no_delete ON mcp_canonical_audit_retention_plan_actions;
DROP TRIGGER IF EXISTS mcp_canonical_audit_retention_plan_actions_no_truncate ON mcp_canonical_audit_retention_plan_actions;
CREATE TRIGGER mcp_canonical_audit_retention_plan_actions_no_update
  BEFORE UPDATE ON mcp_canonical_audit_retention_plan_actions
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_retention_plan_actions_no_delete
  BEFORE DELETE ON mcp_canonical_audit_retention_plan_actions
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_canonical_audit_retention_plan_actions_no_truncate
  BEFORE TRUNCATE ON mcp_canonical_audit_retention_plan_actions
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_canonical_audit_retention_plans IS
  'Immutable dry-run manifests for a contiguous expired audit-chain prefix. A plan never deletes source evidence.';
COMMENT ON TABLE mcp_canonical_audit_retention_plan_actions IS
  'Append-only four-eyes decisions and later archive/purge attestations for retention plans.';
