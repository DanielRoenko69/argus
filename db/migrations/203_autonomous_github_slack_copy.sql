-- Keep the already-installed reference template copy aligned with its
-- autonomous execution posture. This is intentionally separate from migration
-- 202 because applied migrations are immutable.
UPDATE mcp_workflows
SET input_params = (
      SELECT jsonb_agg(
        CASE
          WHEN input->>'name' = 'notification_channel'
            THEN jsonb_set(input, '{description}', '"Slack channel ID that receives triage evidence"'::jsonb)
          ELSE input
        END
        ORDER BY ordinal
      )
      FROM jsonb_array_elements(mcp_workflows.input_params) WITH ORDINALITY AS item(input, ordinal)
    ),
    updated_at = now()
WHERE name = 'tpl_github_issue_triage_slack'
  AND source = 'template';
