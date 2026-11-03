-- Immutable content, not reconstructed past versions. Catalog consumers stay current;
-- Agent bindings are pinned. No FK to the mutable catalog: retain deleted history.
CREATE TABLE mcp_skill_revisions (
  id BIGSERIAL PRIMARY KEY,
  skill_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  source_url TEXT,
  source_ref TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('migration','catalog','draft')),
  tenant_key TEXT,
  workspace_key TEXT,
  environment TEXT,
  agent_id INTEGER,
  source_revision_id BIGINT REFERENCES mcp_skill_revisions(id),
  source_head_sha256 TEXT,
  source_bundle_ids INTEGER[],
  created_by_user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id,skill_id),
  CHECK (origin <> 'draft' OR (tenant_key IS NOT NULL AND workspace_key IS NOT NULL
    AND environment IS NOT NULL AND agent_id IS NOT NULL AND source_revision_id IS NOT NULL
    AND source_head_sha256 IS NOT NULL AND source_head_sha256 ~ '^[a-f0-9]{64}$' AND created_by_user_id IS NOT NULL
    AND octet_length(content) BETWEEN 1 AND 32768 AND length(title) BETWEEN 1 AND 120))
);
CREATE INDEX idx_skill_revision_history ON mcp_skill_revisions(skill_id,id DESC);
ALTER TABLE mcp_skills ADD COLUMN current_revision_id BIGINT;
ALTER TABLE mcp_agent_skills ADD COLUMN revision_id BIGINT;
INSERT INTO mcp_skill_revisions(skill_id,title,content,content_sha256,source_url,source_ref,origin)
  SELECT id,'Upgrade baseline',content,encode(sha256(convert_to(content,'UTF8')),'hex'),source_url,source_ref,'migration' FROM mcp_skills;
UPDATE mcp_skills s SET current_revision_id=r.id FROM mcp_skill_revisions r WHERE r.skill_id=s.id;
UPDATE mcp_agent_skills a SET revision_id=s.current_revision_id FROM mcp_skills s WHERE s.id=a.skill_id;
ALTER TABLE mcp_skills ALTER COLUMN current_revision_id SET NOT NULL;
ALTER TABLE mcp_agent_skills ALTER COLUMN revision_id SET NOT NULL;
ALTER TABLE mcp_skills ADD CONSTRAINT skill_catalog_revision_fk FOREIGN KEY(current_revision_id,id) REFERENCES mcp_skill_revisions(id,skill_id);
ALTER TABLE mcp_agent_skills ADD CONSTRAINT agent_skill_revision_fk FOREIGN KEY(revision_id,skill_id) REFERENCES mcp_skill_revisions(id,skill_id);

CREATE FUNCTION version_skill_catalog_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.content IS DISTINCT FROM OLD.content
    OR NEW.source_url IS DISTINCT FROM OLD.source_url OR NEW.source_ref IS DISTINCT FROM OLD.source_ref THEN
    INSERT INTO mcp_skill_revisions(skill_id,title,content,content_sha256,source_url,source_ref,origin)
      VALUES(NEW.id,'Catalog revision',NEW.content,encode(sha256(convert_to(NEW.content,'UTF8')),'hex'),NEW.source_url,NEW.source_ref,'catalog')
      RETURNING id INTO NEW.current_revision_id;
  ELSE
    NEW.current_revision_id := OLD.current_revision_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_catalog_version BEFORE INSERT OR UPDATE ON mcp_skills
  FOR EACH ROW EXECUTE FUNCTION version_skill_catalog_content();
CREATE FUNCTION pin_agent_skill_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision_id IS NULL THEN
    SELECT current_revision_id INTO NEW.revision_id FROM mcp_skills WHERE id=NEW.skill_id;
  END IF;
  IF EXISTS (SELECT 1 FROM mcp_skill_revisions WHERE id=NEW.revision_id AND origin='draft' AND agent_id<>NEW.agent_id) THEN
    RAISE EXCEPTION 'Skill draft belongs to another Agent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_skill_pin BEFORE INSERT OR UPDATE ON mcp_agent_skills
  FOR EACH ROW EXECUTE FUNCTION pin_agent_skill_revision();
CREATE TRIGGER skill_revision_immutable BEFORE UPDATE OR DELETE ON mcp_skill_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_agent_prompt_history_rewrite();

CREATE TABLE mcp_agent_skill_releases (
  id BIGSERIAL PRIMARY KEY,
  tenant_key TEXT NOT NULL, workspace_key TEXT NOT NULL, environment TEXT NOT NULL,
  agent_id INTEGER NOT NULL, skill_id INTEGER NOT NULL, comparison_id INTEGER NOT NULL,
  revision_id BIGINT NOT NULL REFERENCES mcp_skill_revisions(id),
  previous_revision_id BIGINT NOT NULL REFERENCES mcp_skill_revisions(id),
  action TEXT NOT NULL CHECK(action IN ('applied','rolled_back')),
  source_release_id BIGINT UNIQUE REFERENCES mcp_agent_skill_releases(id),
  before_head_sha256 TEXT NOT NULL, after_head_sha256 TEXT NOT NULL,
  before_config_sha256 TEXT NOT NULL, after_config_sha256 TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL, reason TEXT NOT NULL, actor_user_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((action='rolled_back')=(source_release_id IS NOT NULL))
);
CREATE INDEX idx_agent_skill_release_scope ON mcp_agent_skill_releases(tenant_key,workspace_key,environment,comparison_id,id DESC);
CREATE TRIGGER agent_skill_release_immutable BEFORE UPDATE OR DELETE ON mcp_agent_skill_releases
  FOR EACH ROW EXECUTE FUNCTION reject_agent_prompt_history_rewrite();
