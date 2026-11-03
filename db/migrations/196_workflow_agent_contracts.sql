-- Portable Agent requirements owned by Argus Core. Workflows declare roles and
-- capabilities; executions retain the exact resolved runtime evidence.

ALTER TABLE mcp_workflows
  ADD COLUMN IF NOT EXISTS agent_requirements JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE mcp_workflow_executions
  ADD COLUMN IF NOT EXISTS execution_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE mcp_workflow_versions
  ADD COLUMN IF NOT EXISTS agent_requirements JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE mcp_workflows
  DROP CONSTRAINT IF EXISTS mcp_workflows_agent_requirements_array;
ALTER TABLE mcp_workflows
  ADD CONSTRAINT mcp_workflows_agent_requirements_array
  CHECK (jsonb_typeof(agent_requirements) = 'array');

ALTER TABLE mcp_workflow_executions
  DROP CONSTRAINT IF EXISTS mcp_workflow_executions_snapshot_object;
ALTER TABLE mcp_workflow_executions
  ADD CONSTRAINT mcp_workflow_executions_snapshot_object
  CHECK (jsonb_typeof(execution_snapshot) = 'object');

ALTER TABLE mcp_workflow_versions
  DROP CONSTRAINT IF EXISTS mcp_workflow_versions_agent_requirements_array;
ALTER TABLE mcp_workflow_versions
  ADD CONSTRAINT mcp_workflow_versions_agent_requirements_array
  CHECK (jsonb_typeof(agent_requirements) = 'array');

COMMENT ON COLUMN mcp_workflows.agent_requirements IS
  'Portable Core-owned Agent role, preset, skill and tool requirements resolved before execution.';
COMMENT ON COLUMN mcp_workflow_executions.execution_snapshot IS
  'Immutable Agent, preset, runtime, bundle, skill and tool evidence resolved at run start.';
