-- Migration 074: API Key → Skill binding
--
-- Lets a developer attach Argus skill IDs to their gateway API key so the
-- system-prompt is pre-populated with skill content on every
-- /v1/chat/completions call without the developer having to copy-paste
-- the skill body into their own messages.
--
-- Use case: data scientist / notebook user who calls Argus Gateway with
-- OpenAI SDK. They register a key bound to skills like 'k8s-incident-response'
-- and 'jira-conventions', and from then on every chat with that key
-- carries those skills as ambient system context.

ALTER TABLE mcp_api_keys
  ADD COLUMN IF NOT EXISTS skill_ids INTEGER[] DEFAULT NULL;

COMMENT ON COLUMN mcp_api_keys.skill_ids IS
  'Optional array of mcp_skills.id values. When set, each /v1/chat/completions request through this key prepends the skill content to the system prompt. Order matters — first skill ID is appended first.';
