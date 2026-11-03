-- Tool-free visual reference for typed workflow data transformations.
-- Demonstrates Variables -> controlled Function -> Table -> Response without
-- requiring an Agent, model, MCP connection or human approval.

INSERT INTO mcp_workflows (
  name,
  description,
  steps,
  input_params,
  canvas_state,
  trigger_config,
  block_definitions,
  source,
  enabled,
  human_oversight_required,
  agent_requirements
)
VALUES (
  'tpl_data_transformation_pipeline',
  '[Template] Normalize typed inputs, derive priority metrics, validate them as table rows and return structured JSON.',
  $steps$[
    {
      "id":"start",
      "label":"Manual data input",
      "type":"trigger.manual",
      "args":{}
    },
    {
      "id":"variables",
      "label":"Normalize inputs",
      "type":"logic.variables",
      "args":{
        "variables":{
          "repository":"{{ input.repository }}",
          "open_issues":"{{ input.open_issues }}",
          "critical_issues":"{{ input.critical_issues }}"
        }
      },
      "depends_on":["start"]
    },
    {
      "id":"transform",
      "label":"Derive priority metrics",
      "type":"logic.function",
      "function_code":"return [\n  { metric: 'Open issues', value: input.open_issues, weight: 1 },\n  { metric: 'Critical issues', value: input.critical_issues, weight: 5 }\n].map((row, index) => ({\n  repository: input.repository,\n  position: index + 1,\n  ...row,\n  score: row.value * row.weight\n}));",
      "args":{},
      "depends_on":["variables"]
    },
    {
      "id":"table",
      "label":"Priority table",
      "type":"logic.table",
      "args":{"rows":"{{ steps.transform.result }}"},
      "depends_on":["transform"]
    },
    {
      "id":"response",
      "label":"Structured result",
      "type":"logic.response",
      "args":{"value":"{{ steps.table.result }}"},
      "depends_on":["table"]
    }
  ]$steps$::jsonb,
  $inputs$[
    {"name":"repository","type":"string","description":"Repository or service name","required":true},
    {"name":"open_issues","type":"number","description":"Current number of open issues","required":true},
    {"name":"critical_issues","type":"number","description":"Current number of critical issues","required":true}
  ]$inputs$::jsonb,
  '{"viewport":{"x":30,"y":210,"zoom":0.82},"theme":"dark"}'::jsonb,
  '{"type":"manual"}'::jsonb,
  $blocks$[
    {"id":"start","type":"trigger.manual","position":{"x":40,"y":210},"data":{"label":"Manual data input","args":{}}},
    {"id":"variables","type":"logic.variables","position":{"x":330,"y":210},"data":{"label":"Normalize inputs","args":{"variables":{"repository":"{{ input.repository }}","open_issues":"{{ input.open_issues }}","critical_issues":"{{ input.critical_issues }}"}}}},
    {"id":"transform","type":"logic.function","position":{"x":620,"y":210},"data":{"label":"Derive priority metrics","function_code":"return [\n  { metric: 'Open issues', value: input.open_issues, weight: 1 },\n  { metric: 'Critical issues', value: input.critical_issues, weight: 5 }\n].map((row, index) => ({\n  repository: input.repository,\n  position: index + 1,\n  ...row,\n  score: row.value * row.weight\n}));","args":{}}},
    {"id":"table","type":"logic.table","position":{"x":910,"y":210},"data":{"label":"Priority table","args":{"rows":"{{ steps.transform.result }}"}}},
    {"id":"response","type":"logic.response","position":{"x":1200,"y":210},"data":{"label":"Structured result","args":{"value":"{{ steps.table.result }}"}}}
  ]$blocks$::jsonb,
  'template',
  false,
  false,
  '[]'::jsonb
)
ON CONFLICT (name) DO NOTHING;
