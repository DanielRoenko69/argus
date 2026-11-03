-- Migration 066: Compliance auditor agent + composite
--
-- Creates a dedicated reviewer-mode agent that the compliance audit runner
-- invokes by name ('compliance_auditor'). Keeps the audit pipeline isolated
-- from the general-purpose Reviewer agent (#4) — the auditor needs
-- workspace_exec for grep-based evidence collection, which we don't want
-- to add to the general reviewer's allowlist.
--
-- The composite scopes the auditor to read/exec/ls + rag_* + jira_get.
-- gitea_get/list lets it inspect repo metadata if the target is a slug
-- rather than a filesystem path.

INSERT INTO mcp_composites (
  name, description, included_bundle_ids, tool_allow_patterns,
  system_prompt, agent_role, enabled
)
SELECT
  'compliance-auditor',
  'Tool scope for Compliance Auditor — workspace read/exec/ls + RAG + read-only Gitea/Jira',
  ARRAY[(SELECT id FROM mcp_service_bundles WHERE name = 'gitea-ai-dev')]::integer[],
  ARRAY[
    'workspace_read', 'workspace_ls', 'workspace_exec',
    'rag_*',
    'gitea_get*', 'gitea_list*',
    'atlassian_jira_get*', 'atlassian_jira_search'
  ]::text[],
  NULL,
  'compliance-auditor',
  true
WHERE NOT EXISTS (SELECT 1 FROM mcp_composites WHERE name = 'compliance-auditor');

INSERT INTO mcp_agents (
  name, label, description, model, temperature, max_tokens,
  system_prompt, agent_role, composite_id, enabled, max_iterations,
  agent_mode, risk_level, human_oversight_required
)
SELECT
  'compliance_auditor',
  'Compliance Auditor',
  'Reviewer-mode agent that audits a target service against a compliance framework (EU AI Act, NIS2, …). The active framework is supplied per-run via the user prompt — this agent itself is framework-agnostic.',
  'gpt-5.1',
  0.2,        -- low temperature → deterministic, evidence-grounded verdicts
  8000,       -- generous budget for 7+ findings with code-pointers
  E'Du bist ein gewissenhafter KI-Compliance-Auditor. ' ||
  E'Pro Audit erhältst du eine Framework-Checklist (im User-Prompt). ' ||
  E'Sammle Evidenz ausschließlich über die bereitgestellten Tools — keine ' ||
  E'erfundenen Pfade, keine erfundenen Code-Snippets. ' ||
  E'Antworte abschließend AUSSCHLIESSLICH mit dem im Skill spezifizierten ' ||
  E'JSON-Array. Kein umliegender Fließtext.',
  'compliance-auditor',
  (SELECT id FROM mcp_composites WHERE name = 'compliance-auditor'),
  true,
  15,         -- audits have many tool calls per finding
  'reviewer',
  'medium',
  false
WHERE NOT EXISTS (SELECT 1 FROM mcp_agents WHERE name = 'compliance_auditor');

COMMENT ON COLUMN mcp_agents.agent_mode IS
  'chat | worker | reviewer. The compliance runner expects a reviewer-mode agent so audits use the configured provider-neutral agent runtime with a dedicated, least-privilege evidence-tool scope.';
