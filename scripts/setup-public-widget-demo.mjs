import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const baseUrl = String(process.env.ARGUS_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const requestedOrigin = process.argv.find(argument => argument.startsWith('--origin='))?.slice('--origin='.length);
const widgetOrigin = String(requestedOrigin ?? process.env.ARGUS_WIDGET_DEMO_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/, '');
const websiteOrigins = String(process.env.ARGUS_WIDGET_DEMO_SITE_ORIGINS ?? 'http://localhost:4173,http://127.0.0.1:4173')
  .split(',')
  .map(origin => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);
const probeChat = process.argv.includes('--probe-chat');
const connectionString = process.env.POSTGRES_CONNECTION_URL;

if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL is required');

const pool = new pg.Pool({ connectionString });
const sessionId = randomUUID();

async function readJson(response) {
  const text = await response.text();
  let payload = text;
  try { payload = text ? JSON.parse(text) : null; } catch { /* text response */ }
  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload.slice(0, 500) : JSON.stringify(payload);
    throw new Error(`Argus returned ${response.status}: ${detail}`);
  }
  return payload;
}

function parseSse(text) {
  const content = [];
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
      if (typeof event.delta === 'string') content.push(event.delta);
      if (typeof event.content === 'string') content.push(event.content);
      if (typeof event.error === 'string') errors.push(event.error);
    } catch {
      if (data) content.push(data);
    }
  }
  return { content: content.join(''), errors, done };
}

try {
  const { rows } = await pool.query(
    `SELECT id, username
       FROM mcp_users
      WHERE enabled=true
        AND role IN ('platform_admin', 'admin')
      ORDER BY CASE role WHEN 'platform_admin' THEN 0 ELSE 1 END, id
      LIMIT 1`,
  );
  const admin = rows[0];
  if (!admin) throw new Error('No enabled Argus platform admin is available');

  await pool.query(
    `INSERT INTO mcp_sessions (id, user_id, expires_at, ip_address, user_agent)
     VALUES ($1, $2, now() + interval '10 minutes', $3, $4)`,
    [sessionId, admin.id, '127.0.0.1', 'argus-public-widget-demo-setup'],
  );

  const catalog = await readJson(await fetch(`${baseUrl}/api/ui/public-widgets`, {
    headers: { Cookie: `argus_session=${sessionId}` },
    signal: AbortSignal.timeout(15_000),
  }));
  if (!catalog?.masterEnabled) {
    throw new Error('Public runtime is disabled. Run: .\\scripts\\public-widget-runtime.ps1 enable');
  }

  const result = await readJson(await fetch(`${baseUrl}/api/ui/public-widgets/demo`, {
    method: 'POST',
    headers: {
      Cookie: `argus_session=${sessionId}`,
      Origin: new URL(baseUrl).origin,
      Referer: `${new URL(baseUrl).origin}/build/public-widgets`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ origin: widgetOrigin, websiteOrigins }),
    signal: AbortSignal.timeout(30_000),
  }));

  if (!result?.demo?.reachable || !result?.demo?.publicPath) {
    throw new Error(`Demo resources were created but are not reachable: ${JSON.stringify(result?.demo ?? null)}`);
  }
  console.log(`[public-widget] Demo ready for ${[widgetOrigin, ...websiteOrigins].join(', ')}`);
  console.log(`[public-widget] ${baseUrl}${result.demo.publicPath}`);

  if (probeChat) {
    const publicUrl = `${baseUrl}${result.demo.publicPath}`;
    const page = await fetch(publicUrl, { signal: AbortSignal.timeout(15_000) });
    const frameAncestors = page.headers.get('content-security-policy') ?? '';
    if (!page.ok || !(await page.text()).includes('id="chatMessages"')) {
      throw new Error(`Public demo page probe failed with ${page.status}`);
    }
    for (const websiteOrigin of websiteOrigins) {
      if (!frameAncestors.includes(websiteOrigin)) {
        throw new Error(`Public demo CSP does not allow the external website origin ${websiteOrigin}`);
      }
    }
    const publicSession = await readJson(await fetch(`${publicUrl}/session`, {
      method: 'POST',
      headers: { Origin: widgetOrigin, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    }));
    const chat = await fetch(`${publicUrl}/chat`, {
      method: 'POST',
      headers: {
        Origin: widgetOrigin,
        Authorization: `Bearer ${publicSession.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: publicSession.sessionId,
        message: 'Was ist Argus Dev? Antworte in höchstens zwei kurzen Sätzen.',
      }),
      signal: AbortSignal.timeout(330_000),
    });
    if (!chat.ok) throw new Error(`Public demo chat probe failed with ${chat.status}: ${(await chat.text()).slice(0, 500)}`);
    const parsed = parseSse(await chat.text());
    if (!parsed.done || parsed.errors.length > 0 || parsed.content.trim().length < 10) {
      throw new Error(`Public demo chat returned invalid SSE evidence: ${JSON.stringify(parsed)}`);
    }
    console.log(`[public-widget] Real public-agent probe passed (${parsed.content.trim().length} response characters).`);
  }
} finally {
  await pool.query('DELETE FROM mcp_sessions WHERE id=$1', [sessionId]).catch(() => {});
  await pool.end();
}
