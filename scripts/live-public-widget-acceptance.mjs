import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const baseUrl = String(process.env.ARGUS_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const adminOrigin = new URL(baseUrl).origin;
const embedOrigin = String(process.env.ARGUS_WIDGET_TEST_ORIGIN ?? 'http://127.0.0.1:4173').replace(/\/+$/, '');
const connectionString = process.env.POSTGRES_CONNECTION_URL;
if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL is required');

const pool = new pg.Pool({ connectionString });
const adminSessionId = randomUUID();
let widgetId = null;
let widgetSlug = null;
let selectedAgent = null;
let finalWidgetDisabled = false;

async function readResponse(response) {
  const text = await response.text();
  let payload = text;
  try { payload = text ? JSON.parse(text) : null; } catch { /* text response */ }
  return { response, text, payload };
}

async function adminApi(path, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
  const result = await readResponse(await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: `argus_session=${adminSessionId}`,
      Origin: adminOrigin,
      Referer: `${adminOrigin}/build/public-widgets`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  }));
  if (!result.response.ok) {
    const detail = typeof result.payload === 'string'
      ? result.payload.slice(0, 500)
      : JSON.stringify(result.payload);
    throw new Error(`${method} ${path} returned ${result.response.status}: ${detail}`);
  }
  return result.payload;
}

function requireStatus(result, expected, label) {
  if (result.response.status !== expected) {
    const detail = typeof result.payload === 'string'
      ? result.payload.slice(0, 500)
      : JSON.stringify(result.payload);
    throw new Error(`${label} returned ${result.response.status}; expected ${expected}: ${detail}`);
  }
}

function parseSse(text) {
  const chunks = [];
  const errors = [];
  let done = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    try {
      const event = JSON.parse(data);
      if (typeof event.delta === 'string') chunks.push(event.delta);
      if (typeof event.content === 'string') chunks.push(event.content);
      if (typeof event.error === 'string') errors.push(event.error);
    } catch {
      if (data) chunks.push(data);
    }
  }
  return { text: chunks.join(''), errors, done };
}

async function disableWidget() {
  if (widgetId == null || finalWidgetDisabled) return;
  try {
    await adminApi(`/api/ui/public-widgets/${widgetId}`, {
      method: 'PUT',
      body: { enabled: false },
    });
  } catch {
    await pool.query(
      'UPDATE mcp_public_widgets SET enabled = false, updated_at = now() WHERE id = $1',
      [widgetId],
    );
  }
  finalWidgetDisabled = true;
}

