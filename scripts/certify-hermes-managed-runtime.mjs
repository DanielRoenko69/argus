import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const terminal = new Set(['completed', 'failed', 'cancelled']);

function databaseUrl() {
  const user = process.env.POSTGRES_USER?.trim() || 'aiops';
  const password = process.env.POSTGRES_PASSWORD?.trim();
  const database = process.env.POSTGRES_DB?.trim() || 'aiops';
  const port = process.env.POSTGRES_PORT?.trim() || '5432';
  if (!password) throw new Error('POSTGRES_PASSWORD is required');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON status ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${body.code ?? body.error ?? 'unknown'}`);
  }
  return body;
}

async function waitForManagedReady(baseUrl, cookie, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/status`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { cookie } });
      if (response.ok) {
        const body = await response.json();
        if (body?.status?.state === 'ready'
          && body.status.modes?.some(mode => mode.mode === 'managed' && mode.state === 'ready')) return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error('Managed Hermes adapter did not become ready before live certification');
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
  const baseUrl = process.env.ARGUS_BASE_URL?.trim() || 'http://127.0.0.1:3000';
  const bundleId = Number(process.env.ARGUS_HERMES_MANAGED_BUNDLE_ID ?? '161');
  const coreAgentName = process.env.ARGUS_HERMES_MANAGED_CORE_AGENT?.trim() || 'researcher';
  const requestId = randomUUID();
  const sessionId = randomUUID();
  let runId;
  try {
    const admin = await pool.query(
      `SELECT id FROM mcp_users
       WHERE enabled=true AND role='platform_admin'
       ORDER BY id LIMIT 1`,
    );
    if (!admin.rows[0]) throw new Error('No enabled platform administrator exists for local certification');
    await pool.query(
      `INSERT INTO mcp_sessions (id,user_id,expires_at,ip_address,user_agent)
       VALUES ($1,$2,now()+interval '15 minutes','127.0.0.1','managed-hermes-certifier')`,
      [sessionId, admin.rows[0].id],
    );
    const headers = {
      cookie: `argus_session=${sessionId}`,
      origin: baseUrl,
      'content-type': 'application/json',
    };
    await waitForManagedReady(baseUrl, headers.cookie);
    const root = `${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/runs`;
    const launched = await responseJson(await fetch(root, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId,
        coreAgentName,
        bundleIds: [bundleId],
        input: {
          text: 'Call the governed MCP tool argus_code_index_status exactly once, then summarize the returned index names. Do not answer from memory and do not perform writes.',
        },
        instructions: 'This is a read-only Managed Hermes certification. You MUST invoke argus_code_index_status through the argus_core MCP server before answering. Use no native tools.',
        limits: { deadlineSeconds: 300, maxToolCalls: 8, maxOutputBytes: 65_536 },
      }),
    }), 'managed launch');
    runId = launched.run?.id;
    if (!runId || launched.lease?.status !== 'active') throw new Error('Managed launch did not activate a runtime MCP lease');
    process.stdout.write(`${JSON.stringify({
      event: 'launched',
      runId,
      rootTraceId: launched.run.rootTraceId,
      leaseState: launched.lease.status,
    })}\n`);

    const initialStatusDelayMs = Math.min(
      60_000,
      Math.max(0, Number.parseInt(process.env.HERMES_CERT_INITIAL_STATUS_DELAY_MS ?? '0', 10) || 0),
    );
    if (initialStatusDelayMs) await new Promise(resolve => setTimeout(resolve, initialStatusDelayMs));

    const deadline = Date.now() + 5 * 60_000;
    let latest;
    while (Date.now() < deadline) {
      latest = await responseJson(await fetch(`${root}/${runId}`, {
        headers: { cookie: headers.cookie },
      }), 'managed status');
      process.stdout.write(`${JSON.stringify({
        event: 'status', state: latest.run.state, leaseState: latest.lease.status,
      })}\n`);
      if (terminal.has(latest.run.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    if (!latest || latest.run.state !== 'completed' || latest.lease.status !== 'completed') {
      throw new Error(`Managed Hermes did not complete cleanly: ${latest?.run?.state ?? 'timeout'}`);
    }
    const outputBytes = Buffer.byteLength(latest.run.output?.trim() ?? '', 'utf8');
    if (outputBytes < 1 || outputBytes > 32 * 1024) {
      throw new Error('Managed Hermes completed without a bounded agent output');
    }
    const events = await responseJson(await fetch(`${root}/${runId}/events`, {
      headers: { cookie: headers.cookie },
    }), 'managed events');
    const eventTypes = events.events?.map(event => event.type) ?? [];
    if (!eventTypes.includes('run.started') || !eventTypes.includes('run.completed')) {
      throw new Error('Managed lifecycle evidence is incomplete');
    }
    const completedEvent = events.events.find(event => event.type === 'run.completed');
    const advertisedTools = Number(completedEvent?.evidence?.mcp_tools_advertised ?? 0);
    const mcpToolCalls = Number(completedEvent?.evidence?.mcp_calls ?? 0);
    process.stdout.write(`${JSON.stringify({
      event: 'mcp-evidence',
      advertisedTools,
      toolCallAttempts: Number(completedEvent?.evidence?.mcp_call_attempts ?? 0),
      toolCalls: mcpToolCalls,
      toolCallFailures: Number(completedEvent?.evidence?.mcp_call_failures ?? 0),
      outputBytes,
    })}\n`);
    if (!Number.isInteger(advertisedTools) || advertisedTools < 1) {
      throw new Error('Managed Hermes completed without an advertised Argus MCP tool');
    }
    if (!Number.isInteger(mcpToolCalls) || mcpToolCalls < 1) {
      throw new Error('Managed Hermes completed without a verified Argus MCP tool call');
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      runId,
      rootTraceId: latest.run.rootTraceId,
      eventTypes,
      advertisedTools,
      mcpToolCalls,
      logsUrl: `${baseUrl}/observe/logs?root_trace=${latest.run.rootTraceId}`,
    })}\n`);
  } finally {
    if (runId) {
      // A terminal run is idempotently returned; an unfinished run is stopped
      // and its one-time runtime MCP lease is revoked by Core.
      await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/runs/${runId}/cancel`, {
        method: 'POST',
        headers: {
          cookie: `argus_session=${sessionId}`,
          origin: baseUrl,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId: randomUUID(), reason: 'local managed Hermes certification cleanup' }),
      }).catch(() => undefined);
    }
    await pool.query('DELETE FROM mcp_sessions WHERE id=$1', [sessionId]).catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

await main();
