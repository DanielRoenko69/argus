-- Projects (sub-team scope)
CREATE TABLE IF NOT EXISTS mcp_projects (
  id SERIAL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  label VARCHAR(256),
  description TEXT,
  org_id INTEGER REFERENCES mcp_organizations(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES mcp_teams(id) ON DELETE SET NULL,
  max_budget NUMERIC(16,4) DEFAULT NULL,
  budget_duration VARCHAR(16) DEFAULT '30d',
  current_spend NUMERIC(16,4) DEFAULT 0,
  spend_reset_at TIMESTAMPTZ DEFAULT now(),
  allowed_models TEXT[] DEFAULT NULL,
  tpm_limit INTEGER DEFAULT NULL,
  rpm_limit INTEGER DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (name, org_id)
);

-- Add project_id to api keys
ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES mcp_projects(id) ON DELETE SET NULL;
