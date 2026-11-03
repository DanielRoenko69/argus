-- Migration 018: Agent Skills Library
-- Wiederverwendbare Prompt-Bausteine (Skills) die Agents zugewiesen werden können.

CREATE TABLE IF NOT EXISTS mcp_skills (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(128) NOT NULL UNIQUE,
  label       VARCHAR(256) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  category    VARCHAR(64),
  icon        VARCHAR(32) NOT NULL DEFAULT '🔧',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT skill_name_format CHECK (name ~ '^[a-z0-9_-]+$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_skills_category ON mcp_skills (category);

-- Agent <-> Skill Junction (mit Position-Reihenfolge)
CREATE TABLE IF NOT EXISTS mcp_agent_skills (
  agent_id   INTEGER NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  skill_id   INTEGER NOT NULL REFERENCES mcp_skills(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_agent_skills_agent ON mcp_agent_skills (agent_id);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_mcp_skills_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_skills_updated_at ON mcp_skills;
CREATE TRIGGER trg_mcp_skills_updated_at
  BEFORE UPDATE ON mcp_skills
  FOR EACH ROW EXECUTE FUNCTION update_mcp_skills_updated_at();

COMMENT ON TABLE mcp_skills IS 'Wiederverwendbare Prompt-Bausteine für Agent System Prompt Composition.';
COMMENT ON TABLE mcp_agent_skills IS 'Junction: welche Skills einem Agent zugewiesen sind, mit Positions-Reihenfolge.';
