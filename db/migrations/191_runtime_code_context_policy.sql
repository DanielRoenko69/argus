-- Governed source-context handoff for out-of-process Agent runtimes.
-- Existing and newly created profiles remain metadata-only until a platform
-- administrator explicitly enables bounded source sharing.

ALTER TABLE mcp_agent_runtime_profiles
  ADD COLUMN IF NOT EXISTS code_context_mode VARCHAR(24) NOT NULL DEFAULT 'metadata_only',
  ADD COLUMN IF NOT EXISTS code_context_max_results SMALLINT NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS code_context_max_bytes INTEGER NOT NULL DEFAULT 12000;

ALTER TABLE mcp_agent_runtime_profiles
  DROP CONSTRAINT IF EXISTS mcp_agent_runtime_profiles_code_context_mode_check,
  DROP CONSTRAINT IF EXISTS mcp_agent_runtime_profiles_code_context_results_check,
  DROP CONSTRAINT IF EXISTS mcp_agent_runtime_profiles_code_context_bytes_check;

ALTER TABLE mcp_agent_runtime_profiles
  ADD CONSTRAINT mcp_agent_runtime_profiles_code_context_mode_check
    CHECK (code_context_mode IN ('metadata_only', 'bounded_source')),
  ADD CONSTRAINT mcp_agent_runtime_profiles_code_context_results_check
    CHECK (code_context_max_results BETWEEN 1 AND 8),
  ADD CONSTRAINT mcp_agent_runtime_profiles_code_context_bytes_check
    CHECK (code_context_max_bytes BETWEEN 1024 AND 24000);

COMMENT ON COLUMN mcp_agent_runtime_profiles.code_context_mode IS
  'Controls whether an out-of-process runtime receives commit metadata only or bounded source excerpts. Defaults fail closed.';
COMMENT ON COLUMN mcp_agent_runtime_profiles.code_context_max_results IS
  'Maximum source evidence items returned for one externally shared code-context request.';
COMMENT ON COLUMN mcp_agent_runtime_profiles.code_context_max_bytes IS
  'Maximum aggregate UTF-8 bytes returned for one externally shared code-context request.';
