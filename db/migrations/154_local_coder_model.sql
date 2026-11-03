-- Give the Argus.Dev implementation worker its own local coding model.
-- Planner, knowledge and reviewer deliberately stay on argus-local so each
-- role can be tuned or replaced independently through the model registry.

DO $argus$
DECLARE
  local_provider_id integer;
BEGIN
  IF current_setting('argus.install_starter_agents', true) IS DISTINCT FROM 'true' THEN
    RAISE NOTICE 'Skipping optional local coder model';
    RETURN;
  END IF;

  SELECT id INTO local_provider_id
  FROM mcp_llm_providers
  WHERE name = 'litellm-local';

  IF local_provider_id IS NULL THEN
    RAISE NOTICE 'Skipping local coder model because litellm-local is not installed';
    RETURN;
  END IF;

  UPDATE mcp_models SET
    display_name = 'Argus Local Coder · Qwen 3.5 9B (16K)',
    provider = 'openai-compatible',
    provider_id = local_provider_id,
    upstream_model_name = 'argus-local-coder',
    model_group = 'coding',
    enabled = true,
    max_input_tokens = 16384,
    max_output_tokens = 2048,
    supports_tools = true,
    supports_reasoning = false,
    timeout_ms = 300000,
    updated_at = now()
  WHERE model_name = 'argus-local-coder';

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
      'argus-local-coder',
      'Argus Local Coder · Qwen 3.5 9B (16K)',
      'openai-compatible',
      local_provider_id,
      'argus-local-coder',
      'coding',
      true,
      16384,
      2048,
      true,
      false,
      300000
    );
  END IF;

  UPDATE mcp_agents
  SET model = 'argus-local-coder',
      max_tokens = GREATEST(max_tokens, 2048),
      updated_at = now()
  WHERE name = 'coder'
    AND model IN ('argus-local', 'argus-local-coder');
END
$argus$;
