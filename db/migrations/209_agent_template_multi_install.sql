-- A starter template may have one installed chat agent per model.
-- The agent name remains unique, while the lifecycle table tracks each variant.
ALTER TABLE mcp_agent_template_installations
  DROP CONSTRAINT IF EXISTS mcp_agent_template_installations_template_name_key;
