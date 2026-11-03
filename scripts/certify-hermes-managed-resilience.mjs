import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  try { body = JSON.parse(text); } catch { throw new Error(`${label} returned non-JSON status ${response.status}`); }
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${body.code ?? body.error ?? 'unknown'}`);
  return body;
}

function docker(args, { optional = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || result.error) {
    if (optional) return '';
    throw new Error(`Docker resilience action failed during ${args.slice(0, 2).join(' ')}`);
  }
  return String(result.stdout ?? '').trim();
}

function containerName(runId) {
  return `argus-hermes-run-${runId.replaceAll('-', '')}`;
}

async function waitFor(fetchStatus, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await fetchStatus();
    if (expected.has(latest.run.state)) return latest;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error(`Managed Hermes did not reach ${[...expected].join('/')} (last=${latest?.run?.state ?? 'none'})`);
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
  throw new Error('Managed Hermes adapter did not become ready before resilience certification');
}

async function waitForRunCleanup(runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const containers = docker(['ps', '--all', '--quiet', '--filter', `label=argus.hermes.run=${runId}`], { optional: true });
    const networks = docker(['network', 'ls', '--quiet', '--filter', `label=argus.hermes.run=${runId}`], { optional: true });
    if (!containers && !networks) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Managed Hermes did not clean isolated resources for run ${runId}`);
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
  const baseUrl = process.env.ARGUS_BASE_URL?.trim() || 'http://127.0.0.1:3000';
  const bundleId = Number(process.env.ARGUS_HERMES_MANAGED_BUNDLE_ID ?? '161');
  const coreAgentName = process.env.ARGUS_HERMES_MANAGED_CORE_AGENT?.trim() || 'researcher';
  const sessionId = randomUUID();
  const runIds = [];
  let headers;
  try {
    const admin = await pool.query(`SELECT id FROM mcp_users WHERE enabled=true AND role='platform_admin' ORDER BY id LIMIT 1`);
    if (!admin.rows[0]) throw new Error('No enabled platform administrator exists for local certification');
    await pool.query(
      `INSERT INTO mcp_sessions (id,user_id,expires_at,ip_address,user_agent)
       VALUES ($1,$2,now()+interval '20 minutes','127.0.0.1','managed-hermes-resilience-certifier')`,
      [sessionId, admin.rows[0].id],
    );
    headers = { cookie: `argus_session=${sessionId}`, origin: baseUrl, 'content-type': 'application/json' };
    await waitForManagedReady(baseUrl, headers.cookie);
    const root = `${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/runs`;
    const launch = async (kind, deadlineSeconds = 120) => {
      const launched = await responseJson(await fetch(root, {
        method: 'POST', headers,
        body: JSON.stringify({
          requestId: randomUUID(), coreAgentName, bundleIds: [bundleId],
          input: { text: `Run the governed read-only resilience scenario '${kind}'. Call argus_code_index_status, then wait for normal lifecycle completion. Never perform writes.` },
          instructions: 'Use only the Argus MCP tools. This run may be stopped by the Core resilience controller.',
          limits: { deadlineSeconds, maxToolCalls: 8, maxOutputBytes: 65_536 },
        }),
      }), `${kind} launch`);
      if (launched.lease?.status !== 'active') throw new Error(`${kind} launch did not activate the MCP lease`);
      runIds.push(launched.run.id);
      return launched;
    };
    const status = async runId => responseJson(await fetch(`${root}/${runId}`, { headers: { cookie: headers.cookie } }), `${runId} status`);
    const events = async runId => responseJson(await fetch(`${root}/${runId}/events`, { headers: { cookie: headers.cookie } }), `${runId} events`);
    const cancel = async (runId, reason) => responseJson(await fetch(`${root}/${runId}/cancel`, {
      method: 'POST', headers,
      body: JSON.stringify({ requestId: randomUUID(), reason }),
    }), `${runId} cancel`);

    const cancellation = await launch('cancel');
    const cancelled = await cancel(cancellation.run.id, 'Managed Hermes cancellation resilience certification');
    const cancelledTerminal = terminal.has(cancelled.run.state)
      ? cancelled
      : await waitFor(() => status(cancellation.run.id), new Set(['cancelled']), 30_000);
    const cancelledEvents = await events(cancellation.run.id);
    if (cancelledTerminal.run.state !== 'cancelled' || cancelledTerminal.lease.status !== 'revoked'
      || !cancelledEvents.events.some(event => event.type === 'cancel.requested')
      || !cancelledEvents.events.some(event => event.type === 'run.cancelled')) {
      throw new Error('Cancellation did not produce a revoked lease and complete lifecycle evidence');
    }
    await waitForRunCleanup(cancellation.run.id);
    process.stdout.write(`${JSON.stringify({ event: 'cancel-certified', runId: cancellation.run.id, rootTraceId: cancellation.run.rootTraceId })}\n`);

    const crash = await launch('container-crash');
    await waitFor(() => status(crash.run.id), new Set(['running']), 30_000);
    docker(['kill', containerName(crash.run.id)]);
    const crashed = await waitFor(() => status(crash.run.id), new Set(['failed']), 30_000);
    const crashedEvents = await events(crash.run.id);
    if (crashed.lease.status !== 'failed' || !crashedEvents.events.some(event => event.type === 'run.failed')) {
      throw new Error('Container crash did not fail the lease and lifecycle deterministically');
    }
    await waitForRunCleanup(crash.run.id);
    process.stdout.write(`${JSON.stringify({ event: 'crash-certified', runId: crash.run.id, rootTraceId: crash.run.rootTraceId })}\n`);

    const timeout = await launch('deadline-timeout', 30);
    await waitFor(() => status(timeout.run.id), new Set(['running']), 30_000);
    docker(['pause', containerName(timeout.run.id)]);
    const expired = await waitFor(() => status(timeout.run.id), new Set(['failed']), 50_000);
    const expiredEvents = await events(timeout.run.id);
    if (expired.lease.status !== 'failed' || !expiredEvents.events.some(event => event.type === 'run.failed')) {
      throw new Error('Core-owned deadline did not terminate the paused run deterministically');
    }
    await waitForRunCleanup(timeout.run.id);
    process.stdout.write(`${JSON.stringify({ event: 'timeout-certified', runId: timeout.run.id, rootTraceId: timeout.run.rootTraceId })}\n`);

    const orphanContainers = docker(['ps', '--all', '--quiet', '--filter', 'label=argus.hermes.run'], { optional: true });
    const orphanNetworks = docker(['network', 'ls', '--quiet', '--filter', 'label=argus.hermes.run'], { optional: true });
    if (orphanContainers || orphanNetworks) throw new Error('Managed resilience certification left an orphaned run container or network');
    process.stdout.write(`${JSON.stringify({ ok: true, scenarios: ['cancel', 'container-crash', 'deadline-timeout'], orphanContainers: 0, orphanNetworks: 0 })}\n`);
  } finally {
    if (headers) {
      await Promise.all(runIds.map(runId => fetch(
        `${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/runs/${runId}/cancel`,
        { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), reason: 'resilience certification cleanup' }) },
      ).catch(() => undefined)));
    }
    await pool.query('DELETE FROM mcp_sessions WHERE id=$1', [sessionId]).catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

await main();
