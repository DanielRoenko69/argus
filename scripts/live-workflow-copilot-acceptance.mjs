import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const baseUrl = String(process.env.ARGUS_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const origin = new URL(baseUrl).origin;
const connectionString = process.env.POSTGRES_CONNECTION_URL;
if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL is required');

const defaultPrompt = [
  'Create a manual-trigger workflow for a safe GitHub issue triage demo.',
  'Use the available GitHub read tool to read issue number 1 from owner argus-project and repository argus.',
  'Ask an accessible planner agent for a concise summary, severity and recommended next action.',
  'Use the available Slack write tool to post that result to channel coding-ops, then return a final response.',
  'Do not modify the repository and do not add an explicit approval node; Argus write mode governs the Slack write.',
  'Put every required tool parameter in data.args and connect every generated node into one executable path.',
].join(' ');
const promptIndex = process.argv.indexOf('--prompt');
const prompt = promptIndex >= 0 ? String(process.argv[promptIndex + 1] ?? '').trim() : defaultPrompt;
if (!prompt) throw new Error('--prompt requires a non-empty value');

const pool = new pg.Pool({ connectionString });
const sessionId = randomUUID();
let workflowId = null;

async function api(path, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: `argus_session=${sessionId}`,
      Origin: origin,
      Referer: `${origin}/build/workflows`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload.slice(0, 500) : JSON.stringify(payload);
    throw new Error(`${method} ${path} returned ${response.status}: ${detail}`);
  }
  return payload;
}

function buildSteps(nodes, edges) {
  const dependencies = new Map();
  for (const edge of edges) {
    const current = dependencies.get(edge.target) ?? [];
    current.push(edge.source);
    dependencies.set(edge.target, current);
  }
  const metadata = new Set([
    'label', 'tool', 'tool_binding', 'integration_id', 'agent_id', 'agent_role',
    'output_contract', 'output_contract_retries', 'skill_id', 'function_code',
    'condition', 'on_error', 'cred_ref', 'args', 'cron_expr', 'schedule_static_inputs',
    'webhook_path', 'webhook_secret_env', 'webhook_provider', 'webhook_allowed_events',
    'webhook_static_inputs', 'webhook_test_payload', 'text',
  ]);
  return nodes.map(node => {
    const data = node.data ?? {};
    const nestedArgs = data.args && typeof data.args === 'object' && !Array.isArray(data.args) ? data.args : {};
    const flatArgs = Object.fromEntries(Object.entries(data).filter(([key, value]) => !metadata.has(key) && value !== undefined));
    const step = {
      id: node.id,
      label: typeof data.label === 'string' ? data.label : node.type,
      type: node.type,
      args: { ...flatArgs, ...nestedArgs },
    };
    for (const key of ['tool', 'integration_id', 'tool_binding', 'agent_id', 'agent_role', 'output_contract', 'output_contract_retries', 'skill_id', 'function_code', 'condition', 'on_error', 'cred_ref']) {
      if (data[key] !== undefined) step[key] = data[key];
    }
    const dependsOn = dependencies.get(node.id);
    if (dependsOn?.length) step.depends_on = dependsOn;
    return step;
  });
}

function triggerConfig(nodes) {
  const trigger = nodes.find(node => String(node.type).startsWith('trigger.'));
  if (!trigger || trigger.type === 'trigger.manual') return { type: 'manual' };
  if (trigger.type === 'trigger.schedule') {
    return { type: 'cron', cron_expr: String(trigger.data?.cron_expr ?? '0 * * * *') };
  }
  if (trigger.type === 'trigger.webhook') {
    const raw = String(trigger.data?.webhook_path ?? '').trim();
    return { type: 'webhook', webhook_path: raw ? `/${raw.replace(/^\/+/, '')}` : '' };
  }
  return { type: 'manual' };
}

