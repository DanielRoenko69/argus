-- Runtime-owned model policy
--
-- The control plane is the single source of truth for subscription runtime
-- model selection. Solution packs receive this non-secret policy through the
-- authenticated internal runtime resolver instead of hard-coding a model.

ALTER TABLE mcp_agent_runtime_profiles
  ADD COLUMN IF NOT EXISTS model VARCHAR(160),
  ADD COLUMN IF NOT EXISTS reasoning_effort VARCHAR(16);

ALTER TABLE mcp_agent_runtime_profiles
  DROP CONSTRAINT IF EXISTS mcp_agent_runtime_profiles_reasoning_effort_check;

ALTER TABLE mcp_agent_runtime_profiles
  ADD CONSTRAINT mcp_agent_runtime_profiles_reasoning_effort_check
  CHECK (
    reasoning_effort IS NULL OR
    reasoning_effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
  );

UPDATE mcp_agent_runtime_profiles
   SET model = 'gpt-5.6-terra',
       reasoning_effort = 'xhigh',
       description = 'Official Codex SDK runtime using the local ChatGPT login in the codex-auth volume. Model and reasoning policy are governed by Argus Core.',
       allowed_task_types = ARRAY[
         'implement_ticket', 'run_tests', 'plan', 'knowledge', 'review',
         'inspect_pr', 'fix_pr', 'inspect_ci', 'fix_ci',
         'inspect_security', 'fix_security', 'inspect_release',
         'generate_release', 'inspect_backlog', 'decompose_backlog'
       ]
 WHERE name = 'codex-subscription-local';

COMMENT ON COLUMN mcp_agent_runtime_profiles.model IS
  'Non-secret model identifier selected by the Argus Core control plane for this execution runtime.';
COMMENT ON COLUMN mcp_agent_runtime_profiles.reasoning_effort IS
  'Optional reasoning policy selected by the Argus Core control plane for this execution runtime.';
