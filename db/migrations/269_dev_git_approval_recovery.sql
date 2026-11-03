-- Bind an immutable human decision to the exact LangGraph interrupt so a
-- failed/unknown dispatch can be reconciled without asking for another vote.
ALTER TABLE mcp_agent_approvals
  ADD COLUMN IF NOT EXISTS checkpoint_id UUID,
  ADD COLUMN IF NOT EXISTS decision_feedback TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_approvals_broker_checkpoint
  ON mcp_agent_approvals (thread_id, checkpoint_id)
  WHERE checkpoint_id IS NOT NULL;
