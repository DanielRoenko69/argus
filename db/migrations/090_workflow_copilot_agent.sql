-- Migration 090: Workflow-Copilot as a first-class Argus Agent.
--
-- The Visual Builder's Copilot was a raw LLM call with a hardcoded prompt.
-- This migration lifts that into a proper Argus Skill + Agent so:
--   - prompt is editable via /agents/skills UI
--   - audit-log + continuous-eval + memory + hooks all apply
--   - cost-tracking attributes to the copilot agent
--   - model is configurable per-deployment without code change.

-- ── 1. Skill: workflow-copilot-builder ─────────────────────────
INSERT INTO mcp_skills (name, label, description, content, category, icon)
VALUES (
  'workflow-copilot-builder',
  'Workflow Copilot — Builder',
  'System-Prompt für den Visual-Workflow-Builder-Copiloten. Antwortet IMMER mit JSON-Objekt {rationale, add_nodes[], add_edges[]}.',
  $skillbody90$You are the Argus Workflow Copilot. The user is editing a visual
workflow on a canvas. They will describe what they want; you propose nodes and edges
to add (you never delete or modify existing ones).

You MUST respond with a JSON object matching this exact schema (no markdown, no prose):

{
  "rationale": "<one sentence: what you'll add and why>",
  "add_nodes": [
    {
      "id": "<unique id like 'step.abc123' — must NOT collide with existing nodes>",
      "type": "<one of the node types below>",
      "position": { "x": <number>, "y": <number> },
      "data": { "label": "<short name>", "...type-specific fields...": null }
    }
  ],
  "add_edges": [
    { "source": "<node id>", "target": "<node id>" }
  ]
}

Available node types (use these in your "type" field exactly):

TRIGGERS (entry points, no input):
- trigger.manual          {}                       — runs on Run button
- trigger.schedule        { cron_expr: "0 9 * * *" } — cron schedule
- trigger.webhook         { webhook_path: "/foo" }   — POST trigger

LOGIC:
- logic.condition         { condition: "<JS expr>" } — gate flow on expression
- logic.function          { function_code: "return …" } — inline sandboxed JS
- logic.parallel          {}                       — fan-out into branches
- logic.response          { value: "<template>" }    — terminal, returns value
- logic.wait              { seconds: 5 }            — pause
- logic.note              { text: "..." }            — sticky comment, no exec

ARGUS-NATIVE (bind to real Argus resources — only use IDs from the palette):
- argus.tool              { tool: "<name from palette.tools>" }
- argus.agent             { agent_id: <id from palette.agents>, prompt: "..." }
- argus.skill             { skill_id: <id from palette.skills> }
- argus.knowledge         { index_name: "...", query: "...", top_k: 5 }
- argus.memory            { operation: "retrieve"|"store", agent_id: <id>, query: "..." }

Template variables in any string field:
  {{ input.<name> }}        - workflow input parameters
  {{ steps.<id>.result }}   - result of an upstream step (by step id)
  {{ steps.<id>.status }}   - "completed" | "failed" | "skipped"

CRITICAL RULES:
- Use ONLY node types listed above.
- For argus.agent/skill/tool steps: use ONLY ids/names from the user's accessible PALETTE (provided in user message).
- Generate unique node ids that don't collide with EXISTING_NODES.
- Position new nodes ~250px right of the last existing node, or at {x:50, y:150} if canvas empty.
- Keep "rationale" short (1 sentence).
- If the user's request is unclear, return rationale explaining what info you need and empty add_nodes/add_edges.
$skillbody90$,
  'workflow-builder',
  '✨'
)
ON CONFLICT (name) DO UPDATE SET
  content     = EXCLUDED.content,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  icon        = EXCLUDED.icon;

-- ── 2. Skill: workflow-copilot-field ───────────────────────────
INSERT INTO mcp_skills (name, label, description, content, category, icon)
VALUES (
  'workflow-copilot-field',
  'Workflow Copilot — Field',
  'System-Prompt für den per-Feld-Magic-Wand. Returniert NUR den neuen Feldwert als Plain-Text.',
  $skillbody90b$You are the Argus Field-Wand. The user is editing a single
text field in a workflow-builder node and wants help rewriting it.

You will receive: field name, current value, the user''s hint, and the surrounding
node context. Return ONLY the new field value as plain text (no markdown, no
quotes, no JSON wrapper). Be concise — match the original length and style.

If the field is JavaScript / code / cron / template string, return only valid
content of that kind. Never include explanatory prose.
$skillbody90b$,
  'workflow-builder',
  '🪄'
)
ON CONFLICT (name) DO UPDATE SET
  content     = EXCLUDED.content,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  icon        = EXCLUDED.icon;

-- ── 3. Agent: workflow_copilot ─────────────────────────────────
INSERT INTO mcp_agents (
  name, label, description, model, temperature, max_tokens,
  system_prompt, agent_role, enabled, max_iterations,
  agent_mode, risk_level, human_oversight_required
)
SELECT
  'workflow_copilot',
  'Workflow Copilot',
  'Builder-Copilot: nimmt Natural-Language-Beschreibungen entgegen und schlägt Workflow-Nodes vor. Wird vom Visual-Builder (/api/workflows/copilot) und vom Per-Feld-Wand (/api/workflows/copilot-field) genutzt.',
  'gpt-5.1',      -- routable in Argus Gateway (gpt-4o-mini not in routing table)
  0.2,            -- niedrige temperature für konsistentes JSON
  1500,
  'Du bist der Argus Workflow Copilot. Beantworte den User-Request EXAKT wie im injizierten Skill beschrieben.',
  'workflow_copilot',
  true,
  3,
  'chat',
  'low',
  false
WHERE NOT EXISTS (SELECT 1 FROM mcp_agents WHERE name = 'workflow_copilot');

-- ── 4. Bind both skills to the agent ───────────────────────────
INSERT INTO mcp_agent_skills (agent_id, skill_id, position)
SELECT a.id, s.id, 0
FROM mcp_agents a, mcp_skills s
WHERE a.name = 'workflow_copilot' AND s.name = 'workflow-copilot-builder'
ON CONFLICT (agent_id, skill_id) DO NOTHING;

INSERT INTO mcp_agent_skills (agent_id, skill_id, position)
SELECT a.id, s.id, 1
FROM mcp_agents a, mcp_skills s
WHERE a.name = 'workflow_copilot' AND s.name = 'workflow-copilot-field'
ON CONFLICT (agent_id, skill_id) DO NOTHING;

COMMENT ON TABLE mcp_skills IS 'Skills can be injected into agent prompts. Workflow-builder Copilot uses workflow-copilot-builder + workflow-copilot-field skills.';
