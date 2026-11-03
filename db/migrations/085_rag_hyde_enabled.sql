-- Migration 085: HyDE-Enable-Flag pro RAG-Index
--
-- HyDE (Hypothetical Document Embeddings) ist ein RAG-Pattern: vor der
-- Vector-Search generiert ein kleines LLM ein fiktives Antwort-Dokument
-- für die Query; das Embedding davon wird gesucht. Hebt Recall bei
-- sparse Queries deutlich, kostet ~1 Cent extra/Query.
--
-- Aktivierung erfolgt PRO RAG-Index, weil:
--   - Code-RAG funktioniert auch ohne HyDE gut (Tools haben präzise Namen)
--   - Confluence-/Sharepoint-RAG mit Free-Text-Queries profitiert
--   - Cost-Control: nicht alle Indizes brauchen das

ALTER TABLE mcp_rag_indexes
  ADD COLUMN IF NOT EXISTS hyde_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN mcp_rag_indexes.hyde_enabled IS
  'HyDE: vor Vector-Search ein Pseudo-Antwort-Dokument generieren, dessen Embedding suchen. Aktivieren für Free-Text-Indizes.';
