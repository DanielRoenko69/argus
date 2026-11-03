CREATE TABLE IF NOT EXISTS mcp_batches (
  id               VARCHAR(64) PRIMARY KEY,
  api_key_prefix   VARCHAR(8) NOT NULL,
  status           VARCHAR(16) DEFAULT 'in_progress'
                   CHECK (status IN ('validating','in_progress','finalizing','completed','expired','cancelled','failed')),
  endpoint         VARCHAR(64) DEFAULT '/v1/chat/completions',
  request_counts   JSONB DEFAULT '{"total":0,"completed":0,"failed":0}',
  completion_window VARCHAR(16) DEFAULT '24h',
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT now(),
  expires_at       TIMESTAMPTZ DEFAULT (now() + interval '24 hours'),
  completed_at     TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mcp_batch_requests (
  id            BIGSERIAL PRIMARY KEY,
  batch_id      VARCHAR(64) REFERENCES mcp_batches(id) ON DELETE CASCADE,
  custom_id     VARCHAR(64) NOT NULL,
  request_body  JSONB NOT NULL,
  status        VARCHAR(16) DEFAULT 'pending'
                CHECK (status IN ('pending','processing','completed','failed')),
  response_body JSONB,
  error         JSONB,
  created_at    TIMESTAMPTZ DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_batch_requests_pending
  ON mcp_batch_requests(batch_id, status) WHERE status IN ('pending','processing');
