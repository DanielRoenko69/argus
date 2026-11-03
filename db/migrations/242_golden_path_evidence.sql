-- Bind terminal Golden Path runs to their immutable, signed run-evidence report.
-- The report itself remains retention-controlled by mcp_audit_report_runs.

ALTER TABLE mcp_golden_path_runs
  ADD COLUMN IF NOT EXISTS audit_report_run_id UUID
    REFERENCES mcp_audit_report_runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS evidence_status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (evidence_status IN ('pending', 'generating', 'complete', 'failed')),
  ADD COLUMN IF NOT EXISTS evidence_error TEXT,
  ADD COLUMN IF NOT EXISTS evidence_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (evidence_attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS evidence_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_mcp_golden_path_runs_evidence_pending
  ON mcp_golden_path_runs (evidence_status, evidence_updated_at, started_at)
  WHERE evidence_status IN ('pending', 'generating', 'failed');

CREATE INDEX IF NOT EXISTS idx_mcp_golden_path_runs_audit_report
  ON mcp_golden_path_runs (audit_report_run_id)
  WHERE audit_report_run_id IS NOT NULL;

COMMENT ON COLUMN mcp_golden_path_runs.audit_report_run_id IS
  'Latest immutable signed run-evidence report for the active execution/retry chain.';
COMMENT ON COLUMN mcp_golden_path_runs.evidence_status IS
  'Generation state of the signed evidence projection; failed runs can be retried by the worker.';
