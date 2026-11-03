-- Organizations
CREATE TABLE IF NOT EXISTS mcp_organizations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(128) NOT NULL UNIQUE,
  label VARCHAR(256),
  description TEXT,
  max_budget NUMERIC(16,4) DEFAULT NULL,
  budget_duration VARCHAR(16) DEFAULT '30d',
  current_spend NUMERIC(16,4) DEFAULT 0,
  spend_reset_at TIMESTAMPTZ DEFAULT now(),
  allowed_models TEXT[] DEFAULT NULL,
  tpm_limit INTEGER DEFAULT NULL,
  rpm_limit INTEGER DEFAULT NULL,
  admin_user_ids INTEGER[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Add org_id to teams
ALTER TABLE mcp_teams ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES mcp_organizations(id) ON DELETE SET NULL;

-- Add org_id to api keys
ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES mcp_organizations(id) ON DELETE SET NULL;
