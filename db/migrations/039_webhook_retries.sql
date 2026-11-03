CREATE TABLE IF NOT EXISTS mcp_webhook_deliveries (
  id            BIGSERIAL PRIMARY KEY,
  webhook_id    INTEGER REFERENCES mcp_webhooks(id) ON DELETE CASCADE,
  event         VARCHAR(32) NOT NULL,
  request_id    VARCHAR(64),
  status        VARCHAR(16) DEFAULT 'pending'
                CHECK (status IN ('pending','delivered','failed','retrying')),
  attempt_count INTEGER DEFAULT 0,
  last_error    TEXT,
  next_retry_at TIMESTAMPTZ,
  payload       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  delivered_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry
  ON mcp_webhook_deliveries(status, next_retry_at)
  WHERE status IN ('pending','retrying');

ALTER TABLE mcp_webhooks
  ADD COLUMN IF NOT EXISTS max_retries    INTEGER DEFAULT 3,
  ADD COLUMN IF NOT EXISTS retry_delay_ms INTEGER DEFAULT 5000;
