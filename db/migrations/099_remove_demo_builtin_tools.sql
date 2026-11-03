-- Migration 099: Remove auto-seeded demo / built-in tools
--
-- A fresh install seeded a pile of example/demo tools (migration 004 builtin:*
-- backends + legacy IT-Ops demo tools) that only clutter the Tools list and
-- confuse operators. Real tools should come from user-added marketplace
-- backends (e.g. custom:kubernetes, langgraph). This migration removes the
-- demo/built-in tools so every cluster — existing AND freshly seeded — ends up
-- clean. Idempotent: re-running deletes nothing extra.
--
-- NOTE: this also removes the zero-config in-cluster builtin:kubernetes tools
-- (k8s_*). Clusters that want K8s access add it via the Marketplace
-- "Kubernetes API" backend (custom:kubernetes) instead.

DELETE FROM mcp_tools WHERE backend LIKE 'builtin:%';

DELETE FROM mcp_tools WHERE name IN (
  'dpost_get_document_status',
  'dpost_list_processing_errors',
  'dpost_queue_stats',
  'logs_search_errors',
  'app_health_check'
);
