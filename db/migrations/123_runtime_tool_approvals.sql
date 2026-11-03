-- Persistent human-in-the-loop requests for sensitive runtime tool calls.
-- An approval is a short-lived, single-use grant for one exact subject/tool/args tuple.

CREATE TABLE IF NOT EXISTS mcp_runtime_approvals (
  id                    BIGSERIAL PRIMARY KEY,
  request_key           TEXT NOT NULL,
  grant_key             TEXT NOT NULL,
  subject_type          TEXT NOT NULL CHECK (subject_type IN ('agent', 'workflow')),
  agent_id               INTEGER REFERENCES mcp_agents(id) ON DELETE SET NULL,
  workflow_id            INTEGER REFERENCES mcp_workflows(id) ON DELETE SET NULL,
  session_id             TEXT NOT NULL,
  tool_name              TEXT NOT NULL,
  tool_args              JSONB NOT NULL DEFAULT '{}'::jsonb,
  tool_args_hash         TEXT NOT NULL,
  risk_level             TEXT NOT NULL DEFAULT 'high' CHECK (risk_level IN ('medium', 'high', 'critical')),
  reason                 TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected', 'consumed', 'expired')),
  requested_by_user_id   INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence_count       INTEGER NOT NULL DEFAULT 1,
  decided_by_user_id     INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL,
  decided_by_username    TEXT,
  decision_comment       TEXT,
  decided_at             TIMESTAMPTZ,
  approval_expires_at    TIMESTAMPTZ,
  consumed_at            TIMESTAMPTZ,
  consumed_session_id    TEXT,
  CONSTRAINT runtime_approval_subject CHECK (
    (subject_type = 'agent' AND agent_id IS NOT NULL)
    OR (subject_type = 'workflow' AND workflow_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_runtime_approval_active_request
  ON mcp_runtime_approvals (request_key)
  WHERE status IN ('pending', 'approved', 'rejected');

CREATE INDEX IF NOT EXISTS idx_runtime_approval_pending
  ON mcp_runtime_approvals (status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_runtime_approval_grant
  ON mcp_runtime_approvals (grant_key, status, approval_expires_at);

CREATE INDEX IF NOT EXISTS idx_runtime_approval_subject
  ON mcp_runtime_approvals (subject_type, agent_id, workflow_id, requested_at DESC);
