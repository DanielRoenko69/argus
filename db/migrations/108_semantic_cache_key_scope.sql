-- Audit G1 — scope the semantic cache per API key.
--
-- mcp_semantic_cache (migration 041) was keyed only on (model, embedding
-- similarity). A response generated for key A — which can embed key-A system
-- prompts, bound skills, or previously-masked content — was served verbatim to
-- ANY other key B asking a semantically similar question: a cross-key/tenant
-- data leak that also bypasses per-key model/guardrail scoping.
--
-- Add an api_key_prefix column; semanticCacheGet/Set now filter+store on it, so
-- a cache entry is only ever returned to the key that created it. Pre-existing
-- rows have NULL prefix and simply become unreachable (they expire via TTL).
-- Guard on table existence: mcp_semantic_cache is created by migration 041, but
-- on a DB where 041 was baselined-skipped (semantic cache never provisioned) the
-- table is absent — without this guard the ALTER would fail and (with the
-- stop-on-first-failure runner) halt all later migrations. No-op when absent;
-- on such a DB the semantic cache isn't functional anyway.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'mcp_semantic_cache'
  ) THEN
    ALTER TABLE mcp_semantic_cache ADD COLUMN IF NOT EXISTS api_key_prefix text;
    CREATE INDEX IF NOT EXISTS idx_semantic_cache_model_key
      ON mcp_semantic_cache (model, api_key_prefix);
  END IF;
END $$;
