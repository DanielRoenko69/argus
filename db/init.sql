-- ============================================================
-- Argus Core - Complete Database Schema
-- ============================================================
-- Run this against the PostgreSQL database used by the MCP server.
-- Safe to re-run (uses IF NOT EXISTS / ON CONFLICT).
-- ============================================================

-- ============================================================
-- 0. Langfuse Database (separate DB in same Postgres)
-- ============================================================
-- Langfuse benötigt eine eigene Datenbank
-- Wird beim ersten Start automatisch erstellt
SELECT 'CREATE DATABASE langfuse'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langfuse')\gexec


-- ============================================================
-- 1. Dynamic Tools
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_tools (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(128) NOT NULL UNIQUE,
  description   TEXT NOT NULL,
  backend       VARCHAR(128) NOT NULL CHECK (backend IN ('postgresql', 'opensearch', 'http') OR backend LIKE 'custom:%' OR backend LIKE 'builtin:%'),
  query_template TEXT,
  parameters    JSONB NOT NULL DEFAULT '[]',
  enabled       BOOLEAN NOT NULL DEFAULT true,
  category      VARCHAR(64),
  tool_type     VARCHAR(16) NOT NULL DEFAULT 'dynamic' CHECK (tool_type IN ('builtin', 'dynamic')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE mcp_tools IS 'Dynamic MCP tool definitions - loaded by the Argus Core at runtime';

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_mcp_tools_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_tools_updated_at ON mcp_tools;
CREATE TRIGGER trg_mcp_tools_updated_at
  BEFORE UPDATE ON mcp_tools
  FOR EACH ROW EXECUTE FUNCTION update_mcp_tools_updated_at();


-- ============================================================
-- 2. Tool Versioning (history of changes)
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_tools_history (
  id              BIGSERIAL PRIMARY KEY,
  tool_id         INTEGER NOT NULL REFERENCES mcp_tools(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  description     TEXT NOT NULL,
  backend         VARCHAR(128) NOT NULL,
  -- query_template is nullable: trigger mirrors the live row, which can be
  -- NULL for non-SQL tools (remote-MCP, API-driven). See migration 051.
  query_template  TEXT,
  parameters      JSONB NOT NULL DEFAULT '[]',
  changed_by      VARCHAR(128),
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_tools_history_tool_id ON mcp_tools_history (tool_id, version DESC);

-- Trigger: save old version before update
CREATE OR REPLACE FUNCTION save_mcp_tool_version()
RETURNS TRIGGER AS $$
DECLARE
  next_ver INTEGER;
BEGIN
  SELECT COALESCE(MAX(version), 0) + 1 INTO next_ver
  FROM mcp_tools_history WHERE tool_id = OLD.id;

  INSERT INTO mcp_tools_history (tool_id, version, description, backend, query_template, parameters, changed_by)
  VALUES (OLD.id, next_ver, OLD.description, OLD.backend, OLD.query_template, OLD.parameters, current_user);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_tools_version ON mcp_tools;
CREATE TRIGGER trg_mcp_tools_version
  BEFORE UPDATE ON mcp_tools
  FOR EACH ROW EXECUTE FUNCTION save_mcp_tool_version();


-- ============================================================
-- 3. RBAC - API Key Permissions
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_api_keys (
  id            SERIAL PRIMARY KEY,
  key_prefix    VARCHAR(8) NOT NULL UNIQUE,
  label         VARCHAR(128) NOT NULL,
  allowed_tools TEXT[] DEFAULT NULL,
  denied_tools  TEXT[] DEFAULT NULL,
  allowed_backends TEXT[] DEFAULT NULL,
  allowed_bundles INTEGER[] DEFAULT NULL,
  key_hash      VARCHAR(64) DEFAULT NULL,
  key_suffix    VARCHAR(4) DEFAULT NULL,
  max_requests_per_minute INTEGER DEFAULT 120,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE mcp_api_keys IS 'Per-API-key RBAC rules. key_prefix is the first 8 chars of the key.';
COMMENT ON COLUMN mcp_api_keys.allowed_tools IS 'Whitelist of tool name patterns (NULL = all allowed). Supports SQL LIKE patterns.';
COMMENT ON COLUMN mcp_api_keys.denied_tools IS 'Blacklist of tool name patterns (NULL = none denied). Evaluated after allowed_tools.';
COMMENT ON COLUMN mcp_api_keys.allowed_backends IS 'Which backends this key can use (NULL = all). Values: kubernetes, grafana, opensearch, postgresql';
COMMENT ON COLUMN mcp_api_keys.allowed_bundles IS 'Service-Bundle IDs this key can access (NULL = all bundles allowed).';
COMMENT ON COLUMN mcp_api_keys.key_hash IS 'SHA-256 hash of the full API key (NULL for env-only keys)';
COMMENT ON COLUMN mcp_api_keys.key_suffix IS 'Last 4 characters of the key for display';
CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_hash ON mcp_api_keys (key_hash) WHERE key_hash IS NOT NULL;


-- ============================================================
-- 4. Audit Log
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
  api_key_prefix  VARCHAR(8),
  tool            VARCHAR(128) NOT NULL,
  parameters      JSONB,
  duration_ms     INTEGER,
  result_size     INTEGER,
  is_error        BOOLEAN DEFAULT false,
  error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_timestamp ON mcp_audit_log (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_tool ON mcp_audit_log (tool);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_api_key ON mcp_audit_log (api_key_prefix);


-- ============================================================
-- 5. Custom Backends (user-defined HTTP backends)
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_backends (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(64) NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  base_url      TEXT NOT NULL,
  auth_type     VARCHAR(16) NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'basic', 'header')),
  auth_value    TEXT,                              -- token, user:pass, or header value (stored encrypted in prod)
  health_path   VARCHAR(256) DEFAULT '/health',    -- path to check for reachability
  default_headers JSONB NOT NULL DEFAULT '{}',     -- extra headers sent with every request
  timeout_ms    INTEGER NOT NULL DEFAULT 10000,
  tls_skip_verify BOOLEAN NOT NULL DEFAULT false,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  backend_type  VARCHAR(8) NOT NULL DEFAULT 'http' CHECK (backend_type IN ('http', 'mcp', 'builtin')),
  mcp_endpoint  VARCHAR(256) DEFAULT NULL,         -- MCP endpoint path (e.g. /mcp), only for backend_type='mcp'
  builtin_key   VARCHAR(32) DEFAULT NULL,           -- unique key for builtin backends: kubernetes, grafana, opensearch, postgresql, meta
  config        JSONB NOT NULL DEFAULT '{}',        -- backend-specific config (e.g. K8s clusters)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE mcp_backends IS 'All backends (builtin, HTTP, remote MCP) managed via Dashboard.';
COMMENT ON COLUMN mcp_backends.auth_type IS 'none=no auth, bearer=Authorization: Bearer <token>, basic=Authorization: Basic <base64>, header=custom header from auth_value (format: Header-Name: value)';
COMMENT ON COLUMN mcp_backends.health_path IS 'HTTP GET path appended to base_url for health checks. NULL to skip.';
COMMENT ON COLUMN mcp_backends.backend_type IS 'http = custom REST backend, mcp = remote MCP server, builtin = built-in handler (K8s, Grafana, etc.)';
COMMENT ON COLUMN mcp_backends.mcp_endpoint IS 'MCP endpoint path appended to base_url (e.g. /mcp). Only used when backend_type=mcp.';
COMMENT ON COLUMN mcp_backends.builtin_key IS 'Unique identifier for builtin backend type: kubernetes, grafana, opensearch, postgresql, meta';
COMMENT ON COLUMN mcp_backends.config IS 'Backend-specific config JSONB (e.g. K8s cluster configs)';

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_backends_builtin_key
  ON mcp_backends (builtin_key) WHERE builtin_key IS NOT NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_mcp_backends_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_backends_updated_at ON mcp_backends;
CREATE TRIGGER trg_mcp_backends_updated_at
  BEFORE UPDATE ON mcp_backends
  FOR EACH ROW EXECUTE FUNCTION update_mcp_backends_updated_at();


-- ============================================================
-- 6. Remote MCP Tools (discovered from remote MCP servers)
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_remote_tools (
  id              SERIAL PRIMARY KEY,
  backend_id      INTEGER NOT NULL REFERENCES mcp_backends(id) ON DELETE CASCADE,
  tool_name       VARCHAR(256) NOT NULL,        -- original name on remote server
  prefixed_name   VARCHAR(256) NOT NULL UNIQUE,  -- namespaced: backendname_toolname
  description     TEXT DEFAULT '',
  input_schema    JSONB NOT NULL DEFAULT '{}',   -- JSON schema from listTools()
  discovered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_remote_tools_backend ON mcp_remote_tools (backend_id);

COMMENT ON TABLE mcp_remote_tools IS 'Cached tool metadata discovered from remote MCP servers. Re-populated on connect/refresh.';

CREATE OR REPLACE FUNCTION update_mcp_remote_tools_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_remote_tools_updated_at ON mcp_remote_tools;
CREATE TRIGGER trg_mcp_remote_tools_updated_at
  BEFORE UPDATE ON mcp_remote_tools
  FOR EACH ROW EXECUTE FUNCTION update_mcp_remote_tools_updated_at();


-- ============================================================
-- 7. Example Data
-- ============================================================

-- Example dynamic tools
INSERT INTO mcp_tools (name, description, backend, query_template, parameters, category) VALUES
(
  'dpost_get_document_status',
  'Get the processing status of a document by its ID',
  'postgresql',
  'SELECT document_id, status, received_at, processed_at, error_message FROM dpost_documents WHERE document_id = ''{{document_id}}'' LIMIT 1',
  '[{"name": "document_id", "type": "string", "description": "The unique document ID", "required": true}]',
  'Digitale Postverarbeitung'
),
(
  'dpost_list_processing_errors',
  'List recent document processing errors, optionally filtered by date',
  'postgresql',
  'SELECT document_id, error_message, failed_at, retry_count FROM dpost_documents WHERE status = ''error'' AND failed_at >= now() - interval ''{{hours}} hours'' ORDER BY failed_at DESC LIMIT {{limit}}',
  '[{"name": "hours", "type": "number", "description": "Look back N hours (default: 24)", "required": false, "default": "24"}, {"name": "limit", "type": "number", "description": "Max results (default: 50)", "required": false, "default": "50"}]',
  'Digitale Postverarbeitung'
),
(
  'dpost_queue_stats',
  'Get current queue statistics for document processing',
  'postgresql',
  'SELECT status, count(*) as count FROM dpost_documents WHERE received_at >= now() - interval ''{{hours}} hours'' GROUP BY status ORDER BY count DESC',
  '[{"name": "hours", "type": "number", "description": "Look back N hours (default: 24)", "required": false, "default": "24"}]',
  'Digitale Postverarbeitung'
),
(
  'logs_search_errors',
  'Search application error logs in OpenSearch',
  'opensearch',
  '{"bool": {"must": [{"match": {"level": "ERROR"}}, {"query_string": {"query": "{{search_query}}"}}], "filter": [{"range": {"@timestamp": {"gte": "now-{{hours}}h"}}}]}}',
  '[{"name": "search_query", "type": "string", "description": "Search query for error messages", "required": true}, {"name": "hours", "type": "number", "description": "Look back N hours (default: 24)", "required": false, "default": "24"}]',
  'Logging'
),
(
  'app_health_check',
  'Check if an internal HTTP service is responding',
  'http',
  'GET {{url}}/health',
  '[{"name": "url", "type": "string", "description": "Base URL of the service (e.g. http://my-service.namespace.svc.cluster.local:8080)", "required": true}]',
  'Service Health'
)
ON CONFLICT (name) DO NOTHING;

-- Example RBAC entry (all access)
INSERT INTO mcp_api_keys (key_prefix, label) VALUES
('changeme', 'Default admin key - replace with actual key prefix')
ON CONFLICT (key_prefix) DO NOTHING;


-- ============================================================
-- 8. Service Bundles (logical grouping of backends + tools)
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_service_bundles (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(128) NOT NULL UNIQUE,
  label       VARCHAR(256) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        VARCHAR(32) DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE mcp_service_bundles IS 'Logical grouping of backends and tools by application/service.';

CREATE OR REPLACE FUNCTION update_mcp_service_bundles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_service_bundles_updated_at ON mcp_service_bundles;
CREATE TRIGGER trg_mcp_service_bundles_updated_at
  BEFORE UPDATE ON mcp_service_bundles
  FOR EACH ROW EXECUTE FUNCTION update_mcp_service_bundles_updated_at();

-- Legacy: single bundle_id columns (kept for backwards compatibility)
ALTER TABLE mcp_backends ADD COLUMN IF NOT EXISTS bundle_id INTEGER REFERENCES mcp_service_bundles(id) ON DELETE SET NULL;
ALTER TABLE mcp_tools ADD COLUMN IF NOT EXISTS bundle_id INTEGER REFERENCES mcp_service_bundles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_backends_bundle ON mcp_backends (bundle_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_bundle ON mcp_tools (bundle_id);

-- ============================================================
-- 9. Many-to-Many: Backends/Tools ↔ Bundles (junction tables)
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_backend_bundles (
  backend_id  INTEGER NOT NULL REFERENCES mcp_backends(id) ON DELETE CASCADE,
  bundle_id   INTEGER NOT NULL REFERENCES mcp_service_bundles(id) ON DELETE CASCADE,
  PRIMARY KEY (backend_id, bundle_id)
);

CREATE TABLE IF NOT EXISTS mcp_tool_bundles (
  tool_id     INTEGER NOT NULL REFERENCES mcp_tools(id) ON DELETE CASCADE,
  bundle_id   INTEGER NOT NULL REFERENCES mcp_service_bundles(id) ON DELETE CASCADE,
  PRIMARY KEY (tool_id, bundle_id)
);

CREATE TABLE IF NOT EXISTS mcp_bundle_backend_tool_policies (
  backend_id         INTEGER NOT NULL,
  bundle_id          INTEGER NOT NULL,
  mode               VARCHAR(16) NOT NULL DEFAULT 'all' CHECK (mode IN ('all', 'selected')),
  allowed_tool_names TEXT[] NOT NULL DEFAULT '{}',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (backend_id, bundle_id),
  FOREIGN KEY (backend_id, bundle_id)
    REFERENCES mcp_backend_bundles(backend_id, bundle_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_backend_bundles_bundle ON mcp_backend_bundles (bundle_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_bundles_bundle ON mcp_tool_bundles (bundle_id);
CREATE INDEX IF NOT EXISTS idx_bundle_backend_tool_policies_bundle ON mcp_bundle_backend_tool_policies (bundle_id);


-- ============================================================
-- 10. User Authentication & Sessions
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_users (
  id              SERIAL PRIMARY KEY,
  username        VARCHAR(64) NOT NULL UNIQUE,
  password_hash   VARCHAR(256) NOT NULL,
  display_name    VARCHAR(128) NOT NULL DEFAULT '',
  role            VARCHAR(16) NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'editor', 'viewer')),
  allowed_bundles INTEGER[] DEFAULT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login      TIMESTAMPTZ
);

COMMENT ON COLUMN mcp_users.allowed_bundles IS 'Service-Bundle IDs this user can access (NULL = all bundles allowed).';

CREATE TABLE IF NOT EXISTS mcp_sessions (
  id            VARCHAR(64) PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES mcp_users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  ip_address    VARCHAR(45),
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_sessions_user ON mcp_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_expires ON mcp_sessions (expires_at);


-- ============================================================
-- 11. Metrics Persistence
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_metrics_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
  metric_name     VARCHAR(128) NOT NULL,
  metric_value    DOUBLE PRECISION NOT NULL,
  labels          JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_mcp_metrics_ts ON mcp_metrics_snapshots (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_metrics_name_ts ON mcp_metrics_snapshots (metric_name, timestamp DESC);

CREATE TABLE IF NOT EXISTS mcp_metrics_hourly (
  id              BIGSERIAL PRIMARY KEY,
  hour            TIMESTAMPTZ NOT NULL,
  metric_name     VARCHAR(128) NOT NULL,
  sum_value       DOUBLE PRECISION NOT NULL DEFAULT 0,
  count_value     INTEGER NOT NULL DEFAULT 0,
  min_value       DOUBLE PRECISION,
  max_value       DOUBLE PRECISION,
  avg_value       DOUBLE PRECISION,
  labels          JSONB DEFAULT '{}',
  UNIQUE (hour, metric_name, labels)
);

CREATE INDEX IF NOT EXISTS idx_mcp_metrics_hourly_ts ON mcp_metrics_hourly (hour DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_metrics_hourly_name ON mcp_metrics_hourly (metric_name, hour DESC);

CREATE TABLE IF NOT EXISTS mcp_server_events (
  id              BIGSERIAL PRIMARY KEY,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type      VARCHAR(32) NOT NULL CHECK (event_type IN ('start', 'stop', 'error')),
  details         JSONB DEFAULT '{}'
);


-- ============================================================
-- 12. Audit Log Enhancements
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_api_key_ts ON mcp_audit_log (api_key_prefix, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_error ON mcp_audit_log (is_error) WHERE is_error = true;
ALTER TABLE mcp_audit_log ADD COLUMN IF NOT EXISTS param_summary VARCHAR(256) DEFAULT NULL;


-- ============================================================
-- 13. Workflow Orchestration
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_workflows (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(128) NOT NULL UNIQUE,
  description   TEXT NOT NULL DEFAULT '',
  steps         JSONB NOT NULL DEFAULT '[]',
  input_params  JSONB NOT NULL DEFAULT '[]',
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_by    INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wf_name_format CHECK (name ~ '^[a-z0-9_]+$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_workflows_enabled ON mcp_workflows (enabled);

CREATE TABLE IF NOT EXISTS mcp_workflow_executions (
  id            BIGSERIAL PRIMARY KEY,
  workflow_id   INTEGER NOT NULL REFERENCES mcp_workflows(id) ON DELETE CASCADE,
  status        VARCHAR(16) NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  triggered_by  VARCHAR(128),
  input_args    JSONB NOT NULL DEFAULT '{}',
  step_results  JSONB NOT NULL DEFAULT '{}',
  error_message TEXT,
  duration_ms   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mcp_wf_exec_workflow ON mcp_workflow_executions (workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_wf_exec_status ON mcp_workflow_executions (status);

CREATE TABLE IF NOT EXISTS mcp_workflow_bundles (
  workflow_id INTEGER NOT NULL REFERENCES mcp_workflows(id) ON DELETE CASCADE,
  bundle_id   INTEGER NOT NULL REFERENCES mcp_service_bundles(id) ON DELETE CASCADE,
  PRIMARY KEY (workflow_id, bundle_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_workflow_bundles_bundle ON mcp_workflow_bundles (bundle_id);

CREATE OR REPLACE FUNCTION update_mcp_workflows_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_workflows_updated_at ON mcp_workflows;
CREATE TRIGGER trg_mcp_workflows_updated_at
  BEFORE UPDATE ON mcp_workflows
  FOR EACH ROW EXECUTE FUNCTION update_mcp_workflows_updated_at();

-- ── Agent Gateway (Migration 017) ────────────────────────────

-- ============================================================
-- Composites (Virtuelle Multi-Bundle Endpoints) — needed BEFORE mcp_agents
-- (FK reference). Originally added by migration 016 but inlined here so
-- a fresh DB boots cleanly via docker-entrypoint-initdb.d.
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_composites (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(128) NOT NULL UNIQUE,
  description         TEXT NOT NULL DEFAULT '',
  included_bundle_ids INTEGER[] NOT NULL DEFAULT '{}',
  tool_allow_patterns TEXT[] NOT NULL DEFAULT '{}',
  tool_deny_patterns  TEXT[] NOT NULL DEFAULT '{}',
  system_prompt       TEXT,
  agent_role          VARCHAR(128),
  enabled             BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT composite_name_format CHECK (name ~ '^[a-z0-9_-]+$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_composites_enabled ON mcp_composites (enabled);

CREATE TABLE IF NOT EXISTS mcp_agents (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(128) NOT NULL UNIQUE,
  label           VARCHAR(256) NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  model           VARCHAR(128) NOT NULL DEFAULT 'gpt-4o',
  temperature     NUMERIC(3,2) NOT NULL DEFAULT 0.7,
  max_tokens      INTEGER NOT NULL DEFAULT 4096,
  system_prompt   TEXT,
  agent_role      VARCHAR(128),
  composite_id    INTEGER REFERENCES mcp_composites(id) ON DELETE SET NULL,
  gitea_project   VARCHAR(256),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  max_iterations  INTEGER NOT NULL DEFAULT 10,
  created_by      INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_name_format CHECK (name ~ '^[a-z0-9_-]+$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_agents_enabled ON mcp_agents (enabled);

-- Migration: bundle_ids for agent-level RBAC
ALTER TABLE mcp_agents ADD COLUMN IF NOT EXISTS bundle_ids INTEGER[] DEFAULT NULL;

-- Migration: scope on API keys (mcp, agents, both)
ALTER TABLE mcp_api_keys ADD COLUMN IF NOT EXISTS scope VARCHAR(16) NOT NULL DEFAULT 'both';

CREATE TABLE IF NOT EXISTS mcp_rag_indexes (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(128) NOT NULL UNIQUE,
  label           VARCHAR(256) NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  provider        VARCHAR(32) NOT NULL DEFAULT 'pgvector',
  endpoint        TEXT NOT NULL,
  index_name      VARCHAR(128) NOT NULL,
  api_key         TEXT,
  semantic_config VARCHAR(128),
  adapter_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
  top_k           INTEGER NOT NULL DEFAULT 5,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rag_name_format CHECK (name ~ '^[a-z0-9_-]+$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_rag_indexes_enabled ON mcp_rag_indexes (enabled);

CREATE TABLE IF NOT EXISTS mcp_agent_rag_indexes (
  agent_id     INTEGER NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  rag_index_id INTEGER NOT NULL REFERENCES mcp_rag_indexes(id) ON DELETE CASCADE,
  priority     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, rag_index_id)
);

CREATE TABLE IF NOT EXISTS mcp_agent_sessions (
  id          VARCHAR(64) PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  messages    JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_agent_sessions_agent ON mcp_agent_sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_mcp_agent_sessions_user  ON mcp_agent_sessions (user_id);

CREATE OR REPLACE FUNCTION update_mcp_agents_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_agents_updated_at ON mcp_agents;
CREATE TRIGGER trg_mcp_agents_updated_at
  BEFORE UPDATE ON mcp_agents
  FOR EACH ROW EXECUTE FUNCTION update_mcp_agents_updated_at();

CREATE OR REPLACE FUNCTION update_mcp_rag_indexes_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_rag_indexes_updated_at ON mcp_rag_indexes;
CREATE TRIGGER trg_mcp_rag_indexes_updated_at
  BEFORE UPDATE ON mcp_rag_indexes
  FOR EACH ROW EXECUTE FUNCTION update_mcp_rag_indexes_updated_at();


-- ============================================================
-- Direct-provider model catalog and LLM usage history
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_models (
  id                SERIAL PRIMARY KEY,
  model_name        VARCHAR(128) NOT NULL,
  model_group       VARCHAR(128) NOT NULL DEFAULT 'default',
  provider          VARCHAR(32) NOT NULL,
  deployment_name   VARCHAR(128),
  api_base          TEXT,
  api_key           TEXT,
  auth_type         VARCHAR(16) DEFAULT 'bearer',
  config            JSONB DEFAULT '{}',
  enabled           BOOLEAN DEFAULT true,
  max_input_tokens  INTEGER,
  max_output_tokens INTEGER,
  input_cost_per_1k NUMERIC(12,8),
  output_cost_per_1k NUMERIC(12,8),
  tpm_limit         INTEGER,
  rpm_limit         INTEGER,
  cooldown_seconds  INTEGER DEFAULT 60,
  timeout_ms        INTEGER DEFAULT 60000,
  weight            INTEGER DEFAULT 1,
  "order"           INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_models_group ON mcp_models(model_group, enabled);
CREATE INDEX IF NOT EXISTS idx_mcp_models_provider ON mcp_models(provider, enabled);
CREATE INDEX IF NOT EXISTS idx_mcp_models_name ON mcp_models(model_name, enabled);

CREATE OR REPLACE FUNCTION update_mcp_models_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_models_updated_at ON mcp_models;
CREATE TRIGGER trg_mcp_models_updated_at
  BEFORE UPDATE ON mcp_models
  FOR EACH ROW EXECUTE FUNCTION update_mcp_models_updated_at();

CREATE TABLE IF NOT EXISTS mcp_spend_logs (
  id              BIGSERIAL PRIMARY KEY,
  api_key_prefix  VARCHAR(8) NOT NULL,
  model           VARCHAR(128) NOT NULL,
  provider        VARCHAR(32) NOT NULL,
  deployment_id   INTEGER REFERENCES mcp_models(id),
  request_type    VARCHAR(16) DEFAULT 'chat',
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

COMMENT ON TABLE mcp_models IS 'Provider-neutral model catalog for direct LLM clients';
COMMENT ON TABLE mcp_spend_logs IS 'Historical LLM usage and cost data';
