-- Parser/adapter upgrades may normalize the same Git commit differently. Keep
-- both immutable snapshots addressable instead of conflicting on commit alone.

UPDATE mcp_code_index_snapshots
   SET graph_schema_version='legacy-v1'
 WHERE graph_schema_version IS NULL;

ALTER TABLE mcp_code_index_snapshots
  ALTER COLUMN graph_schema_version SET DEFAULT 'legacy-v1',
  ALTER COLUMN graph_schema_version SET NOT NULL;

ALTER TABLE mcp_code_index_snapshots
  DROP CONSTRAINT IF EXISTS mcp_code_index_snapshots_repository_key_branch_name_commit__key;

ALTER TABLE mcp_code_index_snapshots
  ADD CONSTRAINT mcp_code_index_snapshot_immutable_identity
  UNIQUE (repository_key, branch_name, commit_sha, provider, graph_schema_version);

COMMENT ON COLUMN mcp_code_index_snapshots.graph_schema_version IS
  'Version of the provider-neutral Argus normalization contract; part of immutable snapshot identity.';

