-- Lease metadata lets a controller recover requests after a crashed worker.
-- A completion is still guarded by claimed_by, so a stale worker cannot
-- complete a request after another worker has reclaimed it.
ALTER TABLE argus_solution_pack_rollback_requests
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

-- Claims created by migration 163 have no lease; make them immediately
-- reclaimable instead of leaving a crashed worker's hand-off stuck forever.
UPDATE argus_solution_pack_rollback_requests
   SET claim_expires_at = NOW()
 WHERE status = 'accepted' AND claim_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_argus_solution_pack_rollbacks_claim_lease
  ON argus_solution_pack_rollback_requests (status, claim_expires_at)
  WHERE status = 'accepted';
