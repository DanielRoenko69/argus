-- Durable rollback intent for externally deployed Solution Packs.
-- Core records the requested target; an external reconciler applies it.
CREATE TABLE IF NOT EXISTS argus_solution_pack_rollback_requests (
  id               UUID PRIMARY KEY,
  pack_id          VARCHAR(128) NOT NULL,
  requested_by     VARCHAR(256) NOT NULL,
  reason           TEXT NOT NULL,
  source_revision  BIGINT NOT NULL,
  current_version  VARCHAR(128),
  target_version   VARCHAR(128) NOT NULL,
  target_manifest  JSONB NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'pending',
  error            TEXT,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at       TIMESTAMPTZ,
  CONSTRAINT argus_solution_pack_rollback_status_check
    CHECK (status IN ('pending', 'accepted', 'applied', 'failed', 'canceled'))
);

CREATE INDEX IF NOT EXISTS idx_argus_solution_pack_rollbacks_pack
  ON argus_solution_pack_rollback_requests (pack_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_argus_solution_pack_rollbacks_pending
  ON argus_solution_pack_rollback_requests (status, requested_at DESC);
