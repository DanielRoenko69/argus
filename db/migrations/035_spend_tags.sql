-- 035: Tag-Based Spend Tracking
ALTER TABLE mcp_spend_logs ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_spend_logs_tags ON mcp_spend_logs USING GIN(tags);
