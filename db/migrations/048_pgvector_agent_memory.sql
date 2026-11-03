-- db/migrations/048_pgvector_agent_memory.sql

-- Enable pgvector extension (requires pgvector installed in PostgreSQL image)
CREATE EXTENSION IF NOT EXISTS vector;

-- Cross-session agent memory store
-- Dimensions set to 3072 for text-embedding-3-large.
-- Note: pgvector HNSW/IVFFlat indexes are capped at 2000 dims; exact cosine search is used instead.
CREATE TABLE IF NOT EXISTS mcp_agent_memory (
  id               SERIAL PRIMARY KEY,
  agent_id         INTEGER      NOT NULL REFERENCES mcp_agents(id) ON DELETE CASCADE,
  session_id       VARCHAR(128),
  content          TEXT         NOT NULL,
  embedding        vector(3072),
  memory_type      VARCHAR(32)  NOT NULL DEFAULT 'fact',
  importance       REAL         NOT NULL DEFAULT 0.5,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  access_count     INTEGER      NOT NULL DEFAULT 0
);

-- No ANN index for embedding: pgvector HNSW/IVFFlat are limited to 2000 dims.
-- Exact cosine search (sequential scan) is used, which is acceptable for typical memory table sizes.

CREATE INDEX IF NOT EXISTS idx_agent_memory_agent
  ON mcp_agent_memory(agent_id);
