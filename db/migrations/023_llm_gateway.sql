-- Migration 023: LLM Gateway Phase 1 — Foundation
-- Model Registry, Virtual Key Extensions, Spend Logs

-- ============================================================
-- 1. Model Registry
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_models (
  id                SERIAL PRIMARY KEY,
  model_name        VARCHAR(128) NOT NULL,
  model_group       VARCHAR(128) NOT NULL DEFAULT 'default',
  provider          VARCHAR(32) NOT NULL,   -- openai | anthropic | azure | gemini | bedrock | vertex | ollama | vllm
  deployment_name   VARCHAR(128),            -- Azure deployment name
  api_base          TEXT,                    -- Custom base URL
  api_key           TEXT,                    -- Encrypted provider API key
  auth_type         VARCHAR(16) DEFAULT 'bearer', -- bearer | api_key | aws_sigv4 | gcp_oauth
  config            JSONB DEFAULT '{}',     -- Provider-specific config
  enabled           BOOLEAN DEFAULT true,
  max_input_tokens  INTEGER,                 -- Context window limit
  max_output_tokens INTEGER,
  input_cost_per_1k NUMERIC(12,8),           -- Pricing in USD
  output_cost_per_1k NUMERIC(12,8),
  tpm_limit         INTEGER,                 -- Tokens per minute limit
  rpm_limit         INTEGER,                 -- Requests per minute limit
  cooldown_seconds  INTEGER DEFAULT 60,      -- After failure cooldown
  timeout_ms        INTEGER DEFAULT 60000,  -- Request timeout
  weight            INTEGER DEFAULT 1,      -- For weighted routing
  "order"           INTEGER DEFAULT 0,     -- For prioritized failover
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_models_group ON mcp_models(model_group, enabled);
CREATE INDEX IF NOT EXISTS idx_mcp_models_provider ON mcp_models(provider, enabled);
CREATE INDEX IF NOT EXISTS idx_mcp_models_name ON mcp_models(model_name, enabled);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_mcp_models_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_models_updated_at ON mcp_models;
CREATE TRIGGER trg_mcp_models_updated_at
  BEFORE UPDATE ON mcp_models
  FOR EACH ROW EXECUTE FUNCTION update_mcp_models_updated_at();

-- ============================================================
-- 2. Virtual Key Extensions (extend mcp_api_keys)
-- ============================================================

ALTER TABLE mcp_api_keys
  ADD COLUMN IF NOT EXISTS gateway_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS allowed_models TEXT[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS denied_models TEXT[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS max_budget NUMERIC(16,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS budget_duration VARCHAR(16) DEFAULT '30d',
  ADD COLUMN IF NOT EXISTS current_spend NUMERIC(16,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spend_reset_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS tpm_limit INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS rpm_limit INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS max_parallel_requests INTEGER DEFAULT NULL;

-- ============================================================
-- 3. Spend Logs
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_spend_logs (
  id              BIGSERIAL PRIMARY KEY,
  api_key_prefix  VARCHAR(8) NOT NULL,
  model           VARCHAR(128) NOT NULL,
  provider        VARCHAR(32) NOT NULL,
  deployment_id   INTEGER REFERENCES mcp_models(id),
  request_type    VARCHAR(16) DEFAULT 'chat',  -- chat | embedding | image
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  total_tokens    INTEGER DEFAULT 0,
  cost            NUMERIC(16,8) DEFAULT 0,
  cache_hit       BOOLEAN DEFAULT false,
  duration_ms     INTEGER,
  is_error        BOOLEAN DEFAULT false,
  error_message   TEXT,
  request_id      VARCHAR(64),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spend_logs_key ON mcp_spend_logs(api_key_prefix, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spend_logs_model ON mcp_spend_logs(model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spend_logs_time ON mcp_spend_logs(created_at DESC);

COMMENT ON TABLE mcp_models IS 'LLM Model Registry for Gateway routing';
COMMENT ON TABLE mcp_spend_logs IS 'Per-request spend tracking for LLM Gateway';
