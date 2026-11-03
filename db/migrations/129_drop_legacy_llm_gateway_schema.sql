-- Remove the unused LiteLLM-compatible gateway schema.
--
-- The provider-neutral model catalog (mcp_models) and historical LLM usage
-- (mcp_spend_logs) remain: direct agents and workflow analytics use them.

ALTER TABLE mcp_api_keys
  DROP COLUMN IF EXISTS allowed_models,
  DROP COLUMN IF EXISTS denied_models,
  DROP COLUMN IF EXISTS max_budget,
  DROP COLUMN IF EXISTS budget_duration,
  DROP COLUMN IF EXISTS current_spend,
  DROP COLUMN IF EXISTS spend_reset_at,
  DROP COLUMN IF EXISTS tpm_limit,
  DROP COLUMN IF EXISTS rpm_limit,
  DROP COLUMN IF EXISTS max_parallel_requests,
  DROP COLUMN IF EXISTS team_id,
  DROP COLUMN IF EXISTS org_id,
  DROP COLUMN IF EXISTS project_id,
  DROP COLUMN IF EXISTS max_request_size_bytes,
  DROP COLUMN IF EXISTS passthrough_url,
  DROP COLUMN IF EXISTS budget_limits;

DROP TABLE IF EXISTS mcp_batch_requests;
DROP TABLE IF EXISTS mcp_batches;
DROP TABLE IF EXISTS mcp_deployment_health;
DROP TABLE IF EXISTS mcp_fallbacks;
DROP TABLE IF EXISTS mcp_fine_tuning_jobs;
DROP TABLE IF EXISTS mcp_guardrail_assignments;
DROP TABLE IF EXISTS mcp_guardrails;
DROP TABLE IF EXISTS mcp_ip_acls;
DROP TABLE IF EXISTS mcp_projects;
DROP TABLE IF EXISTS mcp_team_members;
DROP TABLE IF EXISTS mcp_teams;
DROP TABLE IF EXISTS mcp_organizations;
DROP TABLE IF EXISTS mcp_transforms;
DROP TABLE IF EXISTS mcp_webhook_deliveries;
DROP TABLE IF EXISTS mcp_webhooks;
DROP TABLE IF EXISTS mcp_allowed_ips;
DROP TABLE IF EXISTS mcp_semantic_cache;
