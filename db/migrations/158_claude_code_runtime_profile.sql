-- Claude Code subscription runtime
--
-- This is a local CLI runtime, not an Anthropic API credential. The auth_ref
-- points to the protected Docker volume that contains the user's Claude Code
-- OAuth session; no token is stored in Argus.

ALTER TABLE mcp_agent_runtime_profiles
  DROP CONSTRAINT IF EXISTS mcp_agent_runtime_profiles_runtime_type_check,
  DROP CONSTRAINT IF EXISTS mcp_agent_runtime_profiles_auth_mode_check,
  DROP CONSTRAINT IF EXISTS agent_runtime_profile_auth_check;

ALTER TABLE mcp_agent_runtime_profiles
  ADD CONSTRAINT mcp_agent_runtime_profiles_runtime_type_check
    CHECK (runtime_type IN ('argus', 'codex', 'claude-code')),
  ADD CONSTRAINT mcp_agent_runtime_profiles_auth_mode_check
    CHECK (auth_mode IN ('none', 'chatgpt', 'claude_subscription', 'api_key', 'managed_access_token')),
  ADD CONSTRAINT agent_runtime_profile_auth_check CHECK (
    (runtime_type = 'argus' AND auth_mode = 'none') OR
    (runtime_type = 'codex' AND auth_mode IN ('chatgpt', 'api_key', 'managed_access_token')) OR
    (runtime_type = 'claude-code' AND auth_mode = 'claude_subscription')
  );

INSERT INTO mcp_agent_runtime_profiles
  (name, label, description, runtime_type, auth_mode, auth_ref, max_concurrent_runs, allowed_task_types)
VALUES
  ('claude-code-subscription-local', 'Claude Code · Claude Subscription', 'Official Claude Code CLI runtime using the local Claude.ai Pro/Max login in the claude-auth volume.', 'claude-code', 'claude_subscription', 'claude-auth', 1, ARRAY['implement_ticket', 'run_tests', 'plan', 'knowledge', 'review', 'inspect_pr'])
ON CONFLICT (name) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  runtime_type = EXCLUDED.runtime_type,
  auth_mode = EXCLUDED.auth_mode,
  auth_ref = EXCLUDED.auth_ref,
  allowed_task_types = EXCLUDED.allowed_task_types;