try {
  const { rows: users } = await pool.query(
    `SELECT id, username
       FROM mcp_users
      WHERE enabled = true
        AND role IN ('platform_admin', 'admin')
      ORDER BY CASE role WHEN 'platform_admin' THEN 0 ELSE 1 END, id
      LIMIT 1`,
  );
  const user = users[0];
  if (!user) throw new Error('No enabled Argus platform admin is available for the acceptance session');
  await pool.query(
    `INSERT INTO mcp_sessions (id, user_id, expires_at, ip_address, user_agent)
     VALUES ($1, $2, now() + interval '30 minutes', $3, $4)`,
    [adminSessionId, user.id, '127.0.0.1', 'argus-live-public-widget-acceptance'],
  );

  const catalog = await adminApi('/api/ui/public-widgets');
  if (!catalog?.masterEnabled) {
    throw new Error(
      'Public widget master switch is disabled. Recreate mcp-server once with PUBLIC_WIDGET_ENABLED=true, run this check, then recreate it with the default false value.',
    );
  }

  const requestedAgentId = Number(process.env.ARGUS_WIDGET_TEST_AGENT_ID ?? 0);
  const { rows: candidates } = await pool.query(
    `SELECT a.id, a.name, a.label, a.visibility
       FROM mcp_agents a
       JOIN mcp_agent_runtime_profiles r ON r.id = a.runtime_profile_id
      WHERE a.enabled = true
        AND a.agent_mode = 'chat'
        AND r.enabled = true
        AND ($1::integer = 0 OR a.id = $1)
      ORDER BY CASE a.name
        WHEN 'researcher' THEN 0
        WHEN 'workflow_copilot' THEN 1
        WHEN 'planner' THEN 2
        ELSE 3
      END, a.id
      LIMIT 1`,
    [Number.isSafeInteger(requestedAgentId) && requestedAgentId > 0 ? requestedAgentId : 0],
  );
  selectedAgent = candidates[0] ?? null;
  if (!selectedAgent) throw new Error('No enabled chat agent with an enabled runtime profile is available');

  if (selectedAgent.visibility !== 'public') {
    await pool.query(
      `UPDATE mcp_agents SET visibility = 'public', updated_at = now() WHERE id = $1`,
      [selectedAgent.id],
    );
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14).toLowerCase();
  widgetSlug = `acceptance-${stamp}`;
  const widget = await adminApi('/api/ui/public-widgets', {
    method: 'POST',
    body: {
      agentId: Number(selectedAgent.id),
      slug: widgetSlug,
      allowedOrigins: [embedOrigin],
      enabled: true,
      greeting: 'Hallo! Dies ist ein kurzlebiger Argus Public-Widget-Test.',
      accent: '#8b5cf6',
      rateLimitPerIp: 20,
      dailyTokenCap: 10_000,
    },
  });
  widgetId = Number(widget.id);
  if (!Number.isSafeInteger(widgetId) || widgetId <= 0) {
    throw new Error('Widget creation returned no valid id');
  }

  const page = await readResponse(await fetch(`${baseUrl}/public/widget/${widgetSlug}`, {
    signal: AbortSignal.timeout(15_000),
  }));
  requireStatus(page, 200, 'Public widget page');
  if (!page.text.includes('id="chatMessages"') || !page.text.includes(`/public/widget/${widgetSlug}/session`)) {
    throw new Error('Public widget page did not contain the expected embedded chat runtime');
  }
  const csp = page.response.headers.get('content-security-policy') ?? '';
  if (!csp.includes(embedOrigin)) {
    throw new Error(`Public widget CSP does not allow the configured embed origin ${embedOrigin}`);
  }

  const loader = await readResponse(await fetch(`${baseUrl}/assets/argus-widget.js`, {
    signal: AbortSignal.timeout(15_000),
  }));
  requireStatus(loader, 200, 'Embeddable widget loader');
  if (!loader.text.includes('/public/widget/')) {
    throw new Error('Widget loader does not reference the public widget route');
  }

  const deniedSession = await readResponse(await fetch(`${baseUrl}/public/widget/${widgetSlug}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://not-allowed.example' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  }));
  requireStatus(deniedSession, 403, 'Denied-origin session probe');

  const session = await readResponse(await fetch(`${baseUrl}/public/widget/${widgetSlug}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: embedOrigin },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  }));
  requireStatus(session, 200, 'Allowed-origin session creation');
  const publicToken = String(session.payload?.token ?? '');
  const publicSessionId = String(session.payload?.sessionId ?? '');
  if (!publicToken || !publicSessionId) throw new Error('Public session returned no token or session id');

  const message = 'Antworte kurz und nenne ausdrücklich: Argus Public Widget funktioniert.';
  const chat = await readResponse(await fetch(`${baseUrl}/public/widget/${widgetSlug}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: embedOrigin,
      Authorization: `Bearer ${publicToken}`,
    },
    body: JSON.stringify({ sessionId: publicSessionId, message }),
    signal: AbortSignal.timeout(330_000),
  }));
  requireStatus(chat, 200, 'Public agent chat');
  if (!/text\/event-stream/i.test(chat.response.headers.get('content-type') ?? '')) {
    throw new Error('Public chat did not return an SSE response');
  }
  if (!chat.response.headers.get('x-widget-token')) {
    throw new Error('Public chat did not rotate the single-use widget token');
  }
  const parsedChat = parseSse(chat.text);
  if (parsedChat.errors.length) throw new Error(`Public agent returned an error: ${parsedChat.errors.join('; ')}`);
  if (!parsedChat.done || !parsedChat.text.trim()) {
    throw new Error('Public agent stream did not contain a completed text response');
  }

  const replay = await readResponse(await fetch(`${baseUrl}/public/widget/${widgetSlug}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: embedOrigin,
      Authorization: `Bearer ${publicToken}`,
    },
    body: JSON.stringify({ sessionId: publicSessionId, message: 'This token must not work twice.' }),
    signal: AbortSignal.timeout(15_000),
  }));
  requireStatus(replay, 401, 'Single-use token replay probe');

  await disableWidget();
  const disabledPage = await readResponse(await fetch(`${baseUrl}/public/widget/${widgetSlug}`, {
    signal: AbortSignal.timeout(15_000),
  }));
  requireStatus(disabledPage, 404, 'Disabled widget page');

  const disabledSession = await readResponse(await fetch(`${baseUrl}/public/widget/${widgetSlug}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: embedOrigin },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  }));
  requireStatus(disabledSession, 404, 'Disabled widget session');

  console.log(JSON.stringify({
    verdict: 'public-widget-accepted-and-disabled',
    widgetId,
    widgetSlug,
    widgetAdminUrl: `${baseUrl}/build/public-widgets`,
    publicPath: `/public/widget/${widgetSlug}`,
    embedOrigin,
    agent: { id: Number(selectedAgent.id), name: selectedAgent.name, label: selectedAgent.label },
    checks: {
      embedPage: 'passed',
      frameAncestorsCsp: 'passed',
      loaderScript: 'passed',
      deniedOrigin: 'passed',
      anonymousSession: 'passed',
      realAgentSseReply: 'passed',
      singleUseToken: 'passed',
      disabledAfterTest: 'passed',
    },
    responsePreview: parsedChat.text.trim().slice(0, 300),
    finalState: 'disabled',
  }, null, 2));
} finally {
  await disableWidget().catch(() => {});
  if (selectedAgent && selectedAgent.visibility !== 'public') {
    await pool.query(
      'UPDATE mcp_agents SET visibility = $2, updated_at = now() WHERE id = $1',
      [selectedAgent.id, selectedAgent.visibility],
    ).catch(() => {});
  }
  await pool.query('DELETE FROM mcp_sessions WHERE id = $1', [adminSessionId]).catch(() => {});
  await pool.end();
}
