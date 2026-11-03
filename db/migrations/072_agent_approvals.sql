-- Migration 072: Coding Workflow Approval Audit Trail
--
-- Captures every human approval/rejection at the Stage-1 (code review) and
-- Stage-2 (functional/PR) gates with named reviewer + timestamp + documented
-- rationale. Required for:
--   - DORA Art. 5 / Art. 8  (ICT-related incident response, evidence trail)
--   - EU AI Act Art. 14    (human oversight, named reviewer)
--   - NIS2 Art. 21         (governance & oversight)
--   - SOC 2 CC7 / CC8      (change management)
--
-- Append-only at the DB level (no DELETE/UPDATE rules) to match the
-- mcp_immutable_audit_log pattern.

CREATE TABLE IF NOT EXISTS mcp_agent_approvals (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Workflow context
  thread_id       TEXT        NOT NULL,
  ticket_id       TEXT,
  workflow_type   TEXT        NOT NULL DEFAULT 'coding_workflow',
  -- Which gate triggered the decision
  gate_type       TEXT        NOT NULL CHECK (gate_type IN ('code_approval', 'functional_approval')),
  -- Decision: true=approve, false=reject
  approved        BOOLEAN     NOT NULL,
  -- Who approved (user.id from session) — nullable for API-key auth flows,
  -- but those should be rare for production approvals
  approver_user_id INTEGER REFERENCES mcp_users(id),
  approver_username TEXT,
  approver_ip      TEXT,
  -- Why — free-text rationale from the reviewer. Empty allowed but flagged
  -- in the UI as "no rationale provided" so compliance can challenge.
  rationale       TEXT        NOT NULL DEFAULT '',
  -- Context at approval time: branch, commit, retry count
  branch_name     TEXT,
  commit_sha      TEXT,
  retry_count     INTEGER     DEFAULT 0,
  -- Tamper-evidence — sha256 of concatenated immutable fields
  row_hash        TEXT
);

-- Append-only enforcement at DB level
CREATE OR REPLACE RULE no_delete_agent_approvals AS
  ON DELETE TO mcp_agent_approvals DO INSTEAD NOTHING;
CREATE OR REPLACE RULE no_update_agent_approvals AS
  ON UPDATE TO mcp_agent_approvals DO INSTEAD NOTHING;

-- Query indexes for the audit-log UI filters
CREATE INDEX IF NOT EXISTS idx_agent_approvals_created    ON mcp_agent_approvals (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_ticket     ON mcp_agent_approvals (ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_approver   ON mcp_agent_approvals (approver_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_thread     ON mcp_agent_approvals (thread_id);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_gate       ON mcp_agent_approvals (gate_type, created_at DESC);
