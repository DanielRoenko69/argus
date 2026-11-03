-- Canonical business-audit event store and durable transactional outbox.
--
-- This is additive: existing operational/admin/immutable audit readers remain
-- valid while privileged mutation producers migrate in bounded slices.

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_chain_heads (
  workspace_key   VARCHAR(128) NOT NULL,
  tenant_key      VARCHAR(128) NOT NULL,
  environment     VARCHAR(64) NOT NULL,
  last_sequence   BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_event_hash TEXT NOT NULL DEFAULT '' CHECK (length(last_event_hash) IN (0, 64)),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_key, tenant_key, environment)
);

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_events (
  event_id                 UUID PRIMARY KEY,
  schema_version           SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  sequence                 BIGINT NOT NULL CHECK (sequence > 0),
  occurred_at              TIMESTAMPTZ NOT NULL,
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  environment              VARCHAR(64) NOT NULL,
  workspace_key            VARCHAR(128) NOT NULL,
  tenant_key               VARCHAR(128) NOT NULL,
  solution                 VARCHAR(128),
  producer_name            VARCHAR(128) NOT NULL,
  producer_event_id        VARCHAR(256) NOT NULL,
  actor_type               VARCHAR(32) NOT NULL CHECK (actor_type IN ('human', 'service', 'system')),
  actor_id                 VARCHAR(256) NOT NULL,
  actor_sso_subject        VARCHAR(512),
  actor_auth_method        VARCHAR(64) NOT NULL,
  actor_roles              TEXT[] NOT NULL DEFAULT '{}',
  action                   VARCHAR(128) NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{1,127}$'),
  outcome                  VARCHAR(32) NOT NULL CHECK (outcome IN ('success', 'failure', 'denied', 'cancelled')),
  risk_level               VARCHAR(16) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  resource_type            VARCHAR(64) NOT NULL,
  resource_id              VARCHAR(256) NOT NULL,
  resource_revision        VARCHAR(256),
  policy_id                VARCHAR(256),
  policy_version           VARCHAR(128),
  policy_decision          VARCHAR(64),
  approval_id              VARCHAR(256),
  root_run_id              VARCHAR(256),
  trace_id                 VARCHAR(256),
  span_id                  VARCHAR(256),
  request_id               VARCHAR(256),
  payload_summary          JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_summary) = 'object'),
  payload_digest           CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  before_digest            CHAR(64) CHECK (before_digest IS NULL OR before_digest ~ '^[0-9a-f]{64}$'),
  after_digest             CHAR(64) CHECK (after_digest IS NULL OR after_digest ~ '^[0-9a-f]{64}$'),
  redaction_profile        VARCHAR(128) NOT NULL,
  retention_class          VARCHAR(64) NOT NULL,
  retention_until          TIMESTAMPTZ,
  legal_hold               BOOLEAN NOT NULL DEFAULT false,
  previous_hash            TEXT NOT NULL CHECK (length(previous_hash) IN (0, 64)),
  event_hash               CHAR(64) NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  signing_key_id           VARCHAR(256),
  UNIQUE (workspace_key, tenant_key, environment, sequence),
  UNIQUE (producer_name, producer_event_id)
);

CREATE INDEX IF NOT EXISTS idx_canonical_audit_events_occurred
  ON mcp_canonical_audit_events (tenant_key, environment, occurred_at DESC, event_id);
CREATE INDEX IF NOT EXISTS idx_canonical_audit_events_resource
  ON mcp_canonical_audit_events (tenant_key, resource_type, resource_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_audit_events_actor
  ON mcp_canonical_audit_events (tenant_key, actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_audit_events_trace
  ON mcp_canonical_audit_events (trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canonical_audit_events_root_run
  ON mcp_canonical_audit_events (root_run_id) WHERE root_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mcp_canonical_audit_outbox (
  id             BIGSERIAL PRIMARY KEY,
  event_id       UUID NOT NULL REFERENCES mcp_canonical_audit_events(event_id) ON DELETE RESTRICT,
  topic          VARCHAR(128) NOT NULL DEFAULT 'audit.canonical.v1',
  state          VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'delivered')),
  attempt_count  INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  leased_by      VARCHAR(256),
  leased_until   TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ,
  last_error     VARCHAR(512),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, topic),
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_canonical_audit_outbox_pending
  ON mcp_canonical_audit_outbox (available_at, id)
  WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION update_mcp_canonical_audit_outbox_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mcp_canonical_audit_outbox_updated_at ON mcp_canonical_audit_outbox;
CREATE TRIGGER trg_mcp_canonical_audit_outbox_updated_at
  BEFORE UPDATE ON mcp_canonical_audit_outbox
  FOR EACH ROW EXECUTE FUNCTION update_mcp_canonical_audit_outbox_updated_at();

CREATE OR REPLACE FUNCTION mcp_canonical_audit_event_block_modify()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'mcp_canonical_audit_events is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mcp_canonical_audit_events_no_update ON mcp_canonical_audit_events;
DROP TRIGGER IF EXISTS mcp_canonical_audit_events_no_delete ON mcp_canonical_audit_events;
DROP TRIGGER IF EXISTS mcp_canonical_audit_events_no_truncate ON mcp_canonical_audit_events;
CREATE TRIGGER mcp_canonical_audit_events_no_update
  BEFORE UPDATE ON mcp_canonical_audit_events
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_event_block_modify();
CREATE TRIGGER mcp_canonical_audit_events_no_delete
  BEFORE DELETE ON mcp_canonical_audit_events
  FOR EACH ROW EXECUTE FUNCTION mcp_canonical_audit_event_block_modify();
CREATE TRIGGER mcp_canonical_audit_events_no_truncate
  BEFORE TRUNCATE ON mcp_canonical_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION mcp_canonical_audit_event_block_modify();

COMMENT ON TABLE mcp_canonical_audit_events IS
  'Versioned append-only business-audit events. Legacy audit tables remain explicit parallel sources during producer migration.';
COMMENT ON TABLE mcp_canonical_audit_outbox IS
  'Durable at-least-once delivery state inserted in the same transaction as its canonical event and business mutation.';

