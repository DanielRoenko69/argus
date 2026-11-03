-- Migration 082: Per-agent opt-in for codegraph_* MCP tools
--
-- When true, the agent-workspace pre-job hook runs `graphify update .` on
-- the cloned repo so the three codegraph_* tools have a fresh graph to
-- query. When false, codegraph_* tools either skip or report "graph not
-- available" and the agent falls back to grep/read.
--
-- Default is false because the pre-job hook adds ~30s of latency to the
-- first agent iteration; opt-in agents pay this cost in exchange for
-- ~16x token reduction on follow-up structural queries.

ALTER TABLE mcp_agents
  ADD COLUMN IF NOT EXISTS codegraph_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN mcp_agents.codegraph_enabled IS
  'Opt-in: when true, agent-workspace pre-job hook materialises graphify-out/ so codegraph_* MCP tools can query the repo structure cheaply.';

-- Audit event for graph builds — helps trace "agent claimed the graph was
-- stale, but here is when we last built it".
ALTER TABLE mcp_immutable_audit_log
  DROP CONSTRAINT IF EXISTS mcp_immutable_audit_log_event_type_check;

ALTER TABLE mcp_immutable_audit_log
  ADD CONSTRAINT mcp_immutable_audit_log_event_type_check
  CHECK (event_type IN (
    'request_success',
    'request_failure',
    'cache_hit',
    'guardrail_block',
    'budget_exceeded',
    'rate_limit_exceeded',
    'tool_hook_decision',
    'entra_sp_provisioned',
    'entra_sp_deleted',
    'entra_sync_failed',
    'codegraph_built'
  ));
