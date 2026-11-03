-- Migration 075: Bind Skills to Service Bundles
--
-- Adds a many-to-many join between Service Bundles and Skills so a Bundle
-- like "gitea-ai-dev" can carry not just tools but also the skills that
-- usually accompany those tools (PR-Creation-Protocol, Code-Review-Protocol).
--
-- Resolution order when computing "effective skills" for an API key:
--   1. Skills bound directly to the key via mcp_api_keys.skill_ids (mig 074)
--   2. Skills bound to bundles that the key's composite includes
--   3. De-duplicated (a skill appearing in both is included once)
--
-- The composite-to-bundle linkage already exists via
-- mcp_composites.included_bundle_ids. Skill-binding lives at the bundle
-- level so multiple composites can share the same bundle+skills.

CREATE TABLE IF NOT EXISTS mcp_bundle_skills (
  bundle_id  INTEGER NOT NULL REFERENCES mcp_service_bundles(id) ON DELETE CASCADE,
  skill_id   INTEGER NOT NULL REFERENCES mcp_skills(id)          ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bundle_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_bundle_skills_bundle ON mcp_bundle_skills (bundle_id, position);
CREATE INDEX IF NOT EXISTS idx_bundle_skills_skill  ON mcp_bundle_skills (skill_id);

COMMENT ON TABLE mcp_bundle_skills IS
  'Many-to-many: which skills come automatically when a key has this service bundle in its composite.';
