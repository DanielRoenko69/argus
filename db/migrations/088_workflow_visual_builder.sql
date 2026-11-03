-- Migration 088: Visual Workflow Builder fields on mcp_workflows.
--
-- Adds the columns the React-based visual builder needs to round-trip a
-- workflow without losing any layout/UI information. The existing `steps`
-- column remains the source-of-truth for the executor (src/workflows/
-- executor.ts) — the new columns are pure UI metadata + trigger config.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS throughout.

ALTER TABLE mcp_workflows
  ADD COLUMN IF NOT EXISTS canvas_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS block_definitions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'manual';

-- source: 'manual' (legacy CLI/API created workflows) | 'visual' (visual builder)
-- canvas_state: { viewport: { x, y, zoom }, theme: 'dark'|'light', locked: bool }
-- trigger_config: { type: 'manual'|'webhook'|'cron'|'event'|'api', config: {...} }
-- block_definitions: array of block objects for visual restoration

CREATE INDEX IF NOT EXISTS idx_mcp_workflows_source ON mcp_workflows(source);

COMMENT ON COLUMN mcp_workflows.canvas_state IS
  'Visual builder state: viewport, zoom, theme. Pure UI metadata, ignored by executor.';
COMMENT ON COLUMN mcp_workflows.trigger_config IS
  'How workflow starts: manual|webhook|cron|event|api. Empty {} = manual default.';
COMMENT ON COLUMN mcp_workflows.block_definitions IS
  'Sim-format block list for visual builder. Executor uses steps[] instead.';
COMMENT ON COLUMN mcp_workflows.source IS
  'Origin marker: manual (CLI/API) vs visual (builder UI). Used for query filtering.';
