-- Migration 120: pgvector-backed Knowledge Base (uploaded docs → chunks → embeddings).
CREATE TABLE IF NOT EXISTS mcp_kb_documents (
  id           BIGSERIAL PRIMARY KEY,
  rag_index_id INTEGER NOT NULL REFERENCES mcp_rag_indexes(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  char_count   INTEGER NOT NULL,
  chunk_count  INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mcp_kb_chunks (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT  NOT NULL REFERENCES mcp_kb_documents(id) ON DELETE CASCADE,
  rag_index_id INTEGER NOT NULL REFERENCES mcp_rag_indexes(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  content      TEXT NOT NULL,
  embedding    halfvec(3072)
);
-- text-embedding-3-large is 3072-dim. Plain `vector` ANN indexes cap at 2000 dims, but pgvector 0.7+
-- supports halfvec (FP16) with HNSW up to 4000 dims — the same approach migration 084 took for
-- mcp_agent_memory (and 111 for the semantic cache). The pg driver writes/reads halfvec with the same
-- JSON-array wire format as vector, so ingest/search keep their `$::vector` casts unchanged.
CREATE INDEX IF NOT EXISTS idx_kb_chunks_index ON mcp_kb_chunks(rag_index_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding_hnsw
  ON mcp_kb_chunks USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
