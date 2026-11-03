-- Argus Knowledge uses the built-in PostgreSQL + pgvector store by default.
-- Existing sources retain their explicitly stored provider.
ALTER TABLE mcp_rag_indexes
  ALTER COLUMN provider SET DEFAULT 'pgvector';
