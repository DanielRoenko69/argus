-- Provider-neutral visual reference workflow for governed multi-Agent delivery.
--
-- The template deliberately stores Agent roles instead of database IDs. Argus
-- Core resolves those roles during preflight and snapshots the concrete Agent,
-- runtime, skills, bundles and tools before execution.

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
  'tpl_governed_agent_delivery',
  '[Template] Manual task -> Planner -> Coder -> Reviewer -> Response. Portable Agent roles with fail-closed preflight.',
  $steps$[
    {
      "id":"start",
      "label":"Manual task",
      "type":"trigger.manual",
      "args":{}
    },
    {
      "id":"plan",
      "label":"Plan delivery",
      "type":"argus.agent",
      "agent_role":"planner",
      "output_contract":"planner_plan",
      "output_contract_retries":1,
      "args":{
        "prompt":"Create a concise, implementation-ready plan for the task below. State scope, assumptions, likely files or components, validation steps and material risks. Do not edit files.\n\nTask:\n{{ input.task }}"
      },
      "depends_on":["start"]
    },
    {
      "id":"implement",
      "label":"Implement task",
      "type":"argus.agent",
      "agent_role":"coder",
      "output_contract":"implementation_evidence",
      "output_contract_retries":1,
      "args":{
        "prompt":"Implement the requested task in the assigned workspace. Follow the approved plan, inspect before editing, keep the change scoped and run the relevant validation. Report changed files and actual test evidence.\n\nTask:\n{{ input.task }}\n\nPlanner output:\n{{ steps.plan.result }}"
      },
      "depends_on":["plan"]
    },
    {
      "id":"review",
      "label":"Review evidence",
      "type":"argus.agent",
      "agent_role":"reviewer",
      "output_contract":"review_verdict",
      "output_contract_retries":1,
      "args":{
        "prompt":"Review the implementation evidence against the original task and plan. Check correctness, regressions, security, maintainability and test coverage. Do not modify files. End with APPROVE or REQUEST_CHANGES and concrete reasons.\n\nTask:\n{{ input.task }}\n\nPlan:\n{{ steps.plan.result }}\n\nImplementation evidence:\n{{ steps.implement.result }}"
      },
      "depends_on":["implement"]
    },
    {
      "id":"approval",
      "label":"Approve delivery",
      "type":"argus.approval",
      "args":{"message":"Review the planner, implementation and reviewer evidence. Approve this delivery handoff?"},
      "depends_on":["review"]
    },
    {
      "id":"response",
      "label":"Delivery result",
      "type":"logic.response",
      "args":{"value":"{{ steps.review.result }}"},
      "depends_on":["approval"]
    }
  ]$steps$::jsonb,
  '[{"name":"task","type":"string","description":"Scoped implementation task for the Agent chain","required":true}]'::jsonb,
  '{"viewport":{"x":20,"y":180,"zoom":0.82},"theme":"dark"}'::jsonb,
  '{"type":"manual"}'::jsonb,
  $blocks$[
    {"id":"start","type":"trigger.manual","position":{"x":40,"y":180},"data":{"label":"Manual task","args":{}}},
    {"id":"plan","type":"argus.agent","position":{"x":330,"y":180},"data":{"label":"Plan delivery","agent_role":"planner","output_contract":"planner_plan","output_contract_retries":1,"args":{"prompt":"Create a concise, implementation-ready plan for the task below. State scope, assumptions, likely files or components, validation steps and material risks. Do not edit files.\n\nTask:\n{{ input.task }}"}}},
    {"id":"implement","type":"argus.agent","position":{"x":620,"y":180},"data":{"label":"Implement task","agent_role":"coder","output_contract":"implementation_evidence","output_contract_retries":1,"args":{"prompt":"Implement the requested task in the assigned workspace. Follow the approved plan, inspect before editing, keep the change scoped and run the relevant validation. Report changed files and actual test evidence.\n\nTask:\n{{ input.task }}\n\nPlanner output:\n{{ steps.plan.result }}"}}},
    {"id":"review","type":"argus.agent","position":{"x":910,"y":180},"data":{"label":"Review evidence","agent_role":"reviewer","output_contract":"review_verdict","output_contract_retries":1,"args":{"prompt":"Review the implementation evidence against the original task and plan. Check correctness, regressions, security, maintainability and test coverage. Do not modify files. End with APPROVE or REQUEST_CHANGES and concrete reasons.\n\nTask:\n{{ input.task }}\n\nPlan:\n{{ steps.plan.result }}\n\nImplementation evidence:\n{{ steps.implement.result }}"}}},
    {"id":"approval","type":"argus.approval","position":{"x":1200,"y":180},"data":{"label":"Approve delivery","args":{"message":"Review the planner, implementation and reviewer evidence. Approve this delivery handoff?"}}},
    {"id":"response","type":"logic.response","position":{"x":1490,"y":180},"data":{"label":"Delivery result","args":{"value":"{{ steps.review.result }}"}}}
  ]$blocks$::jsonb,
  'template',
  false,
  true,
  $contract$[
    {
      "role":"planner",
      "label":"Delivery planner",
      "stepIds":["plan"],
      "allowedModes":["chat","worker"],
      "requiredSkillNames":[],
      "requiredToolPatterns":[],
      "minimumBundleCount":0
    },
    {
      "role":"coder",
      "label":"Workspace implementation",
      "stepIds":["implement"],
      "allowedModes":["worker"],
      "requiredSkillNames":[],
      "requiredToolPatterns":["workspace_read","workspace_write"],
      "minimumBundleCount":0
    },
    {
      "role":"reviewer",
      "label":"Read-only implementation review",
      "stepIds":["review"],
      "allowedModes":["reviewer","worker"],
      "requiredSkillNames":[],
      "requiredToolPatterns":[],
      "minimumBundleCount":0
    }
  ]$contract$::jsonb
)
ON CONFLICT (name) DO NOTHING;
