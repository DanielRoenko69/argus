-- Versioned Agent preset lifecycle. Installations retain the exact template-
-- managed state that was applied so Argus can distinguish platform updates
-- from local operator customisation before proposing an upgrade.

ALTER TABLE mcp_agent_templates
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1
    CHECK (version > 0);

CREATE TABLE IF NOT EXISTS mcp_agent_template_installations (
  agent_id           INTEGER PRIMARY KEY REFERENCES mcp_agents(id) ON DELETE CASCADE,
  template_name      VARCHAR(128) NOT NULL REFERENCES mcp_agent_templates(name) ON DELETE RESTRICT,
  installed_version INTEGER NOT NULL DEFAULT 0 CHECK (installed_version >= 0),
  applied_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  installed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  upgraded_at        TIMESTAMPTZ,
  UNIQUE (template_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_template_installations_version
  ON mcp_agent_template_installations (template_name, installed_version);

-- Existing name-matched Agents predate lifecycle tracking. Their current
-- managed values become a version-0 baseline; no historical claim is made
-- about which old preset revision created them.
INSERT INTO mcp_agent_template_installations
  (agent_id, template_name, installed_version, applied_snapshot, installed_at)
SELECT
  agent.id,
  template.name,
  0,
  jsonb_build_object(
    'label', agent.label,
    'description', agent.description,
    'temperature', agent.temperature,
    'maxTokens', agent.max_tokens,
    'systemPrompt', agent.system_prompt,
    'agentRole', agent.agent_role,
    'giteaProject', agent.gitea_project,
    'compositeName', composite.name,
    'skillNames', COALESCE((
      SELECT jsonb_agg(skill.name ORDER BY assignment.position, skill.name)
        FROM mcp_agent_skills assignment
        JOIN mcp_skills skill ON skill.id=assignment.skill_id
       WHERE assignment.agent_id=agent.id
    ), '[]'::jsonb),
    'maxIterations', agent.max_iterations,
    'agentMode', agent.agent_mode,
    'taskType', agent.task_type,
    'allowedPaths', agent.allowed_paths,
    'bitbucketRepo', agent.bitbucket_repo,
    'thinkingBudget', agent.thinking_budget,
    'untrustedToolOutputEnforcement', agent.untrusted_tool_output_enforcement,
    'codegraphEnabled', agent.codegraph_enabled,
    'visibility', agent.visibility,
    'minRole', agent.min_role,
    'riskLevel', agent.risk_level,
    'humanOversightRequired', agent.human_oversight_required
  ),
  agent.created_at
FROM mcp_agents agent
JOIN mcp_agent_templates template ON template.name=agent.name
LEFT JOIN mcp_composites composite ON composite.id=agent.composite_id
ON CONFLICT (agent_id) DO NOTHING;

COMMENT ON COLUMN mcp_agent_templates.version IS
  'Monotonic operator-controlled revision of template-managed Agent configuration.';
COMMENT ON TABLE mcp_agent_template_installations IS
  'Version and immutable applied baseline used for conflict-aware Agent preset upgrades.';
