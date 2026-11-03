-- Deterministic Git provider used by the LangGraph Golden Path.
-- The provider API is served by fake-workspace; no external Git service is
-- contacted during the local certification run.
INSERT INTO mcp_service_bundles (name, label, description)
VALUES (
  'argus_e2e_gitea',
  'Argus E2E Gitea',
  'Synthetic Gitea bundle for the local Golden Path.'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_backends (
  name, description, base_url, auth_type, auth_value, health_path,
  default_headers, timeout_ms, tls_skip_verify, enabled, backend_type, config
)
VALUES (
  'gitea-argus-e2e',
  'Synthetic Gitea provider for the local Golden Path.',
  'http://fake-workspace:4200',
  'bearer',
  'argus-e2e-gitea-token',
  '/health',
  '{}'::jsonb,
  10000,
  false,
  true,
  'http',
  '{"kind":"gitea","project_key":"argus-e2e","repo_slug":"argus-e2e-repo","default_target_branch":"master"}'::jsonb
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT backend.id, bundle.id
  FROM mcp_backends backend
  CROSS JOIN mcp_service_bundles bundle
 WHERE backend.name = 'gitea-argus-e2e'
   AND bundle.name = 'argus_e2e_gitea'
ON CONFLICT DO NOTHING;

-- The Golden Path preflight validates the exact bounded capabilities before a
-- run may start. These deterministic tools describe that provider contract;
-- the broader E2E later executes the real fake-workspace Gitea path through
-- Argus Dev.
INSERT INTO mcp_tools (name, description, backend, query_template, parameters, enabled, category)
VALUES
  (
    'argus_e2e_gitea_get_issue',
    'Read the configured Golden Path issue from the deterministic Gitea fixture.',
    'postgresql',
    $$SELECT 'ARGUS_E2E_GITEA_ISSUE_READ' AS status$$,
    '[]'::jsonb,
    true,
    'e2e-golden-path'
  ),
  (
    'argus_e2e_gitea_comment_issue',
    'Post a bounded comment to the configured Golden Path issue.',
    'postgresql',
    $$SELECT 'ARGUS_E2E_GITEA_COMMENT_WRITTEN' AS status$$,
    '[]'::jsonb,
    true,
    'e2e-golden-path'
  ),
  (
    'argus_e2e_gitea_add_label',
    'Add the bounded triaged label to the configured Golden Path issue.',
    'postgresql',
    $$SELECT 'ARGUS_E2E_GITEA_LABEL_WRITTEN' AS status$$,
    '[]'::jsonb,
    true,
    'e2e-golden-path'
  )
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
SELECT tool.id, bundle.id
  FROM mcp_tools tool
  CROSS JOIN mcp_service_bundles bundle
 WHERE bundle.name = 'argus_e2e_gitea'
   AND tool.name IN (
     'argus_e2e_gitea_get_issue',
     'argus_e2e_gitea_comment_issue',
     'argus_e2e_gitea_add_label'
   )
ON CONFLICT DO NOTHING;

-- Notification is intentionally a separate Bundle so the preflight proves
-- least-privilege scope for Git and Slack independently.
INSERT INTO mcp_service_bundles (name, label, description)
VALUES (
  'argus_e2e_slack_fixture',
  'Argus E2E Slack Fixture',
  'Synthetic Slack bundle for the local Golden Path.'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_backends (
  name, description, base_url, auth_type, health_path,
  default_headers, timeout_ms, tls_skip_verify, enabled, backend_type, config
)
VALUES (
  'slack-fixture-argus-e2e',
  'Synthetic Slack provider for the local Golden Path.',
  'http://fake-mcp:4100',
  'none',
  '/health',
  '{}'::jsonb,
  5000,
  false,
  true,
  'http',
  '{"kind":"slack_fixture","destination":"argus-e2e-golden-path"}'::jsonb
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
SELECT backend.id, bundle.id
  FROM mcp_backends backend
  CROSS JOIN mcp_service_bundles bundle
 WHERE backend.name = 'slack-fixture-argus-e2e'
   AND bundle.name = 'argus_e2e_slack_fixture'
ON CONFLICT DO NOTHING;

INSERT INTO mcp_tools (name, description, backend, query_template, parameters, enabled, category)
VALUES
(
  'argus_e2e_slack_post_message',
  'Post the bounded Golden Path notification to the deterministic Slack destination.',
  'postgresql',
  $$SELECT 'ARGUS_E2E_SLACK_MESSAGE_WRITTEN' AS status$$,
  '[]'::jsonb,
  true,
  'e2e-golden-path'
),
(
  'argus_e2e_slack_post_message_flaky',
  'Fail the first bounded notification attempt and succeed the checkpoint retry.',
  'http',
  $$POST http://fake-mcp:4100/golden-path/slack-flaky
Content-Type: application/json

{"destination":"argus-e2e-golden-path"}$$,
  '[]'::jsonb,
  true,
  'e2e-golden-path'
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
SELECT tool.id, bundle.id
  FROM mcp_tools tool
  CROSS JOIN mcp_service_bundles bundle
 WHERE tool.name IN ('argus_e2e_slack_post_message', 'argus_e2e_slack_post_message_flaky')
   AND bundle.name = 'argus_e2e_slack_fixture'
ON CONFLICT DO NOTHING;
