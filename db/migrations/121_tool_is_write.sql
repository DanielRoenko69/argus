-- Migration 121: flag state-changing dynamic tools (OpenAPI write operations) so the
-- human-approval-gate can require oversight for them.
ALTER TABLE mcp_tools ADD COLUMN IF NOT EXISTS is_write BOOLEAN NOT NULL DEFAULT false;
