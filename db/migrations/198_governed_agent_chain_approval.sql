-- Upgrade an already-installed governed Agent chain template with the first
-- explicit visual human-in-the-loop gate. Fresh installations already receive
-- the node from migration 197; the predicates make this migration idempotent.

UPDATE mcp_workflows
SET steps = jsonb_set(
      jsonb_insert(
        steps,
        '{4}',
        '{"id":"approval","label":"Approve delivery","type":"argus.approval","args":{"message":"Review the planner, implementation and reviewer evidence. Approve this delivery handoff?"},"depends_on":["review"]}'::jsonb
      ),
      '{5,depends_on}',
      '["approval"]'::jsonb
    ),
    block_definitions = jsonb_insert(
      block_definitions,
      '{4}',
      '{"id":"approval","type":"argus.approval","position":{"x":1200,"y":180},"data":{"label":"Approve delivery","args":{"message":"Review the planner, implementation and reviewer evidence. Approve this delivery handoff?"}}}'::jsonb
    ),
    human_oversight_required = true,
    updated_at = NOW()
WHERE name = 'tpl_governed_agent_delivery'
  AND source = 'template'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(steps) AS node
    WHERE node->>'id' = 'approval'
  );

