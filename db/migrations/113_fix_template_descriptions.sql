-- Migration 113: repair mojibake in starter-template descriptions.
--
-- Migration 089 seeded the workflow templates with correct UTF-8 arrows (→,
-- U+2192) in their descriptions, but on the live DB those rows were applied via
-- a Windows psql client whose console code page mangled the 3-byte arrow into
-- the literal string '???'. The 089 source is fine — only the stored rows are
-- affected, and only the `description` column (steps/prompts are intact).
--
-- This migration runs through the Node migration runner (fs.readFile utf-8 +
-- pg UTF8 client), so the arrows below are stored byte-for-byte correctly.
-- Idempotent: re-running sets the same values.

UPDATE mcp_workflows
   SET description = '[Template] Cron 09:00 → memory retrieve last 24h → agent → Slack'
 WHERE name = 'tpl_daily_report';

UPDATE mcp_workflows
   SET description = '[Template] Auto-Triage: pod-name → kubectl logs → architect summary → Slack post'
 WHERE name = 'tpl_k8s_incident_triage';

UPDATE mcp_workflows
   SET description = '[Template] Webhook (question) → RAG knowledge → Agent answer → Response'
 WHERE name = 'tpl_webhook_rag_qa';
