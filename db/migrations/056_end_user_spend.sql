-- Track end-user (request body "user" field) in spend logs
-- Enables per-service / per-caller spend attribution within a shared key
ALTER TABLE mcp_spend_logs ADD COLUMN IF NOT EXISTS end_user TEXT;
CREATE INDEX IF NOT EXISTS idx_spend_logs_end_user ON mcp_spend_logs (end_user) WHERE end_user IS NOT NULL;
