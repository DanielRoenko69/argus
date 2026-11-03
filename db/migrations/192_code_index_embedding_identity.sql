-- The same immutable code graph may be materialized without embeddings or
-- with different operator-selected embedding models. Keep these variants
-- separate so a model change never mutates or silently reuses old vectors.

ALTER TABLE mcp_code_index_snapshots
  DROP CONSTRAINT IF EXISTS mcp_code_index_snapshot_immutable_identity;

ALTER TABLE mcp_code_index_snapshots
  ADD CONSTRAINT mcp_code_index_snapshot_immutable_identity
  UNIQUE NULLS NOT DISTINCT
  (repository_key, branch_name, commit_sha, provider, graph_schema_version, embedding_model);

COMMENT ON COLUMN mcp_code_index_snapshots.embedding_model IS
  'Provider-neutral embedding model identity; part of the immutable snapshot identity when configured.';
