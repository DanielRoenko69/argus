-- Opt-in, restart-safe Argus AIOps automation for native alert incidents.

ALTER TABLE mcp_observability_alert_rules
  ADD COLUMN IF NOT EXISTS aiops_auto_investigate BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS aiops_bundle_ids INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS aiops_resource_scope JSONB,
  ADD COLUMN IF NOT EXISTS aiops_service VARCHAR(200),
  ADD COLUMN IF NOT EXISTS aiops_environment VARCHAR(120);

ALTER TABLE mcp_observability_alert_rules
  DROP CONSTRAINT IF EXISTS mcp_observability_alert_rules_aiops_policy_check;

ALTER TABLE mcp_observability_alert_rules
  ADD CONSTRAINT mcp_observability_alert_rules_aiops_policy_check CHECK (
    NOT aiops_auto_investigate OR (
      cardinality(aiops_bundle_ids) BETWEEN 1 AND 64
      AND aiops_resource_scope IS NOT NULL
      AND length(COALESCE(aiops_service, '')) BETWEEN 1 AND 200
      AND length(COALESCE(aiops_environment, '')) BETWEEN 1 AND 120
    )
  );

CREATE TABLE IF NOT EXISTS mcp_observability_incident_aiops_dispatches (
  id                 BIGSERIAL PRIMARY KEY,
  incident_id        BIGINT NOT NULL UNIQUE
                     REFERENCES mcp_observability_alert_incidents(id) ON DELETE CASCADE,
  rule_id            INTEGER NOT NULL
                     REFERENCES mcp_observability_alert_rules(id) ON DELETE CASCADE,
  status             VARCHAR(16) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','dispatching','started','blocked','failed','skipped')),
  bundle_ids         INTEGER[] NOT NULL,
  resource_scope     JSONB NOT NULL,
  service            VARCHAR(200) NOT NULL,
  environment        VARCHAR(120) NOT NULL,
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  available_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at    TIMESTAMPTZ,
  last_error         VARCHAR(1000),
  task_link_id       BIGINT REFERENCES mcp_observability_incident_aiops_tasks(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incident_aiops_dispatch_pending
  ON mcp_observability_incident_aiops_dispatches (status, available_at, id);

COMMENT ON TABLE mcp_observability_incident_aiops_dispatches IS
  'Restart-safe, deduplicated dispatch intent for opt-in native alert AIOps investigations.';
