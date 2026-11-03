-- Scheduled and on-demand reports derived from signed canonical audit evidence.
-- Report artifacts are immutable after completion; definitions are disabled,
-- never hard-deleted, so historical provenance remains reconstructable.

CREATE TABLE IF NOT EXISTS mcp_audit_report_definitions (
  id                  UUID PRIMARY KEY,
  workspace_key       VARCHAR(128) NOT NULL,
  tenant_key          VARCHAR(128) NOT NULL,
  environment         VARCHAR(64) NOT NULL,
  name                VARCHAR(160) NOT NULL,
  report_type         VARCHAR(32) NOT NULL
    CHECK (report_type IN ('governance', 'compliance', 'run_evidence', 'incident')),
  cadence             VARCHAR(16) NOT NULL
    CHECK (cadence IN ('manual', 'daily', 'weekly', 'monthly')),
  timezone            VARCHAR(64) NOT NULL DEFAULT 'UTC',
  schedule_hour       SMALLINT NOT NULL DEFAULT 8 CHECK (schedule_hour BETWEEN 0 AND 23),
  schedule_weekday    SMALLINT CHECK (schedule_weekday BETWEEN 0 AND 6),
  schedule_monthday   SMALLINT CHECK (schedule_monthday BETWEEN 1 AND 28),
  window_days         SMALLINT NOT NULL DEFAULT 30 CHECK (window_days BETWEEN 1 AND 366),
  filters             JSONB NOT NULL DEFAULT '{}'::jsonb,
  formats             TEXT[] NOT NULL DEFAULT ARRAY['pdf','json','csv']::text[]
    CHECK (formats <@ ARRAY['pdf','json','jsonl','csv']::text[] AND cardinality(formats) > 0),
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  created_by          VARCHAR(256) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_run_at         TIMESTAMPTZ,
  last_run_at         TIMESTAMPTZ,
  disabled_at         TIMESTAMPTZ,
  CONSTRAINT mcp_audit_report_definition_schedule_shape CHECK (
    (cadence <> 'weekly' OR schedule_weekday IS NOT NULL)
    AND (cadence <> 'monthly' OR schedule_monthday IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_report_definition_name
  ON mcp_audit_report_definitions
    (workspace_key, tenant_key, environment, lower(name));
CREATE INDEX IF NOT EXISTS idx_audit_report_definitions_due
  ON mcp_audit_report_definitions (next_run_at, id)
  WHERE enabled = TRUE AND cadence <> 'manual';

CREATE TABLE IF NOT EXISTS mcp_audit_report_runs (
  id                    UUID PRIMARY KEY,
  definition_id         UUID REFERENCES mcp_audit_report_definitions(id) ON DELETE RESTRICT,
  workspace_key         VARCHAR(128) NOT NULL,
  tenant_key            VARCHAR(128) NOT NULL,
  environment           VARCHAR(64) NOT NULL,
  report_type           VARCHAR(32) NOT NULL
    CHECK (report_type IN ('governance', 'compliance', 'run_evidence', 'incident')),
  name_snapshot         VARCHAR(160) NOT NULL,
  trigger_type          VARCHAR(16) NOT NULL CHECK (trigger_type IN ('manual', 'scheduled', 'event')),
  requested_by          VARCHAR(256) NOT NULL,
  status                VARCHAR(16) NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  period_from           TIMESTAMPTZ NOT NULL,
  period_to             TIMESTAMPTZ NOT NULL,
  filters               JSONB NOT NULL DEFAULT '{}'::jsonb,
  checkpoint_id         UUID REFERENCES mcp_canonical_audit_checkpoints(checkpoint_id) ON DELETE RESTRICT,
  pack_id               UUID,
  pack_digest           CHAR(64) CHECK (pack_digest IS NULL OR pack_digest ~ '^[0-9a-f]{64}$'),
  verification_state    VARCHAR(16) CHECK (verification_state IS NULL OR verification_state IN ('valid', 'invalid')),
  event_count           INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  chain_entry_count     INTEGER NOT NULL DEFAULT 0 CHECK (chain_entry_count >= 0),
  gap_codes             TEXT[] NOT NULL DEFAULT '{}'::text[],
  summary               JSONB,
  evidence_pack         JSONB,
  error_code            VARCHAR(64),
  error_message         TEXT,
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_audit_report_period CHECK (period_from <= period_to),
  CONSTRAINT mcp_audit_report_completed_shape CHECK (
    status <> 'completed' OR (
      checkpoint_id IS NOT NULL AND pack_id IS NOT NULL AND pack_digest IS NOT NULL
      AND verification_state = 'valid' AND evidence_pack IS NOT NULL AND completed_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_report_scheduled_window
  ON mcp_audit_report_runs (definition_id, period_to)
  WHERE definition_id IS NOT NULL AND trigger_type = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_audit_report_runs_scope
  ON mcp_audit_report_runs
    (workspace_key, tenant_key, environment, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_report_runs_status
  ON mcp_audit_report_runs (status, created_at)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS mcp_audit_report_reviews (
  id                UUID PRIMARY KEY,
  report_run_id     UUID NOT NULL REFERENCES mcp_audit_report_runs(id) ON DELETE RESTRICT,
  decision          VARCHAR(16) NOT NULL CHECK (decision IN ('approved', 'rejected', 'superseded')),
  actor_id          VARCHAR(256) NOT NULL,
  actor_auth_method VARCHAR(64) NOT NULL,
  comment_digest    CHAR(64) NOT NULL CHECK (comment_digest ~ '^[0-9a-f]{64}$'),
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  audit_event_id    UUID NOT NULL REFERENCES mcp_canonical_audit_events(event_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_audit_report_reviews_run
  ON mcp_audit_report_reviews (report_run_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION update_mcp_audit_report_definition_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_audit_report_definition_updated_at ON mcp_audit_report_definitions;
CREATE TRIGGER trg_mcp_audit_report_definition_updated_at
  BEFORE UPDATE ON mcp_audit_report_definitions
  FOR EACH ROW EXECUTE FUNCTION update_mcp_audit_report_definition_updated_at();

DROP TRIGGER IF EXISTS mcp_audit_report_definitions_no_delete ON mcp_audit_report_definitions;
CREATE TRIGGER mcp_audit_report_definitions_no_delete
  BEFORE DELETE ON mcp_audit_report_definitions
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

CREATE OR REPLACE FUNCTION mcp_audit_report_run_protect_terminal()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'mcp_audit_report_runs is retention-controlled (% blocked)', TG_OP;
  END IF;
  IF OLD.status IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'terminal audit report runs are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mcp_audit_report_runs_no_delete ON mcp_audit_report_runs;
DROP TRIGGER IF EXISTS mcp_audit_report_runs_no_truncate ON mcp_audit_report_runs;
DROP TRIGGER IF EXISTS mcp_audit_report_runs_terminal_immutable ON mcp_audit_report_runs;
CREATE TRIGGER mcp_audit_report_runs_no_delete
  BEFORE DELETE ON mcp_audit_report_runs
  FOR EACH ROW EXECUTE FUNCTION mcp_audit_report_run_protect_terminal();
CREATE TRIGGER mcp_audit_report_runs_no_truncate
  BEFORE TRUNCATE ON mcp_audit_report_runs
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_audit_report_run_protect_terminal();
CREATE TRIGGER mcp_audit_report_runs_terminal_immutable
  BEFORE UPDATE ON mcp_audit_report_runs
  FOR EACH ROW EXECUTE FUNCTION mcp_audit_report_run_protect_terminal();

DROP TRIGGER IF EXISTS mcp_audit_report_reviews_no_update ON mcp_audit_report_reviews;
DROP TRIGGER IF EXISTS mcp_audit_report_reviews_no_delete ON mcp_audit_report_reviews;
DROP TRIGGER IF EXISTS mcp_audit_report_reviews_no_truncate ON mcp_audit_report_reviews;
CREATE TRIGGER mcp_audit_report_reviews_no_update
  BEFORE UPDATE ON mcp_audit_report_reviews
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_audit_report_reviews_no_delete
  BEFORE DELETE ON mcp_audit_report_reviews
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_audit_report_reviews_no_truncate
  BEFORE TRUNCATE ON mcp_audit_report_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_audit_report_definitions IS
  'Scoped report schedules. Definitions are disabled instead of deleted so generated evidence remains attributable.';
COMMENT ON TABLE mcp_audit_report_runs IS
  'Immutable terminal report artifacts derived exclusively from signed canonical evidence packs.';
COMMENT ON TABLE mcp_audit_report_reviews IS
  'Append-only human review decisions over immutable audit report runs.';
