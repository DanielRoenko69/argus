-- EU AI Act compliance — risk classification for agents and tools.
-- Effective August 2, 2026. High-risk AI systems require audit trails + human oversight.
--
-- Risk levels per EU AI Act:
--   low    = informational agents, chat, knowledge retrieval (Annex III excluded)
--   medium = agents that make recommendations affecting users or processes
--   high   = agents that can modify production systems, deploy code, scale infra (Annex III)

ALTER TABLE mcp_agents
  ADD COLUMN IF NOT EXISTS risk_level TEXT NOT NULL DEFAULT 'low'
    CHECK (risk_level IN ('low', 'medium', 'high')),
  ADD COLUMN IF NOT EXISTS eu_ai_act_notes TEXT,
  ADD COLUMN IF NOT EXISTS human_oversight_required BOOLEAN NOT NULL DEFAULT false;

-- Dynamic tools that modify systems should be marked high-risk
ALTER TABLE mcp_tools
  ADD COLUMN IF NOT EXISTS risk_level TEXT NOT NULL DEFAULT 'low'
    CHECK (risk_level IN ('low', 'medium', 'high'));

-- Compliance settings (stored in mcp_settings, category = 'compliance')
-- Keys: eu_ai_act_enabled, eu_ai_act_operator_name, eu_ai_act_contact_email

COMMENT ON COLUMN mcp_agents.risk_level IS
  'EU AI Act risk classification. high = requires human oversight + detailed audit trail.';
COMMENT ON COLUMN mcp_agents.human_oversight_required IS
  'When true, requests from this agent include EU-AI-Act-Risk header and block if human approval missing.';
