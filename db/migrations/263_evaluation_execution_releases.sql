-- Execution choices only. Never store prompts, provider credentials or full Agent rows here.
CREATE TABLE IF NOT EXISTS mcp_evaluation_execution_releases (
  id BIGSERIAL PRIMARY KEY,
  tenant_key VARCHAR(128) NOT NULL,
  workspace_key VARCHAR(128) NOT NULL,
  environment VARCHAR(128) NOT NULL,
  comparison_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  candidate_agent_id INTEGER NOT NULL,
  action VARCHAR(16) NOT NULL CHECK (action IN ('applied','rolled_back')),
  source_release_id BIGINT UNIQUE REFERENCES mcp_evaluation_execution_releases(id),
  before_settings JSONB NOT NULL,
  after_settings JSONB NOT NULL,
  before_head_sha256 CHAR(64) NOT NULL,
  after_head_sha256 CHAR(64) NOT NULL,
  before_config_sha256 CHAR(64) NOT NULL,
  after_config_sha256 CHAR(64) NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL,
  reason VARCHAR(2000) NOT NULL,
  actor_user_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((action='rolled_back') = (source_release_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_evaluation_execution_releases_scope
  ON mcp_evaluation_execution_releases(tenant_key,workspace_key,environment,comparison_id,id DESC);
CREATE OR REPLACE FUNCTION reject_evaluation_execution_release_rewrite() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Evaluation execution releases are append-only' USING ERRCODE='23514';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS evaluation_execution_releases_append_only ON mcp_evaluation_execution_releases;
CREATE TRIGGER evaluation_execution_releases_append_only BEFORE UPDATE OR DELETE ON mcp_evaluation_execution_releases
  FOR EACH ROW EXECUTE FUNCTION reject_evaluation_execution_release_rewrite();
