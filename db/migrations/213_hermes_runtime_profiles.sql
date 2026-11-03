-- Hermes runtime profiles
--
-- Hermes remains a Solution Pack-owned runtime adapter. Core stores only the
-- stable adapter binding and execution policy; endpoints and credentials stay
-- in Solution Pack discovery/secrets.

ALTER TABLE mcp_agent_runtime_profiles
  DROP CONSTRAINT IF EXISTS mcp_agent_runtime_profiles_runtime_type_check,
  DROP CONSTRAINT IF EXISTS mcp_agent_runtime_profiles_auth_mode_check,
  DROP CONSTRAINT IF EXISTS agent_runtime_profile_auth_check;

ALTER TABLE mcp_agent_runtime_profiles
  ADD CONSTRAINT mcp_agent_runtime_profiles_runtime_type_check
    CHECK (runtime_type IN ('argus', 'codex', 'claude-code', 'hermes')),
  ADD CONSTRAINT mcp_agent_runtime_profiles_auth_mode_check
    CHECK (auth_mode IN ('none', 'chatgpt', 'claude_subscription', 'api_key', 'managed_access_token', 'runtime_adapter')),
  ADD CONSTRAINT agent_runtime_profile_auth_check CHECK (
    (runtime_type = 'argus' AND auth_mode = 'none') OR
    (runtime_type = 'codex' AND auth_mode IN ('chatgpt', 'api_key', 'managed_access_token')) OR
    (runtime_type = 'claude-code' AND auth_mode = 'claude_subscription') OR
    (runtime_type = 'hermes' AND auth_mode = 'runtime_adapter')
  );

CREATE TABLE IF NOT EXISTS mcp_runtime_adapter_profiles (
  runtime_profile_id  INTEGER PRIMARY KEY
                      REFERENCES mcp_agent_runtime_profiles(id) ON DELETE CASCADE,
  pack_id             VARCHAR(128) NOT NULL,
  adapter_id          VARCHAR(128) NOT NULL,
  execution_strategy VARCHAR(16) NOT NULL DEFAULT 'attached'
                      CHECK (execution_strategy IN ('attached', 'managed', 'auto')),
  credential_ref      VARCHAR(255),
  native_profile_ref  VARCHAR(255),
  workspace_policy    VARCHAR(24) NOT NULL DEFAULT 'context_only'
                      CHECK (workspace_policy IN ('context_only', 'checkout', 'isolated_worktree')),
  memory_policy       VARCHAR(24) NOT NULL DEFAULT 'none'
                      CHECK (memory_policy IN ('none', 'read_context', 'propose_write')),
  native_tool_policy  VARCHAR(32) NOT NULL DEFAULT 'external_attested'
                      CHECK (native_tool_policy IN ('disabled', 'external_attested', 'managed_mcp_only')),
  session_policy      VARCHAR(24) NOT NULL DEFAULT 'clean'
                      CHECK (session_policy IN ('clean', 'resume_project', 'resume_explicit')),
  config              JSONB NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(config) = 'object'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT runtime_adapter_profile_pack_format
    CHECK (pack_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'),
  CONSTRAINT runtime_adapter_profile_adapter_format
    CHECK (adapter_id ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$')
);

CREATE OR REPLACE FUNCTION update_mcp_runtime_adapter_profiles_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_runtime_adapter_profiles_updated_at ON mcp_runtime_adapter_profiles;
CREATE TRIGGER trg_mcp_runtime_adapter_profiles_updated_at
  BEFORE UPDATE ON mcp_runtime_adapter_profiles
  FOR EACH ROW EXECUTE FUNCTION update_mcp_runtime_adapter_profiles_updated_at();

INSERT INTO mcp_agent_runtime_profiles
  (name, label, description, runtime_type, auth_mode, auth_ref, model,
   max_concurrent_runs, allowed_task_types, code_context_mode)
VALUES
  ('hermes-attached-local', 'Hermes · Existing service',
   'Attached Hermes runtime through the argus.hermes adapter. External tools remain externally governed; Core tools and writes require managed mode.',
   'hermes', 'runtime_adapter', 'argus.hermes/hermes-http', 'hermes-upstream',
   1, ARRAY['chat'], 'metadata_only')
ON CONFLICT (name) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  runtime_type = EXCLUDED.runtime_type,
  auth_mode = EXCLUDED.auth_mode,
  auth_ref = EXCLUDED.auth_ref,
  model = EXCLUDED.model,
  max_concurrent_runs = EXCLUDED.max_concurrent_runs,
  allowed_task_types = EXCLUDED.allowed_task_types,
  code_context_mode = EXCLUDED.code_context_mode;

INSERT INTO mcp_runtime_adapter_profiles
  (runtime_profile_id, pack_id, adapter_id, execution_strategy, credential_ref,
   workspace_policy, memory_policy, native_tool_policy, session_policy)
SELECT id, 'argus.hermes', 'hermes-http', 'attached', 'pack-service-token',
       'context_only', 'none', 'external_attested', 'clean'
  FROM mcp_agent_runtime_profiles
 WHERE name = 'hermes-attached-local'
ON CONFLICT (runtime_profile_id) DO UPDATE SET
  pack_id = EXCLUDED.pack_id,
  adapter_id = EXCLUDED.adapter_id,
  execution_strategy = EXCLUDED.execution_strategy,
  credential_ref = EXCLUDED.credential_ref,
  workspace_policy = EXCLUDED.workspace_policy,
  memory_policy = EXCLUDED.memory_policy,
  native_tool_policy = EXCLUDED.native_tool_policy,
  session_policy = EXCLUDED.session_policy;

COMMENT ON TABLE mcp_runtime_adapter_profiles IS
  'Non-secret Solution Pack runtime adapter bindings and Core-owned execution policies.';
COMMENT ON COLUMN mcp_runtime_adapter_profiles.credential_ref IS
  'Non-secret reference only. Adapter credentials remain in Solution Pack discovery/secrets.';
COMMENT ON COLUMN mcp_runtime_adapter_profiles.native_tool_policy IS
  'Trust boundary for native runtime tools; external_attested must never be represented as Core-governed.';
