-- Immutable gateway request audit log for SOC2/GDPR/EU AI Act compliance.
-- Append-only enforced at DB level: UPDATE and DELETE are blocked by rules.
-- Every LLM request (success + failure) is written here permanently.
CREATE TABLE IF NOT EXISTS mcp_immutable_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type      TEXT        NOT NULL, -- 'request_success' | 'request_failure' | 'cache_hit' | 'guardrail_block'
  request_id      TEXT,
  api_key_prefix  TEXT        NOT NULL,
  user_id         INTEGER,
  end_user        TEXT,                 -- request body "user" field
  model           TEXT        NOT NULL,
  provider        TEXT,
  deployment_id   INTEGER,
  input_tokens    INTEGER     NOT NULL DEFAULT 0,
  output_tokens   INTEGER     NOT NULL DEFAULT 0,
  cost            NUMERIC(12,8) NOT NULL DEFAULT 0,
  duration_ms     INTEGER,
  is_error        BOOLEAN     NOT NULL DEFAULT false,
  error_type      TEXT,
  requester_ip    TEXT,
  session_id      TEXT,
  team_id         INTEGER,
  org_id          INTEGER,
  risk_level      TEXT        DEFAULT 'low', -- EU AI Act: 'low' | 'medium' | 'high'
  -- Tamper-evidence: hash of (id-1 row's hash || this row's key fields)
  row_hash        TEXT
);

-- Enforce append-only at DB level: block UPDATE and DELETE
CREATE OR REPLACE RULE no_update_immutable_audit AS
  ON UPDATE TO mcp_immutable_audit_log DO INSTEAD NOTHING;

CREATE OR REPLACE RULE no_delete_immutable_audit AS
  ON DELETE TO mcp_immutable_audit_log DO INSTEAD NOTHING;

-- Indexes for common queries (created_at range, key, user)
CREATE INDEX IF NOT EXISTS idx_immutable_audit_created    ON mcp_immutable_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_immutable_audit_key_prefix ON mcp_immutable_audit_log (api_key_prefix, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_immutable_audit_request_id ON mcp_immutable_audit_log (request_id) WHERE request_id IS NOT NULL;
