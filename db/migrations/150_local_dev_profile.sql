-- Migration 150: optional, secret-free local development profile.
--
-- This profile is installed only when ARGUS_INSTALL_STARTER_AGENTS=true.
-- It reproduces the local Ollama -> LiteLLM setup used for Argus.Dev E2E
-- testing without persisting a LiteLLM key in PostgreSQL.

DO $argus$
DECLARE
  local_provider_id integer;
  readonly_composite_id integer;
  workspace_composite_id integer;
BEGIN
  IF current_setting('argus.install_starter_agents', true) IS DISTINCT FROM 'true' THEN
    RAISE NOTICE 'Skipping optional local development profile';
    RETURN;
  END IF;

  INSERT INTO mcp_llm_providers (
    name,
    label,
    provider_type,
    base_url,
    auth_type,
    api_key,
    secret_name,
    enabled,
    config
  ) VALUES (
    'litellm-local',
    'Local LiteLLM',
    'openai-compatible',
    'http://litellm:4000/v1',
    'bearer',
    NULL,
    'ARGUS_LITELLM_API_KEY',
    true,
    '{}'::jsonb
  )
  ON CONFLICT (name) DO UPDATE SET
    label = EXCLUDED.label,
    provider_type = EXCLUDED.provider_type,
    base_url = EXCLUDED.base_url,
    auth_type = EXCLUDED.auth_type,
    api_key = NULL,
    secret_name = EXCLUDED.secret_name,
    enabled = EXCLUDED.enabled,
    config = EXCLUDED.config
  RETURNING id INTO local_provider_id;

  UPDATE mcp_models SET
    display_name = 'Argus Local · Granite 3.3 2B',
    provider = 'openai-compatible',
    provider_id = local_provider_id,
    upstream_model_name = 'argus-local',
    model_group = 'default',
    enabled = true,
    max_input_tokens = 8192,
    max_output_tokens = 2048,
    supports_tools = true,
    supports_reasoning = false,
    timeout_ms = 300000,
    updated_at = now()
  WHERE model_name = 'argus-local';

  IF NOT FOUND THEN
    INSERT INTO mcp_models (
      model_name,
      display_name,
      provider,
      provider_id,
      upstream_model_name,
      model_group,
      enabled,
      max_input_tokens,
      max_output_tokens,
      supports_tools,
      supports_reasoning,
      timeout_ms
    ) VALUES (
      'argus-local',
      'Argus Local · Granite 3.3 2B',
      'openai-compatible',
      local_provider_id,
      'argus-local',
      'default',
      true,
      8192,
      2048,
      true,
      false,
      300000
    );
  END IF;

  INSERT INTO mcp_composites (
    name,
    description,
    included_bundle_ids,
    tool_allow_patterns,
    tool_deny_patterns,
    enabled
  ) VALUES (
    'argus_dev_local_readonly',
    'Minimal local-inference profile for planning, knowledge and review roles.',
    '{}'::integer[],
    ARRAY['__argus_dev_no_tools__']::text[],
    '{}'::text[],
    true
  )
  ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    included_bundle_ids = EXCLUDED.included_bundle_ids,
    tool_allow_patterns = EXCLUDED.tool_allow_patterns,
    tool_deny_patterns = EXCLUDED.tool_deny_patterns,
    enabled = EXCLUDED.enabled
  RETURNING id INTO readonly_composite_id;

  INSERT INTO mcp_composites (
    name,
    description,
    included_bundle_ids,
    tool_allow_patterns,
    tool_deny_patterns,
    enabled
  ) VALUES (
    'argus_dev_local_workspace',
    'Workspace-only local-inference profile for the coding role.',
    '{}'::integer[],
    ARRAY['workspace_*']::text[],
    '{}'::text[],
    true
  )
  ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    included_bundle_ids = EXCLUDED.included_bundle_ids,
    tool_allow_patterns = EXCLUDED.tool_allow_patterns,
    tool_deny_patterns = EXCLUDED.tool_deny_patterns,
    enabled = EXCLUDED.enabled
  RETURNING id INTO workspace_composite_id;

  UPDATE mcp_agents SET
    model = 'argus-local',
    max_tokens = 4000,
    max_iterations = 8,
    agent_mode = 'chat',
    updated_at = now()
  WHERE name = 'researcher';

  UPDATE mcp_agents SET
    model = 'argus-local',
    temperature = 0.10,
    max_tokens = 384,
    max_iterations = 30,
    agent_mode = 'worker',
    composite_id = workspace_composite_id,
    updated_at = now()
  WHERE name = 'coder';

  UPDATE mcp_agents SET
    model = 'argus-local',
    temperature = 0.30,
    max_tokens = 128,
    max_iterations = 15,
    agent_mode = 'chat',
    composite_id = readonly_composite_id,
    updated_at = now()
  WHERE name = 'planner';

  UPDATE mcp_agents SET
    model = 'argus-local',
    temperature = 0.20,
    max_tokens = 384,
    max_iterations = 10,
    agent_mode = 'reviewer',
    composite_id = readonly_composite_id,
    updated_at = now()
  WHERE name = 'reviewer';

  UPDATE mcp_agents SET
    model = 'argus-local',
    temperature = 0.30,
    max_tokens = 128,
    max_iterations = 10,
    agent_mode = 'chat',
    composite_id = readonly_composite_id,
    updated_at = now()
  WHERE name = 'knowledge';
END
$argus$;
