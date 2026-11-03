-- Migration 092: Workflow tags + GIN index for filter performance.

ALTER TABLE mcp_workflows
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_mcp_workflows_tags ON mcp_workflows USING GIN (tags);

COMMENT ON COLUMN mcp_workflows.tags IS
  'Free-form labels for filtering in workflow list. Lowercased by convention.';
