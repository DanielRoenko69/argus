-- GitHub MCP's current issue_read contract requires an explicit operation.
-- Migration 200 may already be applied in development environments, so keep
-- this forward-only repair even though the original seed now contains it too.

UPDATE mcp_workflows
SET steps = (
  SELECT jsonb_agg(
    CASE WHEN step->>'id' = 'read_issue' THEN
      jsonb_set(
        jsonb_set(step, '{args,method}', '"get"'::jsonb, true),
        '{tool_binding,required_parameters}',
        '["method","owner","repo","issue_number"]'::jsonb,
        true
      )
    ELSE step END
    ORDER BY ordinal
  )
  FROM jsonb_array_elements(steps) WITH ORDINALITY AS item(step, ordinal)
),
block_definitions = (
  SELECT jsonb_agg(
    CASE WHEN block->>'id' = 'read_issue' THEN
      jsonb_set(
        jsonb_set(block, '{data,args,method}', '"get"'::jsonb, true),
        '{data,tool_binding,required_parameters}',
        '["method","owner","repo","issue_number"]'::jsonb,
        true
      )
    ELSE block END
    ORDER BY ordinal
  )
  FROM jsonb_array_elements(block_definitions) WITH ORDINALITY AS item(block, ordinal)
)
WHERE name = 'tpl_github_issue_triage_slack'
  AND source = 'template';
