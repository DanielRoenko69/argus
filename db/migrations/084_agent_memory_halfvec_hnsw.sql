-- Migration 084: Switch mcp_agent_memory.embedding to halfvec + HNSW index
--
-- pgvector 0.7+ supports halfvec (FP16) with HNSW up to 4000 dimensions.
-- The original Mig 048 commented that HNSW was impossible at 3072 dims —
-- this was true for plain `vector` but halfvec lifts the limit.
--
-- Benefit:
--   • Storage: 50 % weniger (4 Bytes/dim → 2 Bytes/dim)
--   • Query: HNSW statt full sequential scan → 5-10× schneller bei >1k Rows
--   • Precision: marginaler Loss (FP16 → cosine_similarity bleibt im
--     Wesentlichen identisch für Embeddings, die in [-1, 1] normalisiert sind)
--
-- Compatibility: pg driver schreibt/liest halfvec mit demselben JSON-array-
-- Wire-Format wie vector. Argus-Code in memory.ts braucht KEINE Änderung.
--
-- Atomicity: ALTER COLUMN TYPE blockt nur kurz (Table-Rewrite for 752 rows
-- in dev = millisecond). Bei großen Tabellen (>100k) erst staging, dann
-- pg_repack-style.

-- 1. Spalte konvertieren (verlustfrei für unsere Embeddings)
ALTER TABLE mcp_agent_memory
  ALTER COLUMN embedding TYPE halfvec(3072)
  USING embedding::halfvec(3072);

-- 2. HNSW-Index: m=16, ef_construction=64 sind solide Defaults für Cosine
--    Bei <10k Rows ist Build-Time negligible
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding_hnsw
  ON mcp_agent_memory
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 3. ANALYZE damit Planner den neuen Index nutzt
ANALYZE mcp_agent_memory;

COMMENT ON INDEX idx_agent_memory_embedding_hnsw IS
  'HNSW on halfvec(3072) — enables fast cosine ANN at 3072d (vs Mig 048 full scan)';