try {
  const { rows: users } = await pool.query(
    `SELECT id, username FROM mcp_users
     WHERE enabled = true AND role IN ('platform_admin', 'admin', 'operations_admin')
     ORDER BY CASE role WHEN 'platform_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id
     LIMIT 1`,
  );
  const user = users[0];
  if (!user) throw new Error('No enabled Argus admin user is available for the live acceptance session');
  await pool.query(
    `INSERT INTO mcp_sessions (id, user_id, expires_at, ip_address, user_agent)
     VALUES ($1, $2, now() + interval '30 minutes', $3, $4)`,
    [sessionId, user.id, '127.0.0.1', 'argus-live-workflow-copilot-acceptance'],
  );

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const created = await api('/api/admin/workflows', {
    method: 'POST',
    body: {
      name: `copilot_live_github_slack_${stamp}`,
      description: 'Live acceptance draft generated by the governed Argus Workflow Copilot.',
      enabled: true,
    },
  });
  workflowId = Number(created.id);
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0) throw new Error('Workflow creation returned no valid id');

  const suggestion = await api('/api/workflows/copilot', {
    method: 'POST',
    body: { workflow_id: workflowId, prompt, current_nodes: [], current_edges: [] },
    timeoutMs: 330_000,
  });
  const warnings = Array.isArray(suggestion.warnings) ? suggestion.warnings.map(String) : [];
  const nodes = Array.isArray(suggestion.add_nodes) ? suggestion.add_nodes : [];
  const edges = Array.isArray(suggestion.add_edges) ? suggestion.add_edges : [];
  if (warnings.length || nodes.length === 0) {
    console.log(JSON.stringify({
      verdict: 'needs-attention',
      workflowId,
      studioUrl: `${baseUrl}/build/workflows/studio/${workflowId}`,
      rationale: suggestion.rationale,
      warnings: warnings.length ? warnings : ['Copilot returned no nodes'],
    }, null, 2));
    process.exitCode = 2;
  } else {
    const steps = buildSteps(nodes, edges);
    const validation = await api(`/api/workflows/${workflowId}/validate`, {
      method: 'POST',
      body: { steps },
    });
    if (!validation.valid) {
      console.log(JSON.stringify({
        verdict: 'validation-failed', workflowId,
        studioUrl: `${baseUrl}/build/workflows/studio/${workflowId}`,
        errors: validation.errors,
      }, null, 2));
      process.exitCode = 2;
    } else {
      await api(`/api/workflows/${workflowId}/flow`, {
        method: 'PUT',
        body: {
          steps,
          input_params: Array.isArray(suggestion.input_params) ? suggestion.input_params : [],
          canvas_state: { viewport: { x: 0, y: 0, zoom: 1 }, theme: 'dark' },
          block_definitions: nodes,
          trigger_config: triggerConfig(nodes),
        },
      });
      const saved = await api(`/api/workflows/${workflowId}/flow`);
      const tools = steps.filter(step => step.type === 'argus.tool').map(step => ({
        stepId: step.id,
        tool: step.tool,
        integration: step.integration_id ?? step.tool_binding?.integration_id ?? null,
        access: step.tool_binding?.access ?? null,
      }));
      console.log(JSON.stringify({
        verdict: 'prototype-ready',
        workflowId,
        workflowName: saved.name,
        studioUrl: `${baseUrl}/build/workflows/studio/${workflowId}`,
        rationale: suggestion.rationale,
        nodes: saved.block_definitions.length,
        edges: edges.length,
        steps: saved.steps.length,
        inputParams: saved.input_params,
        tools,
        agentSteps: steps.filter(step => step.type === 'argus.agent').map(step => ({
          stepId: step.id,
          agentId: step.agent_id ?? null,
          agentRole: step.agent_role ?? null,
        })),
        validationWarnings: validation.warnings,
        source: saved.source,
      }, null, 2));
    }
  }
} finally {
  await pool.query('DELETE FROM mcp_sessions WHERE id = $1', [sessionId]).catch(() => {});
  await pool.end();
}
