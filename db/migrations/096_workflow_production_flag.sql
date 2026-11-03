-- Migration 096 — Production-Cluster-Tag + per Step k8s_target_cluster für Approval-Gate.
-- Sec-Härtung Phase 1.

ALTER TABLE mcp_agents
  ADD COLUMN IF NOT EXISTS production_cluster_access BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN mcp_agents.production_cluster_access IS
  'When true, K8s/Helm/Terraform tools called by this agent against prod clusters trigger productionClusterGuard hook → human approval required.';

-- Per-Workflow-Step Target-Cluster (helmrelease_deploy, k8s_apply, etc.).
-- Step parameters are stored in mcp_workflow_steps.input_params JSONB —
-- nichts zu ändern, sondern Konvention: input_params.target_cluster = 'prod' | 'staging' | 'dev'.
-- Wir lesen das nur und enforcement passiert im Hook.

-- Liste der prod-cluster-Namen ist runtime-toggle:
INSERT INTO mcp_gateway_settings (category, key, value)
VALUES ('security', 'prod_cluster_names', '["prod","production","prod-eu","prod-us"]'::jsonb)
ON CONFLICT (category, key) DO NOTHING;
