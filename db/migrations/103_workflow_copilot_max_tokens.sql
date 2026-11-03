-- Migration 103: Raise workflow_copilot agent max_tokens 1500 → 8000
--
-- Root cause (verified 2026-06-02 live test): vague/large prompts like
-- "Baue einen kompletten Self-Healing-Workflow" made the copilot generate a
-- big multi-node workflow JSON that exceeded the 1500-token output budget and
-- was TRUNCATED mid-structure → JSON.parse failed → HTTP 422 ("agent did not
-- return valid JSON"). A 12-20 node workflow (positions + per-node data.args +
-- edges) needs ~3000-5000 output tokens; 8000 gives comfortable headroom while
-- still being bounded by the actual workflow size (unused tokens cost nothing).
--
-- Complements the copilotRoutes.ts JSON-repair re-prompt (Fix B), which is the
-- safety net for genuine non-JSON output (prose/code-fences) rather than
-- truncation.
--
-- Idempotent: safe to re-run.

UPDATE mcp_agents
SET    max_tokens = 8000
WHERE  name = 'workflow_copilot'
  AND  max_tokens < 8000;
