CREATE TABLE mcp_agent_prompt_revisions (
  id BIGSERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  environment TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  system_prompt TEXT NOT NULL CHECK (octet_length(system_prompt) BETWEEN 1 AND 32768),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  source_head_sha256 TEXT NOT NULL CHECK (source_head_sha256 ~ '^[a-f0-9]{64}$'),
  source_prompt TEXT CHECK (octet_length(source_prompt) <= 32768),
  source_bundle_ids INTEGER[],
  source_revision_id BIGINT REFERENCES mcp_agent_prompt_revisions(id),
  created_by_user_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_prompt_revision_scope ON mcp_agent_prompt_revisions(tenant_key,workspace_key,environment,agent_id,id DESC);

ALTER TABLE mcp_agents ADD COLUMN prompt_revision_id BIGINT REFERENCES mcp_agent_prompt_revisions(id);

CREATE TABLE mcp_agent_prompt_releases (
  id BIGSERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  environment TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  comparison_id INTEGER NOT NULL,
  revision_id BIGINT NOT NULL REFERENCES mcp_agent_prompt_revisions(id),
  action TEXT NOT NULL CHECK (action IN ('applied','rolled_back')),
  source_release_id BIGINT UNIQUE REFERENCES mcp_agent_prompt_releases(id),
  before_head_sha256 TEXT NOT NULL,
  after_head_sha256 TEXT NOT NULL,
  before_config_sha256 TEXT NOT NULL,
  after_config_sha256 TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((action='rolled_back') = (source_release_id IS NOT NULL))
);
CREATE INDEX idx_agent_prompt_release_scope ON mcp_agent_prompt_releases(tenant_key,workspace_key,environment,comparison_id,id DESC);
CREATE FUNCTION reject_agent_prompt_history_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Agent prompt history is append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER agent_prompt_revision_immutable BEFORE UPDATE OR DELETE ON mcp_agent_prompt_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_agent_prompt_history_rewrite();
CREATE TRIGGER agent_prompt_release_immutable BEFORE UPDATE OR DELETE ON mcp_agent_prompt_releases
  FOR EACH ROW EXECUTE FUNCTION reject_agent_prompt_history_rewrite();

-- Existing direct edits remain compatible, but may not falsely claim a revision.
CREATE FUNCTION verify_agent_prompt_revision_pointer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.prompt_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mcp_agent_prompt_revisions r WHERE r.id=NEW.prompt_revision_id
      AND r.agent_id=NEW.id AND r.system_prompt IS NOT DISTINCT FROM NEW.system_prompt
  ) THEN
    NEW.prompt_revision_id := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_prompt_revision_pointer BEFORE INSERT OR UPDATE ON mcp_agents
  FOR EACH ROW EXECUTE FUNCTION verify_agent_prompt_revision_pointer();
