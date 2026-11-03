-- Explainable, deterministic risk assessment for runtime approvals.

ALTER TABLE mcp_runtime_approvals
  ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 60
    CHECK (risk_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS risk_factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS risk_model TEXT NOT NULL DEFAULT 'argus-risk-v1';

CREATE INDEX IF NOT EXISTS idx_runtime_approval_risk
  ON mcp_runtime_approvals (risk_level, risk_score DESC, requested_at DESC);
