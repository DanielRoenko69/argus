-- Migration 101: Repoint workflow_copilot agent from gpt-4o-mini → gpt-5.1
--
-- gpt-4o-mini is not available on the Argus LLM Gateway routing table,
-- which caused ERR_EMPTY_RESPONSE on every copilot request. gpt-5.1 is
-- the current default model and is confirmed routable.
--
-- Idempotent: safe to re-run.

UPDATE mcp_agents
SET    model = 'gpt-5.1'
WHERE  name  = 'workflow_copilot';
