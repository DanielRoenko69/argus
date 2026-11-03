-- Migration 097 — seed default Bitbucket-Backend + Bundle for the Coding workflow.
-- Token (auth_value) is left NULL — user fills it in via Argus /admin/backends UI
-- after first deploy. Argus encrypts it on save (AES-256-GCM + DB_ENCRYPTION_KEY).
--
-- Once the backend has a token + is linked to a bundle + the bundle is assigned to
-- a workflow, LangGraph can resolve creds per workflow_id via
-- GET /api/internal/workflow-creds/:workflowId/bitbucket (introduced in R2).

-- ── 1. Default Bitbucket Backend (auth_value=NULL initially) ─────────
INSERT INTO mcp_backends (
  name, description, base_url, auth_type, auth_value,
  health_path, default_headers, timeout_ms, tls_skip_verify, enabled,
  backend_type, config
)
VALUES (
  'bitbucket-default',
  'Default Bitbucket backend for the Coding workflow. Paste PAT into auth_value via /admin/backends UI — Argus encrypts on save.',
  'https://bitbucket.example.com',
  'bearer',
  NULL,    -- USER MUST FILL VIA UI
  '/',
  '{}'::jsonb,
  30000,
  false,
  true,
  'http',
  jsonb_build_object(
    'kind',            'bitbucket',
    'project_key',     '',
    'user_slug',       '',
    'repo_slug',       '',
    'default_target_branch', 'master'
  )
)
ON CONFLICT (name) DO NOTHING;

-- ── 2. Default Bundle for the Coding workflow ───────────────────────
INSERT INTO mcp_service_bundles (name, label, description)
VALUES (
  'coding-ops',
  'Coding Ops',
  'Backends + tools required by the LangGraph Coding workflow (Bitbucket etc.). Assign to a workflow via /admin/workflows.'
)
ON CONFLICT (name) DO NOTHING;

-- ── 3. Link the Bitbucket-Backend to the coding-ops Bundle ──────────
INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT b.id, sb.id
FROM mcp_backends b, mcp_service_bundles sb
WHERE b.name = 'bitbucket-default' AND sb.name = 'coding-ops'
ON CONFLICT (backend_id, bundle_id) DO NOTHING;

COMMENT ON COLUMN mcp_backends.config IS
  'Backend-specific config (e.g. K8s clusters, Bitbucket project/repo). For bitbucket kind: {kind, project_key, user_slug, repo_slug, default_target_branch}';
