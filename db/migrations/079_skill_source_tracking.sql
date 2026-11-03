-- Migration 079: Track skill provenance (Marketplace-Import)
--
-- The argus-skills CLI imports curated skills from external sources
-- (Anthropic claude-code-skills repo, community repos, local mirrors).
-- These columns let admins see WHERE a skill came from and re-sync
-- selectively, and let DORA-auditors prove "this skill originated at
-- commit X of repo Y at time T".
--
-- Semantics:
--   source_url  — canonical URL of the file, e.g. local:./skills/tdd.md
--                 or https://github.com/anthropics/claude-code-skills/blob/<sha>/skills/tdd.md
--   source_ref  — branch/tag the import was pulled from (NULL for local)
--   imported_at — timestamp of the last successful sync. NULL = hand-authored.

ALTER TABLE mcp_skills
  ADD COLUMN IF NOT EXISTS source_url  TEXT,
  ADD COLUMN IF NOT EXISTS source_ref  VARCHAR(128),
  ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_mcp_skills_source_url ON mcp_skills (source_url);

COMMENT ON COLUMN mcp_skills.source_url IS
  'Origin of an imported skill (local path or remote URL). NULL = hand-authored in Argus.';
