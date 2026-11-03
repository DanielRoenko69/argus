-- Migration 111 — HNSW index for the semantic cache (P2.4).
--
-- mcp_semantic_cache.embedding is vector(1536), which is UNDER pgvector's
-- 2000-dim HNSW cap — but migration 041 created no vector index, so cache
-- lookups (`ORDER BY embedding <=> $q`) do a full-scan exact KNN. Add an HNSW
-- index for ANN-speed cosine lookups (matches the `<=>` cosine-distance operator
-- used in src/gateway/cache/semantic.ts → vector_cosine_ops).
--
-- NOTE: the semantic cache is opt-in (GATEWAY_SEMANTIC_CACHE=true); its table may
-- not exist yet. Guard on table existence so this migration is a safe no-op when
-- the feature has never been enabled. (The agent-memory table already uses
-- halfvec(3072) + its own HNSW index — see idx_agent_memory_embedding_hnsw.)
DO $$
BEGIN
  IF to_regclass('public.mcp_semantic_cache') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_semantic_cache_embedding_hnsw
      ON mcp_semantic_cache USING hnsw (embedding vector_cosine_ops);
  END IF;
END $$;
