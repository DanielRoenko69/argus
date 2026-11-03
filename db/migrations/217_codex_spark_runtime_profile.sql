-- Add explicit fast and deep Codex subscription runtime profiles.
--
-- Spark is a Codex/ChatGPT Pro research-preview model with its own usage
-- allowance. It is not an OpenAI API model, so this migration deliberately
-- changes only the subscription-backed runtime profile and leaves LiteLLM and
-- the regular model registry untouched.

UPDATE mcp_agent_runtime_profiles
   SET label = 'Codex Spark · ChatGPT Subscription',
       model = 'gpt-5.3-codex-spark',
       reasoning_effort = 'xhigh',
       description = 'Fast official Codex SDK runtime using the local ChatGPT Pro login in the codex-auth volume. Uses GPT-5.3-Codex-Spark for low-latency implementation and iteration.'
 WHERE name = 'codex-subscription-local'
   AND runtime_type = 'codex'
   AND auth_mode = 'chatgpt';

-- Deep work reuses the same protected auth volume, but remains an explicit
-- per-Agent choice. Keeping it separate prevents hidden model escalation and
-- makes runtime/model selection visible in Argus traces and cost evidence.
INSERT INTO mcp_agent_runtime_profiles (
  name,
  label,
  description,
  runtime_type,
  auth_mode,
  auth_ref,
  model,
  reasoning_effort,
  enabled,
  max_concurrent_runs,
  allowed_task_types,
  code_context_mode,
  code_context_max_results,
  code_context_max_bytes
)
VALUES (
  'codex-subscription-deep',
  'Codex Deep · ChatGPT Subscription',
  'Higher-capability official Codex SDK runtime using the same protected ChatGPT login. Select manually for difficult reviews, debugging and long-horizon changes.',
  'codex',
  'chatgpt',
  'codex-auth',
  'gpt-5.6-terra',
  'xhigh',
  true,
  1,
  ARRAY[
    'implement_ticket', 'run_tests', 'plan', 'knowledge', 'review',
    'inspect_pr', 'fix_pr', 'inspect_ci', 'fix_ci',
    'inspect_security', 'fix_security', 'inspect_release',
    'generate_release', 'inspect_backlog', 'decompose_backlog', 'agent_turn'
  ],
  'metadata_only',
  4,
  12000
)
ON CONFLICT (name) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  runtime_type = EXCLUDED.runtime_type,
  auth_mode = EXCLUDED.auth_mode,
  auth_ref = EXCLUDED.auth_ref,
  model = EXCLUDED.model,
  reasoning_effort = EXCLUDED.reasoning_effort,
  enabled = EXCLUDED.enabled,
  max_concurrent_runs = EXCLUDED.max_concurrent_runs,
  allowed_task_types = EXCLUDED.allowed_task_types;
