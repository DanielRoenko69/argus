-- Optional Argus Dev worker runtime backed by the managed argus.hermes
-- adapter. Argus Dev remains the workspace/workflow owner; the profile only
-- delegates one bounded worker or reviewer turn through runtime MCP.

INSERT INTO mcp_agent_runtime_profiles
  (name, label, description, runtime_type, auth_mode, auth_ref, model,
   max_concurrent_runs, allowed_task_types, code_context_mode)
VALUES
  ('hermes-managed-dev', 'Hermes · Managed Dev worker',
   'Optional isolated Hermes worker for Argus Dev. Argus retains workspace, tests, Git, PR, telemetry and approval ownership.',
   'hermes', 'runtime_adapter', 'argus.hermes/hermes-http', 'hermes-upstream',
   1, ARRAY['plan', 'knowledge', 'implement_ticket', 'run_tests', 'review', 'fix_pr', 'fix_ci', 'fix_security'],
   'metadata_only')
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
SELECT id, 'argus.hermes', 'hermes-http', 'managed', 'pack-service-token',
       'checkout', 'propose_write', 'managed_mcp_only', 'clean'
  FROM mcp_agent_runtime_profiles
 WHERE name = 'hermes-managed-dev'
ON CONFLICT (runtime_profile_id) DO UPDATE SET
  pack_id = EXCLUDED.pack_id,
  adapter_id = EXCLUDED.adapter_id,
  execution_strategy = EXCLUDED.execution_strategy,
  credential_ref = EXCLUDED.credential_ref,
  workspace_policy = EXCLUDED.workspace_policy,
  memory_policy = EXCLUDED.memory_policy,
  native_tool_policy = EXCLUDED.native_tool_policy,
  session_policy = EXCLUDED.session_policy;
