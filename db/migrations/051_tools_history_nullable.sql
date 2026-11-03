-- 051: relax NOT NULL on mcp_tools_history.query_template
--
-- Background: the save_mcp_tool_version trigger inserts the OLD row into
-- mcp_tools_history on every UPDATE. Pre-existing tool rows can have
-- query_template = NULL (e.g., remote-MCP / API-driven tools that don't
-- carry a SQL template), which made every UPDATE fail with a NOT NULL
-- violation in the history table. The history mirror should accept
-- whatever the live row has.
--
-- Idempotent: ALTER TABLE ... DROP NOT NULL is a no-op when already nullable.

ALTER TABLE mcp_tools_history
  ALTER COLUMN query_template DROP NOT NULL;
