-- Audit L4 + L5 — referential integrity + index hardening.

-- L4: mcp_workflow_subscribers.user_id had NO foreign key, so subscriber rows
-- survive deletion of their user (orphans) — a deleted user keeps receiving /
-- blocking notifications. Clean existing orphans, then add the FK with
-- ON DELETE CASCADE. Guarded because Postgres has no ADD CONSTRAINT IF NOT EXISTS.
DELETE FROM mcp_workflow_subscribers s
  WHERE NOT EXISTS (SELECT 1 FROM mcp_users u WHERE u.id = s.user_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_workflow_subscribers_user_fk'
  ) THEN
    ALTER TABLE mcp_workflow_subscribers
      ADD CONSTRAINT mcp_workflow_subscribers_user_fk
      FOREIGN KEY (user_id) REFERENCES mcp_users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- L5: the cron tick (every 60s) and every webhook POST filter mcp_workflows
-- with a `trigger_config @> {...}` JSONB containment predicate, which cannot use
-- a btree index → sequential scan that grows with the workflow count (and the
-- webhook path is externally reachable). A GIN index on trigger_config serves
-- the containment lookup.
CREATE INDEX IF NOT EXISTS idx_mcp_workflows_trigger_config_gin
  ON mcp_workflows USING GIN (trigger_config jsonb_path_ops);
