-- Migration 017: Agent Gateway
-- Zentrale Agents, RAG Indexes und Sessions für den Argus Agent Gateway.

-- Agents
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

-- RAG Indexes (Azure AI Search)
CREATE TABLE IF NOT EXISTS mcp_rag_indexes (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(128) NOT NULL UNIQUE,
  label           VARCHAR(256) NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  provider        VARCHAR(32) NOT NULL DEFAULT 'azure_ai_search',
  endpoint        TEXT NOT NULL,
  index_name      VARCHAR(128) NOT NULL,
  api_key         TEXT,
  semantic_config VARCHAR(128),
  top_k           INTEGER NOT NULL DEFAULT 5,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rag_name_format CHECK (name ~ '^[a-z0-9_-]+$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_rag_indexes_enabled ON mcp_rag_indexes (enabled);

-- Agent <-> RAG junction
CREATE TABLE IF NOT EXISTS mcp_agent_rag_indexes (
  agent_id     INTEGER NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  rag_index_id INTEGER NOT NULL REFERENCES mcp_rag_indexes(id) ON DELETE CASCADE,
  priority     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, rag_index_id)
);

-- Agent sessions (conversation history)
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

-- Triggers for updated_at
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

COMMENT ON TABLE mcp_agents IS 'AI Agents mit Modell, System Prompt, Composite-Tools und RAG-Verknüpfungen.';
COMMENT ON TABLE mcp_rag_indexes IS 'Azure AI Search Indexes für RAG-Funktionalität in Agents.';
COMMENT ON TABLE mcp_agent_sessions IS 'Chat-Sessions mit Nachrichtenverlauf pro Agent.';
