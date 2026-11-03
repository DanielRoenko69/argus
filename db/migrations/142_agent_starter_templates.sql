-- Convert the historical built-in agents into optional, provider-neutral
-- starter templates. Existing installations keep their agents unchanged.
-- Fresh installations remove the temporary historical seed rows after their
-- configuration has been captured here.

CREATE TABLE IF NOT EXISTS mcp_agent_templates (
  id                        SERIAL PRIMARY KEY,
  name                      VARCHAR(128) NOT NULL UNIQUE,
  label                     VARCHAR(256) NOT NULL,
  description               TEXT NOT NULL DEFAULT '',
  category                  VARCHAR(64) NOT NULL DEFAULT 'general',
  agent_mode                VARCHAR(24) NOT NULL
    CHECK (agent_mode IN ('chat', 'worker', 'reviewer')),
  config                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  composite_name            VARCHAR(128),
  skill_names               TEXT[] NOT NULL DEFAULT '{}',
  recommended_capabilities  TEXT[] NOT NULL DEFAULT '{}',
  required_by               TEXT[] NOT NULL DEFAULT '{}',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_template_name_format CHECK (name ~ '^[a-z0-9_-]+$')
);

CREATE INDEX IF NOT EXISTS idx_mcp_agent_templates_category
  ON mcp_agent_templates (category, label);

CREATE OR REPLACE FUNCTION update_mcp_agent_templates_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_agent_templates_updated_at ON mcp_agent_templates;
CREATE TRIGGER trg_mcp_agent_templates_updated_at
  BEFORE UPDATE ON mcp_agent_templates
  FOR EACH ROW EXECUTE FUNCTION update_mcp_agent_templates_updated_at();

INSERT INTO mcp_agent_templates
  (name, label, description, category, agent_mode, config, composite_name,
   skill_names, recommended_capabilities, required_by)
SELECT
  agent.name,
  agent.label,
  agent.description,
  CASE
    WHEN agent.name = 'compliance_auditor' THEN 'governance'
    WHEN agent.name = 'workflow_copilot' THEN 'platform'
    ELSE 'ai-development'
  END,
  agent.agent_mode,
  jsonb_strip_nulls(jsonb_build_object(
    'temperature', agent.temperature,
    'maxTokens', agent.max_tokens,
    'systemPrompt', CASE WHEN agent.name = 'planner' THEN
      E'Du bist der Orchestrator-Agent einer AI-Development-Pipeline.\n\n' ||
      E'Koordiniere Knowledge-, Coder- und Reviewer-Agents über __call_agent__. ' ||
      E'Verwende ausschließlich die exakten Agent-IDs, die Argus zur Laufzeit ' ||
      E'in der Tool-Beschreibung bereitstellt; rate niemals IDs.\n\n' ||
      E'## Workflow\n' ||
      E'1. Lass den Knowledge Agent relevanten Ticket-, Architektur- und Code-Kontext sammeln.\n' ||
      E'2. Übergib diesen Kontext an den Coder Agent.\n' ||
      E'3. Lass den Reviewer Agent das Ergebnis prüfen.\n' ||
      E'4. Fasse Implementierung, Tests und Review-Ergebnis zusammen.\n\n' ||
      E'Bei fehlenden Agents oder unklaren Anforderungen halte an und benenne konkret, was konfiguriert werden muss.'
    ELSE agent.system_prompt END,
    'agentRole', agent.agent_role,
    'giteaProject', agent.gitea_project,
    'enabled', true,
    'maxIterations', agent.max_iterations,
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
  )),
  composite.name,
  COALESCE((
    SELECT array_agg(skill.name ORDER BY assignment.position, skill.name)
      FROM mcp_agent_skills assignment
      JOIN mcp_skills skill ON skill.id=assignment.skill_id
     WHERE assignment.agent_id=agent.id
  ), '{}'::text[]),
  CASE
    WHEN agent.agent_mode IN ('worker', 'reviewer') THEN ARRAY['tool-calling', 'long-context']::text[]
    WHEN agent.name IN ('planner', 'workflow_copilot') THEN ARRAY['tool-calling', 'structured-output']::text[]
    ELSE ARRAY['tool-calling']::text[]
  END,
  CASE
    WHEN agent.name IN ('planner', 'coder', 'reviewer', 'knowledge', 'researcher')
      THEN ARRAY['LangGraph AI development workflow']::text[]
    WHEN agent.name = 'workflow_copilot'
      THEN ARRAY['Visual Workflow Copilot']::text[]
    WHEN agent.name = 'compliance_auditor'
      THEN ARRAY['Compliance audit automation']::text[]
    ELSE '{}'::text[]
  END
FROM mcp_agents agent
LEFT JOIN mcp_composites composite ON composite.id=agent.composite_id
WHERE agent.name = ANY(ARRAY[
  'coder', 'planner', 'reviewer', 'knowledge', 'researcher',
  'architect', 'workflow_copilot', 'compliance_auditor'
]::text[])
ON CONFLICT (name) DO UPDATE SET
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  category=EXCLUDED.category,
  agent_mode=EXCLUDED.agent_mode,
  config=EXCLUDED.config,
  composite_name=EXCLUDED.composite_name,
  skill_names=EXCLUDED.skill_names,
  recommended_capabilities=EXCLUDED.recommended_capabilities,
  required_by=EXCLUDED.required_by;

DO $$
DECLARE
  is_fresh BOOLEAN := COALESCE(current_setting('argus.fresh_install', true), 'false') = 'true';
  keep_starters BOOLEAN := COALESCE(current_setting('argus.install_starter_agents', true), 'false') = 'true';
BEGIN
  IF is_fresh AND NOT keep_starters THEN
    DELETE FROM mcp_agents
     WHERE name = ANY(ARRAY[
       'coder', 'planner', 'reviewer', 'knowledge', 'researcher',
       'architect', 'workflow_copilot', 'compliance_auditor'
     ]::text[]);

    -- Migration 141 materializes loose agent model strings. On a clean install
    -- these two rows only existed because of the temporary historical agents.
    DELETE FROM mcp_models model
     WHERE model.model_group = 'agents'
       AND NOT EXISTS (SELECT 1 FROM mcp_agents agent WHERE agent.model=model.model_name);

    IF NOT EXISTS (SELECT 1 FROM mcp_agents) THEN
      PERFORM setval(pg_get_serial_sequence('mcp_agents', 'id'), 1, false);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM mcp_models) THEN
      PERFORM setval(pg_get_serial_sequence('mcp_models', 'id'), 1, false);
    END IF;
  END IF;
END $$;

COMMENT ON TABLE mcp_agent_templates IS
  'Provider-neutral starter blueprints. Installation requires an explicit catalog model and never creates provider credentials.';
