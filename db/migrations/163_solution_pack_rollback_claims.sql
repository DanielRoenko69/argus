-- Claim metadata for the external Solution-Pack deployment reconciler.
-- Core only records the hand-off; the controller owns the actual deployment.
ALTER TABLE argus_solution_pack_rollback_requests
  ADD COLUMN IF NOT EXISTS claimed_by  VARCHAR(256),
  ADD COLUMN IF NOT EXISTS claimed_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_argus_solution_pack_rollbacks_claimed
  ON argus_solution_pack_rollback_requests (claimed_by, claimed_at DESC)
  WHERE claimed_by IS NOT NULL;
