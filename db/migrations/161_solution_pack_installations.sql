-- Persist the operator-owned Solution Pack installation/discovery boundary.
-- Secrets are deliberately excluded; token-file paths remain deployment config.
CREATE TABLE IF NOT EXISTS argus_solution_pack_installations (
  pack_id           VARCHAR(128) PRIMARY KEY,
  endpoint          TEXT NOT NULL,
  state             VARCHAR(32) NOT NULL DEFAULT 'not_checked',
  checked_at        TIMESTAMPTZ,
  observed_version  VARCHAR(128),
  observed_manifest JSONB,
  health            JSONB,
  readiness         JSONB,
  error             TEXT,
  previous_version  VARCHAR(128),
  previous_manifest JSONB,
  revision          BIGINT NOT NULL DEFAULT 0,
  installed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT argus_solution_pack_installations_state_check
    CHECK (state IN ('not_checked', 'ready', 'degraded', 'unreachable', 'invalid', 'incompatible'))
);

CREATE INDEX IF NOT EXISTS idx_argus_solution_pack_installations_state
  ON argus_solution_pack_installations (state, updated_at DESC);
