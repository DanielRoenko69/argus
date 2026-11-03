-- Migration 093: Workflow approval-flow (Argus-original feature).
--
-- A workflow has a lifecycle: draft → review → production. Only 'production'
-- workflows can be executed via cron/webhook triggers (UI execute always works
-- for draft as test). Promotion requires explicit approval by another user
-- (4-eyes principle, audit-tracked).

ALTER TABLE mcp_workflows
  ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(16) NOT NULL DEFAULT 'draft';

-- Backfill: existing visual/manual workflows = 'draft', templates stay 'draft'.
UPDATE mcp_workflows SET lifecycle_status = 'draft' WHERE lifecycle_status IS NULL;

-- Idempotent: Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so guard via
-- pg_constraint. Without this, a re-run (MIGRATE_MODE=force or a retry after a
-- partial failure) aborts with "constraint already exists" and rolls back the
-- whole migration.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wf_lifecycle_chk'
  ) THEN
    ALTER TABLE mcp_workflows
      ADD CONSTRAINT wf_lifecycle_chk
      CHECK (lifecycle_status IN ('draft', 'review', 'production'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mcp_workflows_lifecycle ON mcp_workflows (lifecycle_status);

CREATE TABLE IF NOT EXISTS mcp_workflow_approvals (
  id            BIGSERIAL PRIMARY KEY,
  workflow_id   INTEGER NOT NULL REFERENCES mcp_workflows(id) ON DELETE CASCADE,
  workflow_version INTEGER,      -- snapshot from mcp_workflow_versions
  action        VARCHAR(16) NOT NULL CHECK (action IN ('submitted', 'approved', 'rejected', 'withdrawn')),
  actor_username VARCHAR(128) NOT NULL,
  actor_role     VARCHAR(64),
  comment       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approvals_wf ON mcp_workflow_approvals (workflow_id, created_at DESC);

COMMENT ON TABLE mcp_workflow_approvals IS
  '4-eyes approval audit-trail for promoting workflows to production.';
