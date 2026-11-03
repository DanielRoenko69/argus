-- Provider-neutral LLM connections and model catalog.
-- LiteLLM is represented as an OpenAI-compatible provider, never as a core dependency.

CREATE TABLE IF NOT EXISTS mcp_llm_providers (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(96) NOT NULL UNIQUE,
  label               VARCHAR(160) NOT NULL,
  provider_type       VARCHAR(32) NOT NULL
    CHECK (provider_type IN ('openai', 'anthropic', 'openai-compatible')),
  base_url            TEXT NOT NULL,
  auth_type           VARCHAR(24) NOT NULL DEFAULT 'bearer'
    CHECK (auth_type IN ('bearer', 'api-key', 'none')),
  api_key             TEXT,
  secret_name         VARCHAR(160),
  enabled             BOOLEAN NOT NULL DEFAULT true,
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_test_status    VARCHAR(24)
    CHECK (last_test_status IS NULL OR last_test_status IN ('healthy', 'failed')),
  last_tested_at      TIMESTAMPTZ,
  last_test_error     TEXT,
  created_by          INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_llm_providers_enabled
  ON mcp_llm_providers (enabled, provider_type, name);

CREATE OR REPLACE FUNCTION update_mcp_llm_providers_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_llm_providers_updated_at ON mcp_llm_providers;
CREATE TRIGGER trg_mcp_llm_providers_updated_at
  BEFORE UPDATE ON mcp_llm_providers
  FOR EACH ROW EXECUTE FUNCTION update_mcp_llm_providers_updated_at();

INSERT INTO mcp_llm_providers
  (name, label, provider_type, base_url, auth_type, secret_name)
VALUES
  ('openai-default', 'OpenAI', 'openai', 'https://api.openai.com/v1', 'bearer', 'OPENAI_API_KEY'),
  ('anthropic-default', 'Anthropic', 'anthropic', 'https://api.anthropic.com/v1', 'api-key', 'ANTHROPIC_API_KEY')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE mcp_models
  ADD COLUMN IF NOT EXISTS provider_id INTEGER REFERENCES mcp_llm_providers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS upstream_model_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS supports_tools BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS supports_reasoning BOOLEAN NOT NULL DEFAULT false;

UPDATE mcp_models model
   SET provider_id = provider.id
  FROM mcp_llm_providers provider
 WHERE model.provider_id IS NULL
   AND provider.name = CASE
     WHEN lower(model.provider) = 'anthropic' THEN 'anthropic-default'
     WHEN lower(model.provider) = 'openai' THEN 'openai-default'
     ELSE ''
   END;

UPDATE mcp_models
   SET display_name = COALESCE(display_name, model_name),
       upstream_model_name = COALESCE(upstream_model_name, deployment_name, model_name)
 WHERE display_name IS NULL OR upstream_model_name IS NULL;

-- Preserve existing loose agent assignments by making them first-class catalog entries.
INSERT INTO mcp_models
  (model_name, display_name, upstream_model_name, model_group, provider, provider_id,
   enabled, supports_vision, supports_tools, supports_reasoning)
SELECT DISTINCT
       agent.model,
       agent.model,
       agent.model,
       'agents',
       CASE WHEN agent.model ~* '^claude(?:-|$)' THEN 'anthropic' ELSE 'openai' END,
       provider.id,
       true,
       false,
       true,
       agent.model ~* '(reason|o[1-9]|gpt-5|opus)'
  FROM mcp_agents agent
  JOIN mcp_llm_providers provider
    ON provider.name = CASE WHEN agent.model ~* '^claude(?:-|$)'
      THEN 'anthropic-default' ELSE 'openai-default' END
 WHERE agent.model IS NOT NULL
   AND btrim(agent.model) <> ''
   AND NOT EXISTS (
     SELECT 1 FROM mcp_models existing WHERE existing.model_name=agent.model
   );

CREATE INDEX IF NOT EXISTS idx_mcp_models_provider_catalog
  ON mcp_models (provider_id, enabled, "order", model_name);

COMMENT ON TABLE mcp_llm_providers IS
  'Provider connections for direct OpenAI, direct Anthropic and optional OpenAI-compatible runtimes such as LiteLLM, Ollama or vLLM.';
COMMENT ON COLUMN mcp_llm_providers.api_key IS
  'Optional Argus-encrypted inline credential. Prefer secret_name with environment or Vault resolution.';
COMMENT ON COLUMN mcp_models.model_name IS
  'Stable Argus catalog alias referenced by agents and workflows.';
COMMENT ON COLUMN mcp_models.upstream_model_name IS
  'Provider-facing model or deployment identifier sent on the wire.';
