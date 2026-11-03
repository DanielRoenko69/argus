-- Migration 021: PR-Context + Worker/Reviewer Modes für Agents
-- Ermöglicht Agents in CI/CD-Pipelines (Jenkins, n8n) mit PR-Kontext zu nutzen

ALTER TABLE mcp_agents
  ADD COLUMN IF NOT EXISTS agent_mode     VARCHAR(32)  NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS task_type      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS pr_branch      VARCHAR(256),
  ADD COLUMN IF NOT EXISTS pr_number      INTEGER,
  ADD COLUMN IF NOT EXISTS ticket_id      VARCHAR(128),
  ADD COLUMN IF NOT EXISTS allowed_paths  TEXT[],
  ADD COLUMN IF NOT EXISTS bitbucket_repo VARCHAR(256);

-- Session bekommt PR-Kontext: n8n kann eine Session mit Build-Log vorladen
ALTER TABLE mcp_agent_sessions
  ADD COLUMN IF NOT EXISTS pr_context JSONB NOT NULL DEFAULT '{}';
