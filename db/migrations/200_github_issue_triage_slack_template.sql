-- Integration-aware visual workflow reference.
--
-- Concrete MCP tool names are intentionally not stored in this template:
-- prefixes are connection-specific (for example github_product_get_issue).
-- Argus Core resolves each tool_binding against the cloning user's accessible,
-- connected and trusted MCP catalog before creating an executable workflow.

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
  'tpl_github_issue_triage_slack',
  '[Template] Read a GitHub issue, let an Argus Agent produce triage evidence, then post the result to Slack through governed connector access.',
  $steps$[
    {
      "id":"start",
      "label":"Triage request",
      "type":"trigger.manual",
      "args":{}
    },
    {
      "id":"read_issue",
      "label":"Read GitHub issue",
      "type":"argus.tool",
      "tool_binding":{
        "integration_id":"github",
        "action_hints":["get_issue","issue_read"],
        "access":"read",
        "required_parameters":["method","owner","repo","issue_number"]
      },
      "args":{
        "method":"get",
        "owner":"{{ input.repository_owner }}",
        "repo":"{{ input.repository_name }}",
        "issue_number":"{{ input.issue_number }}"
      },
      "depends_on":["start"]
    },
    {
      "id":"triage",
      "label":"Analyze and prioritize",
      "type":"argus.agent",
      "agent_role":"planner",
      "args":{
        "prompt":"Analyze the GitHub issue evidence below. Produce a concise triage report with: summary, probable component, severity, implementation outline, validation plan, risks and an explicit recommended next action. Do not call external systems and do not invent repository facts.\n\nRepository: {{ input.repository_owner }}/{{ input.repository_name }}\nIssue: #{{ input.issue_number }}\n\nGitHub evidence:\n{{ steps.read_issue.result }}"
      },
      "depends_on":["read_issue"]
    },
    {
      "id":"notify",
      "label":"Post triage to Slack",
      "type":"argus.tool",
      "tool_binding":{
        "integration_id":"slack",
        "action_hints":["post_message","send_message"],
        "access":"write",
        "required_parameters":["channel_id","text"]
      },
      "args":{
        "channel_id":"{{ input.notification_channel }}",
        "text":"GitHub issue triage for {{ input.repository_owner }}/{{ input.repository_name }}#{{ input.issue_number }}\n\n{{ steps.triage.result }}"
      },
      "depends_on":["triage"]
    },
    {
      "id":"response",
      "label":"Triage result",
      "type":"logic.response",
      "args":{
        "value":"{{ steps.triage.result }}"
      },
      "depends_on":["notify"]
    }
  ]$steps$::jsonb,
  $inputs$[
    {"name":"repository_owner","type":"string","description":"GitHub organization or repository owner","required":true},
    {"name":"repository_name","type":"string","description":"GitHub repository name","required":true},
    {"name":"issue_number","type":"number","description":"GitHub issue number","required":true},
    {"name":"notification_channel","type":"string","description":"Slack channel ID that receives triage evidence","required":true}
  ]$inputs$::jsonb,
  '{"viewport":{"x":18,"y":180,"zoom":0.78},"theme":"dark"}'::jsonb,
  '{"type":"manual"}'::jsonb,
  $blocks$[
    {"id":"start","type":"trigger.manual","position":{"x":40,"y":200},"data":{"label":"Triage request","args":{}}},
    {"id":"read_issue","type":"argus.tool","position":{"x":320,"y":200},"data":{"label":"Read GitHub issue","tool_binding":{"integration_id":"github","action_hints":["get_issue","issue_read"],"access":"read","required_parameters":["method","owner","repo","issue_number"]},"args":{"method":"get","owner":"{{ input.repository_owner }}","repo":"{{ input.repository_name }}","issue_number":"{{ input.issue_number }}"}}},
    {"id":"triage","type":"argus.agent","position":{"x":610,"y":200},"data":{"label":"Analyze and prioritize","agent_role":"planner","args":{"prompt":"Analyze the GitHub issue evidence below. Produce a concise triage report with: summary, probable component, severity, implementation outline, validation plan, risks and an explicit recommended next action. Do not call external systems and do not invent repository facts.\n\nRepository: {{ input.repository_owner }}/{{ input.repository_name }}\nIssue: #{{ input.issue_number }}\n\nGitHub evidence:\n{{ steps.read_issue.result }}"}}},
    {"id":"notify","type":"argus.tool","position":{"x":900,"y":200},"data":{"label":"Post triage to Slack","tool_binding":{"integration_id":"slack","action_hints":["post_message","send_message"],"access":"write","required_parameters":["channel_id","text"]},"args":{"channel_id":"{{ input.notification_channel }}","text":"GitHub issue triage for {{ input.repository_owner }}/{{ input.repository_name }}#{{ input.issue_number }}\n\n{{ steps.triage.result }}"}}},
    {"id":"response","type":"logic.response","position":{"x":1190,"y":200},"data":{"label":"Triage result","args":{"value":"{{ steps.triage.result }}"}}}
  ]$blocks$::jsonb,
  'template',
  false,
  false,
  $contract$[
    {
      "role":"planner",
      "label":"Issue triage analyst",
      "stepIds":["triage"],
      "allowedModes":["chat","worker"],
      "requiredSkillNames":[],
      "requiredToolPatterns":[],
      "minimumBundleCount":0
    }
  ]$contract$::jsonb
)
ON CONFLICT (name) DO NOTHING;
