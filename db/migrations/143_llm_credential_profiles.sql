-- Reusable, provider-scoped LLM credentials for agents, teams and cost centres.
-- Secrets remain encrypted or externally referenced; assignments only store IDs.

CREATE TABLE IF NOT EXISTS mcp_llm_credential_profiles (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(96) NOT NULL UNIQUE,
  label               VARCHAR(160) NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  provider_type       VARCHAR(32) NOT NULL
                      CHECK (provider_type IN ('openai', 'anthropic', 'openai-compatible')),
  api_key             TEXT,
  secret_name         VARCHAR(160),
  department          VARCHAR(160),
  cost_center         VARCHAR(96),
  monthly_budget_usd  NUMERIC(16,4)
                      CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd > 0),
  budget_mode         VARCHAR(16) NOT NULL DEFAULT 'alert'
                      CHECK (budget_mode IN ('observe', 'alert', 'block')),
  enabled             BOOLEAN NOT NULL DEFAULT true,
  expires_at          TIMESTAMPTZ,
  last_rotated_at     TIMESTAMPTZ,
  created_by          INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT llm_credential_profile_name_format CHECK (name ~ '^[a-z0-9][a-z0-9_-]*$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_llm_credential_profiles_provider
  ON mcp_llm_credential_profiles (provider_type, enabled, label);
CREATE INDEX IF NOT EXISTS idx_mcp_llm_credential_profiles_cost_center
  ON mcp_llm_credential_profiles (cost_center)
  WHERE cost_center IS NOT NULL;

CREATE OR REPLACE FUNCTION update_mcp_llm_credential_profiles_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_llm_credential_profiles_updated_at ON mcp_llm_credential_profiles;
CREATE TRIGGER trg_mcp_llm_credential_profiles_updated_at
  BEFORE UPDATE ON mcp_llm_credential_profiles
  FOR EACH ROW EXECUTE FUNCTION update_mcp_llm_credential_profiles_updated_at();

ALTER TABLE mcp_llm_providers
  ADD COLUMN IF NOT EXISTS credential_profile_id INTEGER
  REFERENCES mcp_llm_credential_profiles(id) ON DELETE SET NULL;

ALTER TABLE mcp_agents
  ADD COLUMN IF NOT EXISTS llm_credential_profile_id INTEGER
  REFERENCES mcp_llm_credential_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_llm_providers_credential_profile
  ON mcp_llm_providers (credential_profile_id)
  WHERE credential_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_agents_credential_profile
  ON mcp_agents (llm_credential_profile_id)
  WHERE llm_credential_profile_id IS NOT NULL;

COMMENT ON TABLE mcp_llm_credential_profiles IS
  'Reusable LLM credentials with provider compatibility, ownership metadata and monthly cost policy.';
COMMENT ON COLUMN mcp_llm_credential_profiles.api_key IS
  'Optional Argus-encrypted inline secret. Never returned by an API.';
COMMENT ON COLUMN mcp_llm_credential_profiles.secret_name IS
  'Optional environment or Vault secret reference resolved server-side.';
COMMENT ON COLUMN mcp_llm_credential_profiles.monthly_budget_usd IS
  'Monthly estimated spend threshold derived from native Argus agent telemetry.';
COMMENT ON COLUMN mcp_agents.llm_credential_profile_id IS
  'Optional agent-specific credential profile. Takes precedence over provider defaults.';
COMMENT ON COLUMN mcp_llm_providers.credential_profile_id IS
  'Optional reusable provider-default credential profile.';
