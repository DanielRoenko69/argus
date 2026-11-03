-- Migration 025: Teams & Guardrails

-- ============================================================
-- 1. Teams & Organizations
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_teams (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(128) NOT NULL UNIQUE,
  label           VARCHAR(256),
  description     TEXT,
  max_budget      NUMERIC(16,4) DEFAULT NULL,
  budget_duration VARCHAR(16) DEFAULT '30d',
  current_spend   NUMERIC(16,4) DEFAULT 0,
  spend_reset_at  TIMESTAMPTZ DEFAULT now(),
  allowed_models  TEXT[] DEFAULT NULL,
  tpm_limit       INTEGER DEFAULT NULL,
  rpm_limit       INTEGER DEFAULT NULL,
  admin_user_ids  INTEGER[] DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_team_members (
  team_id         INTEGER REFERENCES mcp_teams(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES mcp_users(id) ON DELETE CASCADE,
  role            VARCHAR(16) DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  added_at        TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

-- ============================================================
-- 2. Team API Key Assignment
-- ============================================================

ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES mcp_teams(id);

-- ============================================================
-- 3. Guardrail Policies
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_guardrails (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(128) NOT NULL UNIQUE,
  description     TEXT,
  type            VARCHAR(32) NOT NULL,
  config          JSONB NOT NULL DEFAULT '{}',
  action          VARCHAR(16) DEFAULT 'block',
  severity        VARCHAR(16) DEFAULT 'medium',
  enabled         BOOLEAN DEFAULT true,
  default_on      BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_guardrail_assignments (
  guardrail_id    INTEGER REFERENCES mcp_guardrails(id) ON DELETE CASCADE,
  target_type     VARCHAR(16) NOT NULL,
  target_id       INTEGER,
  PRIMARY KEY (guardrail_id, target_type, target_id)
);

COMMENT ON TABLE mcp_teams IS 'Teams for multi-tenancy in LLM Gateway';
COMMENT ON TABLE mcp_guardrails IS 'Content guardrail policies for LLM requests';
