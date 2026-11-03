-- 054: optional vector field for Azure AI Search hybrid (vector + keyword)
--
-- Azure AI Search supports hybrid search natively when both `search` (keyword
-- BM25) and `vectorQueries` are sent in the same request. To enable this we
-- need to know the name of the vector field on the Azure index — it's not
-- standardised across customer indexes (could be `contentVector`, `embedding`,
-- `text_vector`, etc.).
--
-- - vector_field NULL → keyword-only Azure search (current behaviour)
-- - vector_field set  → searchAzureAISearch generates the query embedding
--                       and adds it as a vectorQueries entry, kicking off
--                       hybrid retrieval inside Azure (returns RRF-fused
--                       results in the same response).
--
-- Qdrant is unaffected — it's already vector-only and our wrapper handles
-- it identically.

ALTER TABLE mcp_rag_indexes
  ADD COLUMN IF NOT EXISTS vector_field VARCHAR(128);

COMMENT ON COLUMN mcp_rag_indexes.vector_field IS
  'Azure AI Search only: name of the vector field on the index (e.g., "contentVector"). When set, the search becomes hybrid (BM25 + vector). NULL = keyword-only.';
