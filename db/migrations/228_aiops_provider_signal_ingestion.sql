-- Provider-neutral AIOps alert ingestion.
--
-- External events remain immutable evidence. A hidden provider rule preserves
-- compatibility with the existing incident, correlation and dispatch pipeline
-- without exposing provider adapter internals as user-managed Native Rules.

ALTER TABLE mcp_observability_alert_rules
  ADD COLUMN IF NOT EXISTS source_kind VARCHAR(16) NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS provider VARCHAR(40),
  ADD COLUMN IF NOT EXISTS provider_monitor_ref VARCHAR(300),
  ADD COLUMN IF NOT EXISTS provider_fingerprint VARCHAR(500),
  ADD COLUMN IF NOT EXISTS provider_service_profile_id BIGINT,
  ADD COLUMN IF NOT EXISTS provider_service_profile_revision INTEGER,
  ADD COLUMN IF NOT EXISTS provider_service_profile_sha256 CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='mcp_observability_alert_rules_source_kind'
  ) THEN
    ALTER TABLE mcp_observability_alert_rules
      ADD CONSTRAINT mcp_observability_alert_rules_source_kind
      CHECK (source_kind IN ('native', 'provider'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='mcp_observability_alert_rules_provider_complete'
  ) THEN
    ALTER TABLE mcp_observability_alert_rules
      ADD CONSTRAINT mcp_observability_alert_rules_provider_complete
      CHECK (
        (source_kind='native'
          AND provider IS NULL
          AND provider_monitor_ref IS NULL
          AND provider_fingerprint IS NULL
          AND provider_service_profile_id IS NULL
          AND provider_service_profile_revision IS NULL
          AND provider_service_profile_sha256 IS NULL)
        OR
        (source_kind='provider'
          AND provider IS NOT NULL
          AND provider_monitor_ref IS NOT NULL
          AND provider_fingerprint IS NOT NULL
          AND provider_service_profile_id IS NOT NULL
          AND provider_service_profile_revision IS NOT NULL
          AND provider_service_profile_sha256 IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='mcp_observability_alert_rules_provider_sha256'
  ) THEN
    ALTER TABLE mcp_observability_alert_rules
      ADD CONSTRAINT mcp_observability_alert_rules_provider_sha256
      CHECK (
        provider_service_profile_sha256 IS NULL
        OR provider_service_profile_sha256 ~ '^[a-f0-9]{64}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='mcp_observability_alert_rules_provider_profile_revision_fk'
  ) THEN
    ALTER TABLE mcp_observability_alert_rules
      ADD CONSTRAINT mcp_observability_alert_rules_provider_profile_revision_fk
      FOREIGN KEY (provider_service_profile_id, provider_service_profile_revision)
      REFERENCES mcp_observability_aiops_service_profile_revisions(profile_id, revision)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_observability_provider_rule_identity
  ON mcp_observability_alert_rules(
    provider_service_profile_id,
    provider_service_profile_revision,
    provider,
    provider_monitor_ref,
    provider_fingerprint
  )
  WHERE source_kind='provider';

CREATE TABLE IF NOT EXISTS mcp_observability_aiops_provider_signals (
  id                       BIGSERIAL PRIMARY KEY,
  workspace_key            VARCHAR(128) NOT NULL DEFAULT 'default',
  tenant_key               VARCHAR(128) NOT NULL DEFAULT 'default',
  provider                 VARCHAR(40) NOT NULL
                             CHECK (provider IN (
                               'prometheus-alertmanager', 'grafana',
                               'elasticsearch', 'opensearch', 'generic'
                             )),
  provider_event_id        VARCHAR(300) NOT NULL,
  monitor_ref              VARCHAR(300) NOT NULL,
  fingerprint              VARCHAR(500) NOT NULL,
  signal_state             VARCHAR(16) NOT NULL
                             CHECK (signal_state IN ('firing', 'recovered')),
  severity                 VARCHAR(16) NOT NULL
                             CHECK (severity IN ('info', 'warning', 'critical')),
  service                  VARCHAR(160) NOT NULL,
  environment              VARCHAR(120) NOT NULL,
  title                    VARCHAR(160) NOT NULL,
  summary                  TEXT NOT NULL,
  occurred_at              TIMESTAMPTZ NOT NULL,
  raw_payload_sha256       CHAR(64) NOT NULL
                             CHECK (raw_payload_sha256 ~ '^[a-f0-9]{64}$'),
  normalized_signal        JSONB NOT NULL,
  disposition              VARCHAR(24) NOT NULL
                             CHECK (disposition IN (
                               'created', 'updated', 'recovered', 'ignored'
                             )),
  service_profile_id       BIGINT NOT NULL,
  service_profile_revision INTEGER NOT NULL,
  service_profile_sha256   CHAR(64) NOT NULL
                             CHECK (service_profile_sha256 ~ '^[a-f0-9]{64}$'),
  alert_rule_id            INTEGER NOT NULL
                             REFERENCES mcp_observability_alert_rules(id) ON DELETE RESTRICT,
  incident_id              BIGINT
                             REFERENCES mcp_observability_alert_incidents(id) ON DELETE RESTRICT,
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mcp_aiops_provider_signal_scope_nonempty CHECK (
    length(btrim(provider_event_id)) > 0
    AND length(btrim(monitor_ref)) > 0
    AND length(btrim(fingerprint)) > 0
    AND length(btrim(service)) > 0
    AND length(btrim(environment)) > 0
    AND length(btrim(title)) > 0
  ),
  CONSTRAINT mcp_aiops_provider_signal_json_object CHECK (
    jsonb_typeof(normalized_signal)='object'
    AND pg_column_size(normalized_signal) <= 65536
  ),
  CONSTRAINT mcp_aiops_provider_signal_profile_revision_fk
    FOREIGN KEY (service_profile_id, service_profile_revision)
    REFERENCES mcp_observability_aiops_service_profile_revisions(profile_id, revision)
    ON DELETE RESTRICT,
  UNIQUE (workspace_key, tenant_key, provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_aiops_provider_signals_incident
  ON mcp_observability_aiops_provider_signals(incident_id, received_at DESC)
  WHERE incident_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_aiops_provider_signals_profile
  ON mcp_observability_aiops_provider_signals(
    service_profile_id, service_profile_revision, received_at DESC
  );

-- Provider events are append-only audit evidence. Their normalized body and
-- raw-payload digest must not be rewritten after acceptance.
DROP TRIGGER IF EXISTS mcp_aiops_provider_signals_no_update
  ON mcp_observability_aiops_provider_signals;
DROP TRIGGER IF EXISTS mcp_aiops_provider_signals_no_delete
  ON mcp_observability_aiops_provider_signals;
DROP TRIGGER IF EXISTS mcp_aiops_provider_signals_no_truncate
  ON mcp_observability_aiops_provider_signals;
CREATE TRIGGER mcp_aiops_provider_signals_no_update
  BEFORE UPDATE ON mcp_observability_aiops_provider_signals
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_aiops_provider_signals_no_delete
  BEFORE DELETE ON mcp_observability_aiops_provider_signals
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();
CREATE TRIGGER mcp_aiops_provider_signals_no_truncate
  BEFORE TRUNCATE ON mcp_observability_aiops_provider_signals
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_integrity_block_modify();

COMMENT ON TABLE mcp_observability_aiops_provider_signals IS
  'Immutable normalized provider-alert evidence routed through AIOps Service Profiles.';
COMMENT ON COLUMN mcp_observability_aiops_provider_signals.raw_payload_sha256 IS
  'Digest of the exact signed webhook body; raw provider payload is not retained.';
