CREATE TABLE IF NOT EXISTS argus_execution_grants (
  grant_id          UUID PRIMARY KEY,
  pack_id           VARCHAR(128) NOT NULL,
  pack_agent_id     VARCHAR(128) NOT NULL,
  principal_kind    VARCHAR(32) NOT NULL CHECK (principal_kind IN ('user', 'api_key', 'service')),
  principal_id      VARCHAR(128) NOT NULL,
  bundle_ids        INTEGER[] NOT NULL DEFAULT '{}',
  core_agent_ids    INTEGER[] NOT NULL DEFAULT '{}',
  message_id        VARCHAR(128) NOT NULL,
  root_trace_id     UUID NOT NULL,
  policy_version    VARCHAR(64) NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_argus_execution_grants_message
  ON argus_execution_grants (pack_id, pack_agent_id, message_id);
CREATE INDEX IF NOT EXISTS idx_argus_execution_grants_expiry
  ON argus_execution_grants (expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_argus_execution_grants_trace
  ON argus_execution_grants (root_trace_id);

COMMENT ON TABLE argus_execution_grants IS
  'Core-issued, short-lived and task-bound technical identities for out-of-process Solution Pack execution.';
