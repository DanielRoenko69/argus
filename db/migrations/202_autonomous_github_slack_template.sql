-- The reference GitHub-to-Slack automation is intentionally autonomous.
-- Connector/user policy still controls access and every step remains audited.
-- Users can add an explicit argus.approval block or enable guarded writes when
-- their environment needs per-run human oversight.
UPDATE mcp_workflows
SET description = '[Template] Read a GitHub issue, let an Argus Agent produce triage evidence, then post the result to Slack through governed connector access.',
    human_oversight_required = false,
    steps = (
      SELECT jsonb_agg(
        CASE
          WHEN step->>'id' = 'notify' THEN jsonb_set(step, '{depends_on}', '["triage"]'::jsonb)
          ELSE step
        END
        ORDER BY ordinal
      )
      FROM jsonb_array_elements(mcp_workflows.steps) WITH ORDINALITY AS item(step, ordinal)
      WHERE step->>'id' <> 'approval'
    ),
    block_definitions = (
      SELECT jsonb_agg(
        CASE
          WHEN block->>'id' = 'notify' THEN jsonb_set(block, '{position}', '{"x":900,"y":200}'::jsonb)
          WHEN block->>'id' = 'response' THEN jsonb_set(block, '{position}', '{"x":1190,"y":200}'::jsonb)
          ELSE block
        END
        ORDER BY ordinal
      )
      FROM jsonb_array_elements(mcp_workflows.block_definitions) WITH ORDINALITY AS item(block, ordinal)
      WHERE block->>'id' <> 'approval'
    ),
    updated_at = now()
WHERE name = 'tpl_github_issue_triage_slack'
  AND source = 'template';
