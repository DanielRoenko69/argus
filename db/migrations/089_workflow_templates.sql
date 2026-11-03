-- Migration 089: Visual Workflow Builder — starter templates.
--
-- Templates live in mcp_workflows with source='template' and enabled=false
-- (they're not directly runnable; the builder clones them on "New from
-- template" and the clone gets source='visual', enabled=true).
--
-- All idempotent via ON CONFLICT (name) DO NOTHING.

-- ── K8s incident triage ─────────────────────────────────────────
INSERT INTO mcp_workflows (name, description, steps, canvas_state, block_definitions, source, enabled)
VALUES (
  'tpl_k8s_incident_triage',
  '[Template] Auto-Triage: pod-name → kubectl logs → architect summary → Slack post',
  $steps$[
    {"id":"trig","label":"Manual","type":"trigger.manual","args":{}},
    {"id":"logs","label":"K8s Pod Logs","type":"argus.tool","tool":"k8s_get_pod_logs","args":{"namespace":"{{ input.namespace }}","pod_name":"{{ input.pod }}","tail_lines":200},"depends_on":["trig"]},
    {"id":"summary","label":"Architect Summary","type":"argus.agent","agent_id":1,"args":{"prompt":"Fasse diese pod-logs zusammen, finde Root-Cause:\n\n{{ steps.logs.result }}"},"depends_on":["logs"]},
    {"id":"reply","label":"Response","type":"logic.response","args":{"value":"{{ steps.summary.result }}"},"depends_on":["summary"]}
  ]$steps$::jsonb,
  '{"viewport":{"x":0,"y":0,"zoom":1},"theme":"dark"}'::jsonb,
  $blocks$[
    {"id":"trig","type":"trigger.manual","position":{"x":50,"y":150},"data":{"label":"Manual","args":{}}},
    {"id":"logs","type":"argus.tool","position":{"x":280,"y":150},"data":{"label":"K8s Pod Logs","tool":"k8s_get_pod_logs","args":{"namespace":"{{ input.namespace }}","pod_name":"{{ input.pod }}","tail_lines":200}}},
    {"id":"summary","type":"argus.agent","position":{"x":520,"y":150},"data":{"label":"Architect Summary","agent_id":1,"args":{"prompt":"Fasse diese pod-logs zusammen, finde Root-Cause:\n\n{{ steps.logs.result }}"}}},
    {"id":"reply","type":"logic.response","position":{"x":770,"y":150},"data":{"label":"Response","args":{"value":"{{ steps.summary.result }}"}}}
  ]$blocks$::jsonb,
  'template', false
)
ON CONFLICT (name) DO NOTHING;

-- ── Daily report (cron) ─────────────────────────────────────────
INSERT INTO mcp_workflows (name, description, steps, canvas_state, block_definitions, source, enabled)
VALUES (
  'tpl_daily_report',
  '[Template] Cron 09:00 → memory retrieve last 24h → agent → Slack',
  $steps$[
    {"id":"trig","label":"Schedule 09:00","type":"trigger.schedule","args":{"cron_expr":"0 9 * * *"}},
    {"id":"mem","label":"Last 24h Memory","type":"argus.memory","args":{"operation":"retrieve","agent_id":1,"query":"recent_incidents","top_k":10},"depends_on":["trig"]},
    {"id":"rep","label":"Generate Report","type":"argus.agent","agent_id":1,"args":{"prompt":"Erstelle einen Tagesreport aus:\n\n{{ steps.mem.result }}"},"depends_on":["mem"]},
    {"id":"reply","label":"Response","type":"logic.response","args":{"value":"{{ steps.rep.result }}"},"depends_on":["rep"]}
  ]$steps$::jsonb,
  '{"viewport":{"x":0,"y":0,"zoom":1},"theme":"dark"}'::jsonb,
  $blocks$[
    {"id":"trig","type":"trigger.schedule","position":{"x":50,"y":150},"data":{"label":"Schedule 09:00","cron_expr":"0 9 * * *","args":{}}},
    {"id":"mem","type":"argus.memory","position":{"x":280,"y":150},"data":{"label":"Last 24h Memory","operation":"retrieve","args":{"agent_id":1,"query":"recent_incidents","top_k":10}}},
    {"id":"rep","type":"argus.agent","position":{"x":520,"y":150},"data":{"label":"Generate Report","agent_id":1,"args":{"prompt":"Erstelle einen Tagesreport aus:\n\n{{ steps.mem.result }}"}}},
    {"id":"reply","type":"logic.response","position":{"x":770,"y":150},"data":{"label":"Response","args":{"value":"{{ steps.rep.result }}"}}}
  ]$blocks$::jsonb,
  'template', false
)
ON CONFLICT (name) DO NOTHING;

-- ── Webhook → RAG → Agent ───────────────────────────────────────
INSERT INTO mcp_workflows (name, description, steps, canvas_state, block_definitions, source, enabled)
VALUES (
  'tpl_webhook_rag_qa',
  '[Template] Webhook (question) → RAG knowledge → Agent answer → Response',
  $steps$[
    {"id":"trig","label":"Webhook /ask","type":"trigger.webhook","args":{"webhook_path":"/ask"}},
    {"id":"rag","label":"Knowledge Lookup","type":"argus.knowledge","args":{"index_name":"docs","query":"{{ input.question }}","top_k":5},"depends_on":["trig"]},
    {"id":"answer","label":"Compose Answer","type":"argus.agent","agent_id":1,"args":{"prompt":"Frage:{{ input.question }}\n\nKontext:\n{{ steps.rag.result }}\n\nAntworte präzise."},"depends_on":["rag"]},
    {"id":"reply","label":"Response","type":"logic.response","args":{"value":"{{ steps.answer.result }}"},"depends_on":["answer"]}
  ]$steps$::jsonb,
  '{"viewport":{"x":0,"y":0,"zoom":1},"theme":"dark"}'::jsonb,
  $blocks$[
    {"id":"trig","type":"trigger.webhook","position":{"x":50,"y":150},"data":{"label":"Webhook /ask","webhook_path":"/ask","args":{}}},
    {"id":"rag","type":"argus.knowledge","position":{"x":280,"y":150},"data":{"label":"Knowledge Lookup","index_name":"docs","args":{"query":"{{ input.question }}","top_k":5}}},
    {"id":"answer","type":"argus.agent","position":{"x":520,"y":150},"data":{"label":"Compose Answer","agent_id":1,"args":{"prompt":"Frage:{{ input.question }}\n\nKontext:\n{{ steps.rag.result }}\n\nAntworte präzise."}}},
    {"id":"reply","type":"logic.response","position":{"x":770,"y":150},"data":{"label":"Response","args":{"value":"{{ steps.answer.result }}"}}}
  ]$blocks$::jsonb,
  'template', false
)
ON CONFLICT (name) DO NOTHING;

-- ── Parallel-Fanout with merge ──────────────────────────────────
INSERT INTO mcp_workflows (name, description, steps, canvas_state, block_definitions, source, enabled)
VALUES (
  'tpl_parallel_fanout',
  '[Template] Beispiel: Parallele Branches mit Condition + Function-Merge',
  $steps$[
    {"id":"trig","label":"Manual","type":"trigger.manual","args":{}},
    {"id":"branchA","label":"Branch A: Get Pods","type":"argus.tool","tool":"k8s_get_pods","args":{"namespace":"default"},"depends_on":["trig"]},
    {"id":"branchB","label":"Branch B: Get Services","type":"argus.tool","tool":"k8s_get_services","args":{"namespace":"default"},"depends_on":["trig"]},
    {"id":"merge","label":"Merge","type":"logic.function","function_code":"return { pods: steps.branchA.result, services: steps.branchB.result };","args":{},"depends_on":["branchA","branchB"]},
    {"id":"reply","label":"Response","type":"logic.response","args":{"value":"{{ steps.merge.result }}"},"depends_on":["merge"]}
  ]$steps$::jsonb,
  '{"viewport":{"x":0,"y":0,"zoom":1},"theme":"dark"}'::jsonb,
  $blocks$[
    {"id":"trig","type":"trigger.manual","position":{"x":50,"y":200},"data":{"label":"Manual","args":{}}},
    {"id":"branchA","type":"argus.tool","position":{"x":280,"y":100},"data":{"label":"Branch A: Get Pods","tool":"k8s_get_pods","args":{"namespace":"default"}}},
    {"id":"branchB","type":"argus.tool","position":{"x":280,"y":300},"data":{"label":"Branch B: Get Services","tool":"k8s_get_services","args":{"namespace":"default"}}},
    {"id":"merge","type":"logic.function","position":{"x":540,"y":200},"data":{"label":"Merge","function_code":"return { pods: steps.branchA.result, services: steps.branchB.result };","args":{}}},
    {"id":"reply","type":"logic.response","position":{"x":790,"y":200},"data":{"label":"Response","args":{"value":"{{ steps.merge.result }}"}}}
  ]$blocks$::jsonb,
  'template', false
)
ON CONFLICT (name) DO NOTHING;
