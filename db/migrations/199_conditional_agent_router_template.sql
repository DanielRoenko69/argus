-- Portable branching reference for the visual Argus.Dev runtime.
-- Only the selected Agent branch executes; the other branch is retained as
-- explicit skipped evidence before both paths join at the Response node.

INSERT INTO mcp_workflows (
  name, description, steps, input_params, canvas_state, trigger_config,
  block_definitions, source, enabled, human_oversight_required,
  agent_requirements
)
VALUES (
  'tpl_conditional_agent_router',
  '[Template] Route a request to exactly one governed Agent role and join both branches into one response.',
  $steps$[
    {"id":"start","label":"Manual request","type":"trigger.manual","args":{}},
    {
      "id":"route",
      "label":"Route intent",
      "type":"logic.router",
      "args":{
        "route_on":"{{ input.intent }}",
        "routes":{"plan":"planner","review":"reviewer"},
        "default_route":"planner"
      },
      "depends_on":["start"]
    },
    {
      "id":"planner",
      "label":"Planning branch",
      "type":"argus.agent",
      "agent_role":"planner",
      "output_contract":"planner_plan",
      "output_contract_retries":1,
      "args":{
        "prompt":"Create a concise, implementation-ready plan for the following task. Do not modify files or external systems.\n\nTask:\n{{ input.task }}"
      },
      "depends_on":["route"]
    },
    {
      "id":"reviewer",
      "label":"Review branch",
      "type":"argus.agent",
      "agent_role":"reviewer",
      "output_contract":"review_verdict",
      "output_contract_retries":1,
      "args":{
        "prompt":"Review the following request as a no-change validation. Do not modify files or external systems. End with an explicit APPROVE or REQUEST_CHANGES verdict.\n\nRequest:\n{{ input.task }}"
      },
      "depends_on":["route"]
    },
    {
      "id":"response",
      "label":"Selected branch result",
      "type":"logic.response",
      "args":{},
      "depends_on":["planner","reviewer"]
    }
  ]$steps$::jsonb,
  $inputs$[
    {"name":"intent","type":"string","description":"Branch value: plan or review","required":true,"default":"plan"},
    {"name":"task","type":"string","description":"Task for the selected Agent branch","required":true}
  ]$inputs$::jsonb,
  '{"viewport":{"x":30,"y":155,"zoom":0.82},"theme":"dark"}'::jsonb,
  '{"type":"manual"}'::jsonb,
  $blocks$[
    {"id":"start","type":"trigger.manual","position":{"x":40,"y":220},"data":{"label":"Manual request","args":{}}},
    {"id":"route","type":"logic.router","position":{"x":330,"y":220},"data":{"label":"Route intent","route_on":"{{ input.intent }}","routes":"{\n  \"plan\": \"planner\",\n  \"review\": \"reviewer\"\n}","default_route":"planner","args":{}}},
    {"id":"planner","type":"argus.agent","position":{"x":650,"y":90},"data":{"label":"Planning branch","agent_role":"planner","output_contract":"planner_plan","output_contract_retries":1,"args":{"prompt":"Create a concise, implementation-ready plan for the following task. Do not modify files or external systems.\n\nTask:\n{{ input.task }}"}}},
    {"id":"reviewer","type":"argus.agent","position":{"x":650,"y":350},"data":{"label":"Review branch","agent_role":"reviewer","output_contract":"review_verdict","output_contract_retries":1,"args":{"prompt":"Review the following request as a no-change validation. Do not modify files or external systems. End with an explicit APPROVE or REQUEST_CHANGES verdict.\n\nRequest:\n{{ input.task }}"}}},
    {"id":"response","type":"logic.response","position":{"x":990,"y":220},"data":{"label":"Selected branch result","args":{}}}
  ]$blocks$::jsonb,
  'template',
  false,
  false,
  $contract$[
    {
      "role":"planner",
      "label":"Planning branch",
      "stepIds":["planner"],
      "allowedModes":["chat","worker"],
      "requiredSkillNames":[],
      "requiredToolPatterns":[],
      "minimumBundleCount":0
    },
    {
      "role":"reviewer",
      "label":"Review branch",
      "stepIds":["reviewer"],
      "allowedModes":["reviewer","worker"],
      "requiredSkillNames":[],
      "requiredToolPatterns":[],
      "minimumBundleCount":0
    }
  ]$contract$::jsonb
)
ON CONFLICT (name) DO NOTHING;
