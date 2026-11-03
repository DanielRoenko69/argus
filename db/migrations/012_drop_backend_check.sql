-- Migration 012: Drop legacy backend check constraint on mcp_tools
-- The constraint only allowed 'postgresql', 'opensearch', 'http', 'custom:*', 'builtin:*'
-- as backend values. With dynamic backends, the backend field is a free-form reference
-- to any mcp_backends.name — so this constraint must be removed.
ALTER TABLE mcp_tools DROP CONSTRAINT IF EXISTS mcp_tools_backend_check;
