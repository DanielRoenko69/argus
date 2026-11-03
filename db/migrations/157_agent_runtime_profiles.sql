-- Agent runtime profiles
--
-- Runtime profiles select the execution engine for an Agent. This is
-- deliberately separate from mcp_llm_credential_profiles: a ChatGPT
-- subscription login is an interactive Codex runtime credential and must
-- never be copied into an API-key table or returned by the control plane.

CREATE TABLE IF NOT EXISTS mcp_agent_runtime_profiles (
  id                    SERIAL PRIMARY KEY,
  name                  VARCHAR(96) NOT NULL UNIQUE,
  label                 VARCHAR(160) NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  runtime_type          VARCHAR(32) NOT NULL
                        CHECK (runtime_type IN ('argus', 'codex')),
  auth_mode             VARCHAR(32) NOT NULL DEFAULT 'none'
                        CHECK (auth_mode IN ('none', 'chatgpt', 'api_key', 'managed_access_token')),
  auth_ref              VARCHAR(160),
  enabled               BOOLEAN NOT NULL DEFAULT true,
  max_concurrent_runs   INTEGER NOT NULL DEFAULT 1
                        CHECK (max_concurrent_runs BETWEEN 1 AND 32),
  allowed_task_types    TEXT[] NOT NULL DEFAULT '{}',
  created_by            INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_runtime_profile_name_format CHECK (name ~ '^[a-z0-9][a-z0-9_-]*$'),
  CONSTRAINT agent_runtime_profile_auth_check CHECK (
    (runtime_type = 'argus' AND auth_mode = 'none') OR
    (runtime_type = 'codex' AND auth_mode IN ('chatgpt', 'api_key', 'managed_access_token'))
  )
);

CREATE INDEX IF NOT EXISTS idx_mcp_agent_runtime_profiles_enabled
  ON mcp_agent_runtime_profiles (enabled, runtime_type, label);

CREATE OR REPLACE FUNCTION update_mcp_agent_runtime_profiles_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_agent_runtime_profiles_updated_at ON mcp_agent_runtime_profiles;
CREATE TRIGGER trg_mcp_agent_runtime_profiles_updated_at
  BEFORE UPDATE ON mcp_agent_runtime_profiles
  FOR EACH ROW EXECUTE FUNCTION update_mcp_agent_runtime_profiles_updated_at();

ALTER TABLE mcp_agents
  ADD COLUMN IF NOT EXISTS runtime_profile_id INTEGER
  REFERENCES mcp_agent_runtime_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_agents_runtime_profile
  ON mcp_agents (runtime_profile_id)
  WHERE runtime_profile_id IS NOT NULL;

-- The Argus API/LiteLLM path remains the default. The Codex profile is
-- opt-in and only points to the Docker auth volume name, never to a token.
INSERT INTO mcp_agent_runtime_profiles
  (name, label, description, runtime_type, auth_mode, auth_ref, max_concurrent_runs, allowed_task_types)
VALUES
  ('argus-default', 'Argus / LiteLLM', 'Provider-neutral API and local-model runtime.', 'argus', 'none', NULL, 8, '{}'),
  ('codex-subscription-local', 'Codex · ChatGPT Subscription', 'Official Codex SDK runtime using the local ChatGPT login in the codex-auth volume.', 'codex', 'chatgpt', 'codex-auth', 1, ARRAY['implement_ticket', 'run_tests'])
ON CONFLICT (name) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  runtime_type = EXCLUDED.runtime_type,
  auth_mode = EXCLUDED.auth_mode,
  auth_ref = EXCLUDED.auth_ref,
  allowed_task_types = EXCLUDED.allowed_task_types;

COMMENT ON TABLE mcp_agent_runtime_profiles IS
  'Execution runtime assignments for agents. Contains references only; never stores provider or ChatGPT subscription tokens.';
COMMENT ON COLUMN mcp_agent_runtime_profiles.auth_ref IS
  'Non-secret runtime reference, e.g. Docker named volume or secret-manager object name.';
COMMENT ON COLUMN mcp_agents.runtime_profile_id IS
  'Optional execution runtime override. NULL inherits the deployment default runtime.';
