CREATE EXTENSION IF NOT EXISTS vector;

-- mcp_semantic_cache: TTL-aware embeddings cache for chat-completions.
-- expires_at is maintained by a BEFORE INSERT/UPDATE trigger (rather than a
-- GENERATED STORED column) because PostgreSQL 16's `INT * interval` is not
-- IMMUTABLE and therefore rejected from generation expressions.
CREATE TABLE IF NOT EXISTS mcp_semantic_cache (
  id          BIGSERIAL PRIMARY KEY,
  model       VARCHAR(128) NOT NULL,
  query_text  TEXT NOT NULL,
  embedding   VECTOR(1536),
  response    JSONB NOT NULL,
  hit_count   INTEGER DEFAULT 0,
  ttl_seconds INTEGER DEFAULT 3600,
  created_at  TIMESTAMPTZ DEFAULT now(),
  expires_at  TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION mcp_semantic_cache_set_expires_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.expires_at := COALESCE(NEW.created_at, now()) + make_interval(secs => NEW.ttl_seconds);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_semantic_cache_expires_at ON mcp_semantic_cache;
CREATE TRIGGER trg_mcp_semantic_cache_expires_at
  BEFORE INSERT OR UPDATE OF ttl_seconds, created_at ON mcp_semantic_cache
  FOR EACH ROW EXECUTE FUNCTION mcp_semantic_cache_set_expires_at();

CREATE INDEX IF NOT EXISTS idx_semantic_cache_expires ON mcp_semantic_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_semantic_cache_model ON mcp_semantic_cache(model);
