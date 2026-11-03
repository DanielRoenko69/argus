-- OpenAPI importer prefixes are up to 32 characters; the materialized backend
-- identifier prepends "custom:" and must fit update-history rows on re-import.
ALTER TABLE mcp_tools_history
  ALTER COLUMN backend TYPE VARCHAR(128);
