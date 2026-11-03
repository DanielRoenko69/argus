-- Audit #2 — workflow-level human oversight for sensitive tool steps.
--
-- The human-approval-gate hook (priority 900) already blocks sensitive tools
-- (k8s_apply, helmrelease_deploy, gitea_create_pr, …) when the calling AGENT
-- has mcp_agents.human_oversight_required = true. Workflow tool steps run with
-- a synthetic agentId = 0 (no agent row), so that check no-ops — a cron/webhook
-- /builder/admin-run workflow could invoke those same tools with no approval.
--
-- This flag lets a workflow opt into the same gate: when true, the
-- human-approval-gate blocks sensitive tools invoked directly by the workflow's
-- steps (ctx.workflowId is threaded in via the hooked tool runner).
ALTER TABLE mcp_workflows
  ADD COLUMN IF NOT EXISTS human_oversight_required boolean NOT NULL DEFAULT false;
