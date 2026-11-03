-- Tool-free visual reference for bounded item processing.
-- Demonstrates Function -> For Each -> Table -> Response with deterministic
-- result ordering and no Agent, model, MCP connection or approval dependency.

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
  'tpl_for_each_pipeline',
  '[Template] Build a service list, process every item with bounded concurrency and return ordered structured evidence.',
  $steps$[
    {
      "id":"start",
      "label":"Manual service input",
      "type":"trigger.manual",
      "args":{}
    },
    {
      "id":"seed",
      "label":"Build service list",
      "type":"logic.function",
      "function_code":"return input.services_csv.split(',').map(value => value.trim()).filter(Boolean);",
      "args":{},
      "depends_on":["start"]
    },
    {
      "id":"foreach",
      "label":"Prepare service checks",
      "type":"logic.for_each",
      "function_code":"const service = String(item);\nreturn {\n  position: index + 1,\n  service,\n  environment: input.environment,\n  health_path: '/health/' + service,\n  correlation_key: input.environment + ':' + service\n};",
      "args":{
        "mode":"transform",
        "items":"{{ steps.seed.result }}",
        "concurrency":4,
        "retries":0,
        "on_item_error":"stop"
      },
      "depends_on":["seed"]
    },
    {
      "id":"table",
      "label":"Ordered service checks",
      "type":"logic.table",
      "args":{"rows":"{{ steps.foreach.result.values }}"},
      "depends_on":["foreach"]
    },
    {
      "id":"response",
      "label":"For Each evidence",
      "type":"logic.response",
      "args":{"value":"{{ steps.foreach.result }}"},
      "depends_on":["table"]
    }
  ]$steps$::jsonb,
  $inputs$[
    {"name":"environment","type":"string","description":"Target environment label","required":true,"default":"demo"},
    {"name":"services_csv","type":"string","description":"Comma-separated service names","required":true,"default":"checkout-api,payments-worker,portal-web"}
  ]$inputs$::jsonb,
  '{"viewport":{"x":25,"y":220,"zoom":0.8},"theme":"dark"}'::jsonb,
  '{"type":"manual"}'::jsonb,
  $blocks$[
    {"id":"start","type":"trigger.manual","position":{"x":40,"y":220},"data":{"label":"Manual service input","args":{}}},
    {"id":"seed","type":"logic.function","position":{"x":330,"y":220},"data":{"label":"Build service list","function_code":"return input.services_csv.split(',').map(value => value.trim()).filter(Boolean);","args":{}}},
    {"id":"foreach","type":"logic.for_each","position":{"x":620,"y":220},"data":{"label":"Prepare service checks","function_code":"const service = String(item);\nreturn {\n  position: index + 1,\n  service,\n  environment: input.environment,\n  health_path: '/health/' + service,\n  correlation_key: input.environment + ':' + service\n};","args":{"mode":"transform","items":"{{ steps.seed.result }}","concurrency":4,"retries":0,"on_item_error":"stop"}}},
    {"id":"table","type":"logic.table","position":{"x":910,"y":220},"data":{"label":"Ordered service checks","args":{"rows":"{{ steps.foreach.result.values }}"}}},
    {"id":"response","type":"logic.response","position":{"x":1200,"y":220},"data":{"label":"For Each evidence","args":{"value":"{{ steps.foreach.result }}"}}}
  ]$blocks$::jsonb,
  'template',
  false,
  false,
  '[]'::jsonb
)
ON CONFLICT (name) DO NOTHING;
