-- Migration 013: Gateway logs table for MCP server request/event logging
CREATE TABLE IF NOT EXISTS gateway_logs (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  level       VARCHAR(16) NOT NULL DEFAULT 'info',
  msg         TEXT NOT NULL,
  data        JSONB,
  req_id      VARCHAR(64),
  tool        VARCHAR(128),
  backend     VARCHAR(128),
  api_key_id  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gateway_logs_ts    ON gateway_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_gateway_logs_level ON gateway_logs (level);
CREATE INDEX IF NOT EXISTS idx_gateway_logs_tool  ON gateway_logs (tool);
