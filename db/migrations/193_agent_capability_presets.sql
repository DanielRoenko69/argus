-- Capability-aware Agent presets. Presets remain provider-neutral: operators
-- select a catalog model, an optional execution runtime profile and the MCP
-- bundle that satisfies the declared tool requirements during installation.

ALTER TABLE mcp_agent_templates
  ADD COLUMN IF NOT EXISTS required_tool_patterns TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS minimum_bundle_count SMALLINT NOT NULL DEFAULT 0
    CHECK (minimum_bundle_count BETWEEN 0 AND 16);

INSERT INTO mcp_composites
  (name, description, included_bundle_ids, tool_allow_patterns,
   tool_deny_patterns, system_prompt, agent_role, enabled)
VALUES
  ('preset_workspace_developer',
   'Local development boundary for workspace and native code-intelligence tools.',
   '{}',
   ARRAY['workspace_*', 'argus_code_*', '__call_agent__', '__call_agents_parallel__'],
   ARRAY['*_delete_*', '*_deploy_*', '*_merge_*'],
   NULL,
   'workspace developer',
   true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_agent_templates
  (name, label, description, category, agent_mode, config, composite_name,
   skill_names, recommended_capabilities, required_by,
   required_tool_patterns, minimum_bundle_count)
VALUES
  ('github_reader',
   'GitHub Read-only Analyst',
   'Explores one scoped GitHub repository, explains code and issues, and never mutates upstream state.',
   'source-control',
   'chat',
   jsonb_build_object(
     'temperature', 0.2,
     'maxTokens', 8192,
     'maxIterations', 10,
     'untrustedToolOutputEnforcement', true,
     'riskLevel', 'low',
     'humanOversightRequired', false,
     'systemPrompt', E'You are a read-only GitHub repository analyst. Stay inside the repository and scope named by the user. Prefer direct file, commit, issue and pull-request reads. Never call a write, merge, push, branch, comment or repository creation tool. Clearly separate retrieved evidence from inference.'
   ),
   NULL,
   '{}',
   ARRAY['github-read', 'repository-analysis', 'tool-calling'],
   ARRAY['Repository discovery and support'],
   ARRAY['*_get_file_contents'],
   1),

  ('github_reviewer',
   'GitHub Pull Request Reviewer',
   'Reviews pull requests against repository evidence without merging or modifying code.',
   'source-control',
   'reviewer',
   jsonb_build_object(
     'temperature', 0.15,
     'maxTokens', 12288,
     'maxIterations', 12,
     'untrustedToolOutputEnforcement', true,
     'riskLevel', 'medium',
     'humanOversightRequired', true,
     'systemPrompt', E'You are a read-only pull-request reviewer. Inspect the pull request, changed files and relevant repository context. Report correctness, security, regression and test risks with file-level evidence. Do not merge, approve, comment, push or modify repository state; return proposed review text to the human operator.'
   ),
   NULL,
   '{}',
   ARRAY['github-read', 'pull-request-review', 'evidence'],
   ARRAY['Governed development workflows'],
   ARRAY['*_pull_request_read', '*_get_file_contents'],
   1),

  ('workspace_developer',
   'Workspace Developer',
   'Implements scoped changes in an isolated Argus workspace with native code intelligence.',
   'ai-development',
   'worker',
   jsonb_build_object(
     'temperature', 0.2,
     'maxTokens', 16384,
     'maxIterations', 20,
     'untrustedToolOutputEnforcement', true,
     'codegraphEnabled', true,
     'riskLevel', 'medium',
     'humanOversightRequired', true,
     'systemPrompt', E'You are a scoped workspace developer. Inspect before editing, make the smallest coherent change, use native code intelligence when available, run relevant validation and report every changed file. Never push, merge or deploy. Stop when the requested scope or available evidence is insufficient.'
   ),
   'preset_workspace_developer',
   '{}',
   ARRAY['workspace-write', 'native-code-intelligence', 'tool-calling'],
   ARRAY['Argus Dev implementation workflows'],
   '{}',
   0),

  ('kubernetes_observer',
   'Kubernetes Observer',
   'Investigates Kubernetes resources, events and pod logs without changing cluster state.',
   'aiops',
   'chat',
   jsonb_build_object(
     'temperature', 0.1,
     'maxTokens', 8192,
     'maxIterations', 12,
     'untrustedToolOutputEnforcement', true,
     'riskLevel', 'medium',
     'humanOversightRequired', true,
     'systemPrompt', E'You are a read-only Kubernetes observer. Correlate workload state, events, configuration and pod logs. Never generate, apply, patch, delete, restart, scale or roll back resources. State the cluster, namespace, workload and time window used for every conclusion, and distinguish observed facts from hypotheses.'
   ),
   NULL,
   '{}',
   ARRAY['kubernetes-read', 'incident-investigation', 'evidence'],
   ARRAY['Argus AIOps investigations'],
   ARRAY['*_k8s_get_resources', '*_k8s_get_pod_logs'],
   1)
ON CONFLICT (name) DO UPDATE SET
  label=EXCLUDED.label,
  description=EXCLUDED.description,
  category=EXCLUDED.category,
  agent_mode=EXCLUDED.agent_mode,
  config=EXCLUDED.config,
  composite_name=EXCLUDED.composite_name,
  skill_names=EXCLUDED.skill_names,
  recommended_capabilities=EXCLUDED.recommended_capabilities,
  required_by=EXCLUDED.required_by,
  required_tool_patterns=EXCLUDED.required_tool_patterns,
  minimum_bundle_count=EXCLUDED.minimum_bundle_count;

COMMENT ON COLUMN mcp_agent_templates.required_tool_patterns IS
  'Glob patterns that must each match at least one tool in the explicitly selected bundle scope.';
COMMENT ON COLUMN mcp_agent_templates.minimum_bundle_count IS
  'Minimum number of explicit MCP bundles required before this preset may be installed.';
