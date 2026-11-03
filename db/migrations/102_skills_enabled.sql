-- Migration 102: add mcp_skills.enabled (schema-drift fix).
--
-- mcp_skills was created by migration 018 WITHOUT an `enabled` column, yet
-- loadAccessiblePalette() (src/workflows/copilotRoutes.ts) and other callers
-- query `... FROM mcp_skills WHERE enabled = true`. On any DB built by running
-- migrations sequentially (every environment except a fresh init.sql), the
-- column is missing → the query throws `column "enabled" does not exist` →
-- the Workflow Copilot palette load fails. This adds the column idempotently.
ALTER TABLE mcp_skills ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_mcp_skills_enabled ON mcp_skills (enabled);
