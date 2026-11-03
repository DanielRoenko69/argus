import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const PACK_ID = 'argus.dev';
const AGENT_ID = 'coding-orchestrator';
const WORKFLOW_ID = 'ticket-to-pull-request';
const MANAGED_SELECTION = {
  source: 'argus.core',
  kind: 'runtime-selection',
  requestedMode: 'auto',
  effectiveMode: 'managed-hermes',
  reason: 'workflow_requires_coder_workspace_write',
  workflowId: WORKFLOW_ID,
};
const FALLBACK_SELECTION = {
  source: 'argus.core',
  kind: 'runtime-selection',
  requestedMode: 'auto',
  effectiveMode: 'default',
  reason: 'managed_hermes_unavailable_use_agent_default',
  workflowId: WORKFLOW_ID,
};
const TERMINAL_TASK_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

function databaseUrl() {
  const user = process.env.POSTGRES_USER?.trim() || 'aiops';
  const password = process.env.POSTGRES_PASSWORD?.trim();
  const database = process.env.POSTGRES_DB?.trim() || 'aiops';
  const port = process.env.POSTGRES_PORT?.trim() || '5432';
  if (!password) throw new Error('POSTGRES_PASSWORD is required');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function integerEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function recordsWithin(value, maxRecords = 4_000) {
  const records = [];
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0 && records.length < maxRecords) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    records.push(current);
    for (const item of Object.values(current)) pending.push(item);
  }
  return records;
}

function runtimeSelectionWithin(value) {
  return recordsWithin(value).find(candidate => (
    candidate.source === 'argus.core'
    && candidate.kind === 'runtime-selection'
    && typeof candidate.requestedMode === 'string'
    && typeof candidate.effectiveMode === 'string'
    && typeof candidate.reason === 'string'
    && typeof candidate.workflowId === 'string'
  )) ?? null;
}

function workflowEvidenceWithin(task) {
  return recordsWithin(task).find(candidate => (
    candidate.workflowId === WORKFLOW_ID
    && typeof candidate.currentStage === 'string'
    && Array.isArray(candidate.fileDiffs)
  )) ?? null;
}

function assertRuntimeSelection(value, label, expectedSelection = MANAGED_SELECTION) {
  const actual = runtimeSelectionWithin(value);
  if (!actual) throw new Error(`${label} does not contain Core runtime-selection evidence`);
  for (const [key, expected] of Object.entries(expectedSelection)) {
    if (actual[key] !== expected) {
      throw new Error(`${label} runtime selection ${key} was '${String(actual[key])}', expected '${expected}'`);
    }
  }
  return actual;
}

async function refreshSolutionPacks(baseUrl, headers) {
  const body = await responseJson(await fetch(`${baseUrl}/api/admin/solution-packs/refresh`, {
    method: 'POST',
    headers,
    body: '{}',
  }), 'Solution Pack discovery refresh');
  const hermes = Array.isArray(body?.packs)
    ? body.packs.find(pack => pack?.configuredId === 'argus.hermes')
    : null;
  if (!hermes) throw new Error('Solution Pack discovery no longer contains argus.hermes');
  return hermes;
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
    const detail = typeof body?.code === 'string' ? body.code
      : typeof body?.error === 'string' ? body.error
        : typeof body?.message === 'string' ? body.message.slice(0, 300)
          : 'unknown';
    throw new Error(`${label} failed (${response.status}): ${detail}`);
  }
  return body;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function resolveBundleIds(pool, bundleNames) {
  const result = await pool.query(
    `SELECT id, name
       FROM mcp_service_bundles
      WHERE name = ANY($1::text[])
      ORDER BY id`,
    [bundleNames],
  );
  const byName = new Map(result.rows.map(row => [row.name, Number(row.id)]));
  const missing = bundleNames.filter(name => !byName.has(name));
  if (missing.length > 0) throw new Error(`Required execution Bundles are unavailable: ${missing.join(', ')}`);
  return bundleNames.map(name => byName.get(name));
}

async function waitForManagedReady(baseUrl, cookie, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/status`;
  let lastState = 'unavailable';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { cookie } });
      if (response.ok) {
        const body = await response.json();
        lastState = String(body?.status?.state ?? 'unknown');
        if (body?.status?.state === 'ready'
          && body.status.modes?.some(mode => mode.mode === 'managed' && mode.state === 'ready')) return;
      }
    } catch (cause) {
      lastState = cause instanceof Error ? cause.message : 'request failed';
    }
    await sleep(1_000);
  }
  throw new Error(`Managed Hermes adapter did not become ready (last state: ${lastState})`);
}

async function waitForTask(baseUrl, cookie, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const taskUrl = `${baseUrl}/api/admin/solution-packs/${PACK_ID}/agents/${AGENT_ID}/a2a/tasks/${taskId}`;
  let previous = '';
  let latest;
  while (Date.now() < deadline) {
    const body = await responseJson(await fetch(taskUrl, { headers: { cookie } }), 'task status');
    latest = body.task;
    const state = String(latest?.status?.state ?? 'unknown');
    const evidence = workflowEvidenceWithin(latest);
    const marker = `${state}:${String(evidence?.currentStage ?? 'starting')}`;
    if (marker !== previous) {
      emit({ event: 'task-status', taskId, state, stage: evidence?.currentStage ?? 'starting' });
      previous = marker;
    }
    if (state === 'TASK_STATE_INPUT_REQUIRED') return latest;
    if (TERMINAL_TASK_STATES.has(state)) {
      throw new Error(`Workflow reached terminal state ${state} before the first human approval gate`);
    }
    await sleep(3_000);
  }
  throw new Error(`Workflow did not reach the first human approval gate within ${timeoutMs} ms`);
}

async function waitForRootTrace(pool, rootTraceId, expectedStatus, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT id, status, metadata
         FROM mcp_observability_traces
        WHERE id=$1::uuid AND root_trace_id=id`,
      [rootTraceId],
    );
    latest = result.rows[0];
    if (latest?.status === expectedStatus) return latest;
    await sleep(500);
  }
  throw new Error(`Root trace ${rootTraceId} did not reach '${expectedStatus}' (latest: ${latest?.status ?? 'missing'})`);
}

async function waitForRoutingLog(pool, rootTraceId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT data
         FROM argus_logs
        WHERE root_trace_id=$1::uuid AND msg='Solution Pack runtime selected'
        ORDER BY ts DESC
        LIMIT 1`,
      [rootTraceId],
    );
    if (result.rows[0]) return result.rows[0].data;
    await sleep(500);
  }
  throw new Error(`Structured runtime-selection log for ${rootTraceId} was not persisted`);
}

async function verifyPersistedEvidence(pool, taskId, rootTraceId, rootStatus = 'waiting') {
  const stored = await pool.query(
    `SELECT task
       FROM argus_a2a_tasks
      WHERE task_id=$1`,
    [taskId],
  );
  if (!stored.rows[0]) throw new Error(`Persisted A2A task ${taskId} was not found`);
  assertRuntimeSelection(stored.rows[0].task?.history, 'persisted A2A task history');

  const overrides = stored.rows[0].task?.metadata?.executionRuntimeOverrides;
  const managedCoder = Array.isArray(overrides) && overrides.find(override => (
    isRecord(override)
    && override.runtimeType === 'hermes'
    && override.runtimeProfileName === 'hermes-managed-dev'
  ));
  if (!managedCoder) throw new Error('Persisted A2A task does not contain the Core-signed Managed Hermes Coder override');

  // Native Core traces deliberately switch to waiting while the workflow is
  // interrupted at its human approval boundary.
  const rootTrace = await waitForRootTrace(pool, rootTraceId, rootStatus);
  assertRuntimeSelection(rootTrace.metadata?.runtime_selection, 'native root trace');

  const traces = await pool.query(
    `SELECT trace.id, trace.provider, trace.model, trace.status, trace.metadata, agent.name AS agent_name
       FROM mcp_observability_traces trace
       LEFT JOIN mcp_agents agent ON agent.id=trace.agent_id
      WHERE trace.root_trace_id=$1::uuid AND trace.kind='agent'
      ORDER BY trace.started_at, trace.id`,
    [rootTraceId],
  );
  const agents = new Set(traces.rows.map(row => row.agent_name).filter(Boolean));
  const missingAgents = ['planner', 'knowledge', 'coder', 'reviewer'].filter(name => !agents.has(name));
  if (missingAgents.length > 0) throw new Error(`Native trace is missing Agent evidence: ${missingAgents.join(', ')}`);
  const coderTrace = traces.rows.find(row => row.agent_name === 'coder'
    && row.provider === 'hermes-managed'
    && row.metadata?.runtime_profile_name === 'hermes-managed-dev');
  if (!coderTrace) throw new Error('Coder trace does not prove Managed Hermes execution');

  const leaseResult = await pool.query(
    `SELECT lease_id, status, run_id
       FROM argus_runtime_mcp_leases
      WHERE root_trace_id=$1::uuid
      ORDER BY issued_at`,
    [rootTraceId],
  );
  if (leaseResult.rows.length < 1 || !leaseResult.rows.some(row => row.status === 'completed')) {
    throw new Error('Managed Hermes runtime MCP lease has no completed execution evidence');
  }
  const unsafeLease = leaseResult.rows.find(row => ['pending', 'active', 'revoking'].includes(row.status));
  if (unsafeLease) throw new Error(`Runtime MCP lease ${unsafeLease.lease_id} remained ${unsafeLease.status} at the approval gate`);

  const routingLog = await waitForRoutingLog(pool, rootTraceId);
  if (routingLog?.requestedRuntimeMode !== 'auto'
    || routingLog?.effectiveRuntimeMode !== 'managed-hermes'
    || routingLog?.runtimeSelectionReason !== MANAGED_SELECTION.reason) {
    throw new Error('Structured routing log does not match the Core Auto decision');
  }

  return {
    managedCoderTraceId: coderTrace.id,
    agentProviders: Object.fromEntries(traces.rows.map(row => [row.agent_name ?? row.id, row.provider ?? 'unknown'])),
    leaseStates: leaseResult.rows.map(row => row.status),
  };
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
  const baseUrl = process.env.ARGUS_BASE_URL?.trim() || 'http://127.0.0.1:3000';
  const bundleNames = (process.env.ARGUS_AUTO_RUNTIME_BUNDLE_NAMES ?? 'argus-code-intelligence-read,argus-dev-demo')
    .split(',').map(value => value.trim()).filter(Boolean);
  const timeoutMs = integerEnv('ARGUS_AUTO_CERT_TIMEOUT_MS', 20 * 60_000, 60_000, 30 * 60_000);
  const gateHoldMs = integerEnv('ARGUS_AUTO_CERT_GATE_HOLD_MS', 0, 0, 3 * 60_000);
  const preflightOnly = process.argv.includes('--preflight-only');
  const fallbackPreflight = process.argv.includes('--fallback-preflight');
  const grantMergeProbe = process.argv.includes('--grant-merge-probe');
  const auditTaskArg = process.argv.find(value => value.startsWith('--audit-task='));
  const auditTaskId = auditTaskArg?.slice('--audit-task='.length).trim() || '';
  const suffix = Date.now().toString(36).toUpperCase();
  const ticketId = (process.env.ARGUS_AUTO_CERT_TICKET_ID?.trim() || `HERMES-AUTO-${suffix}`).slice(0, 120);
  const marker = `argus-auto-runtime-${suffix.toLowerCase()}`;
  const description = process.env.ARGUS_AUTO_CERT_DESCRIPTION?.trim() || [
    `Create docs/${marker}.md with the heading '# Argus Auto Runtime Certification' and the exact marker '${marker}'.`,
    'Do not modify any other file or dependency.',
    'Run the relevant repository checks and review the result.',
    'Stop at the first Argus human approval gate.',
    'Do not commit, push, open a pull request, merge, deploy, or change credentials.',
  ].join(' ');
  const sessionId = randomUUID();
  let taskId;
  let rootTraceId;
  let cookie;
  let canceled = false;
  let probeRootTraceId;

  try {
    if (grantMergeProbe) {
      const { ExecutionGrantIssuer } = await import('../dist/solutionPacks/executionGrant.js');
      const bundleIds = await resolveBundleIds(pool, bundleNames);
      probeRootTraceId = randomUUID();
      const issuer = new ExecutionGrantIssuer(
        pool,
        `local-certification-${randomUUID()}-${randomUUID()}`,
        60,
        undefined,
        bundleIds,
      );
      const principal = {
        principalKind: 'service',
        principalId: 'hermes-auto-routing-certifier',
        principalAllowedBundleIds: null,
      };
      const rootGrant = await issuer.issueWithClaims({
        packId: PACK_ID,
        agentId: AGENT_ID,
        ...principal,
        requestedBundleIds: bundleIds,
        coreAgentNames: ['planner', 'coder'],
        messageId: randomUUID(),
        rootTraceId: probeRootTraceId,
        workspaceRoot: `/workspace/HERMES-AUTO-MERGE-${Date.now()}`,
        runtimeMode: 'managed-hermes',
        runtimeSelection: MANAGED_SELECTION,
      });
      await issuer.issueWithClaims({
        packId: 'argus.hermes',
        agentId: 'hermes-http',
        ...principal,
        requestedBundleIds: [bundleIds[0]],
        coreAgentNames: ['coder'],
        messageId: randomUUID(),
        rootTraceId: probeRootTraceId,
        workspaceRoot: rootGrant.claims.workspaceRoot,
        workspaceAccess: 'write',
        executionSurface: 'runtime_mcp',
      });
      const trace = await pool.query(
        `SELECT metadata
           FROM mcp_observability_traces
          WHERE id=$1::uuid`,
        [probeRootTraceId],
      );
      const metadata = trace.rows[0]?.metadata;
      assertRuntimeSelection(metadata?.runtime_selection, 'nested-grant root trace');
      const expectedOverride = rootGrant.claims.runtimeProfileOverrides?.[0];
      const actualOverride = Array.isArray(metadata?.runtime_profile_overrides)
        ? metadata.runtime_profile_overrides[0]
        : null;
      const overridePreserved = isRecord(actualOverride) && expectedOverride
        && actualOverride.agentId === expectedOverride.agentId
        && actualOverride.runtimeType === expectedOverride.runtimeType
        && actualOverride.runtimeProfileId === expectedOverride.runtimeProfileId
        && actualOverride.runtimeProfileName === expectedOverride.runtimeProfileName;
      const ownershipMismatches = [
        metadata?.pack_id === PACK_ID ? null : 'pack_id',
        metadata?.pack_agent_id === AGENT_ID ? null : 'pack_agent_id',
        metadata?.execution_grant_id === rootGrant.claims.jti ? null : 'execution_grant_id',
        JSON.stringify(metadata?.bundle_ids) === JSON.stringify(rootGrant.claims.bundleIds) ? null : 'bundle_ids',
        overridePreserved ? null : 'runtime_profile_overrides',
      ].filter(Boolean);
      if (ownershipMismatches.length > 0) {
        throw new Error(`Nested Managed Runtime grant replaced Core-owned root execution metadata: ${ownershipMismatches.join(', ')}`);
      }
      emit({
        ok: true,
        mode: 'grant-merge-probe',
        rootTraceId: probeRootTraceId,
        rootPackId: metadata.pack_id,
        rootAgentId: metadata.pack_agent_id,
        bundleIds: metadata.bundle_ids,
        runtimeSelection: metadata.runtime_selection,
        runtimeOverrides: metadata.runtime_profile_overrides,
      });
      return;
    }
    if (auditTaskId) {
      const stored = await pool.query(
        `SELECT state, task
           FROM argus_a2a_tasks
          WHERE task_id=$1`,
        [auditTaskId],
      );
      const row = stored.rows[0];
      if (!row) throw new Error(`Persisted A2A task ${auditTaskId} was not found`);
      const auditRootTraceId = row.task?.metadata?.argusRootTraceId;
      if (typeof auditRootTraceId !== 'string') throw new Error('Persisted A2A task has no root trace ID');
      const evidence = workflowEvidenceWithin(row.task);
      if (!evidence || evidence.currentStage !== 'human_approval'
        || evidence.testsPassed !== true || evidence.reviewPassed !== true
        || evidence.fileDiffs.length < 1) {
        throw new Error('Persisted task does not retain complete first-approval-gate evidence');
      }
      const rootTrace = await waitForRootTrace(pool, auditRootTraceId, 'cancelled');
      assertRuntimeSelection(rootTrace.metadata?.runtime_selection, 'audited native root trace');
      const persisted = await verifyPersistedEvidence(pool, auditTaskId, auditRootTraceId, 'cancelled');
      emit({
        ok: true,
        mode: 'audit-existing-task',
        taskId: auditTaskId,
        rootTraceId: auditRootTraceId,
        taskState: row.state,
        stage: evidence.currentStage,
        changedFiles: evidence.fileDiffs.length,
        testsPassed: evidence.testsPassed,
        reviewPassed: evidence.reviewPassed,
        ...persisted,
        logsUrl: `${baseUrl}/observe/logs?root_trace=${auditRootTraceId}`,
      });
      return;
    }
    const admin = await pool.query(
      `SELECT id, username
         FROM mcp_users
        WHERE enabled=true AND role='platform_admin'
        ORDER BY id
        LIMIT 1`,
    );
    if (!admin.rows[0]) throw new Error('No enabled platform administrator exists for local certification');
    await pool.query(
      `INSERT INTO mcp_sessions (id,user_id,expires_at,ip_address,user_agent)
       VALUES ($1,$2,now()+interval '30 minutes','127.0.0.1','hermes-auto-routing-certifier')`,
      [sessionId, admin.rows[0].id],
    );
    cookie = `argus_session=${sessionId}`;
    const headers = { cookie, origin: baseUrl, 'content-type': 'application/json' };
    const bundleIds = await resolveBundleIds(pool, bundleNames);
    const hermesDiscovery = await refreshSolutionPacks(baseUrl, headers);
    if (fallbackPreflight) {
      if (hermesDiscovery.state === 'ready') {
        throw new Error('Fallback preflight requires argus.hermes to be unavailable, but discovery still reports ready');
      }
    } else {
      if (hermesDiscovery.state !== 'ready') {
        throw new Error(`Managed Hermes discovery is '${hermesDiscovery.state}', expected 'ready'`);
      }
      await waitForManagedReady(baseUrl, cookie);
    }
    emit({
      event: 'ready', packId: PACK_ID, workflowId: WORKFLOW_ID, bundleNames, bundleIds,
      operator: admin.rows[0].username, hermesDiscoveryState: hermesDiscovery.state,
    });

    const messageUrl = `${baseUrl}/api/admin/solution-packs/${PACK_ID}/agents/${AGENT_ID}/a2a/message`;
    const preflight = await responseJson(await fetch(messageUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: `Verify the ${PACK_ID} solution pack runtime boundary.`,
        data: { operation: 'workflow.preflight', workflowId: WORKFLOW_ID },
        execution: { bundleIds, runtimeMode: 'auto' },
      }),
    }), 'Auto runtime preflight');
    const expectedSelection = fallbackPreflight ? FALLBACK_SELECTION : MANAGED_SELECTION;
    const preflightSelection = assertRuntimeSelection(preflight.task, 'Auto runtime preflight', expectedSelection);
    if (preflight.task?.status?.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`Auto runtime preflight did not complete: ${preflight.task?.status?.state ?? 'unknown'}`);
    }
    emit({ event: 'preflight', ok: true, rootTraceId: preflight.rootTraceId, runtimeSelection: preflightSelection });
    if (preflightOnly || fallbackPreflight) {
      emit({
        ok: true,
        mode: fallbackPreflight ? 'fallback-preflight' : 'preflight-only',
        hermesDiscoveryState: hermesDiscovery.state,
        runtimeSelection: preflightSelection,
      });
      return;
    }

    const launched = await responseJson(await fetch(messageUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: `Start ${WORKFLOW_ID} through the governed ${PACK_ID} runtime.`,
        data: {
          operation: 'workflow.start',
          workflowId: WORKFLOW_ID,
          input: { ticket_id: ticketId, description },
        },
        execution: { bundleIds, runtimeMode: 'auto' },
      }),
    }), 'Auto runtime launch');
    taskId = launched.task?.id;
    rootTraceId = launched.rootTraceId;
    if (!taskId || !rootTraceId) throw new Error('Auto runtime launch returned no task or root trace ID');
    const launchSelection = assertRuntimeSelection(launched.task, 'Auto runtime launch');
    emit({
      event: 'launched', taskId, rootTraceId, ticketId,
      runtimeSelection: launchSelection,
      logsUrl: `${baseUrl}/observe/logs?root_trace=${rootTraceId}`,
    });

    const task = await waitForTask(baseUrl, cookie, taskId, timeoutMs);
    const evidence = workflowEvidenceWithin(task);
    if (!evidence || evidence.currentStage !== 'human_approval') {
      throw new Error(`Workflow stopped at '${String(evidence?.currentStage ?? 'unknown')}', not human_approval`);
    }
    if (evidence.testsPassed !== true || evidence.reviewPassed !== true || evidence.fileDiffs.length < 1) {
      throw new Error('Approval-gate evidence is incomplete: a diff, passing tests and passing review are required');
    }
    assertRuntimeSelection(task, 'polled workflow task');
    const persisted = await verifyPersistedEvidence(pool, taskId, rootTraceId);
    emit({
      event: 'approval-gate',
      taskId,
      rootTraceId,
      ticketId,
      stage: evidence.currentStage,
      changedFiles: evidence.fileDiffs.length,
      testsPassed: evidence.testsPassed,
      reviewPassed: evidence.reviewPassed,
      ...persisted,
      holdMs: gateHoldMs,
    });
    if (gateHoldMs > 0) await sleep(gateHoldMs);

    const cancelUrl = `${baseUrl}/api/admin/solution-packs/${PACK_ID}/agents/${AGENT_ID}/a2a/tasks/${taskId}/cancel`;
    const cancellation = await responseJson(await fetch(cancelUrl, { method: 'POST', headers, body: '{}' }), 'task cancellation');
    canceled = cancellation.task?.status?.state === 'TASK_STATE_CANCELED';
    if (!canceled) throw new Error(`Task cleanup returned ${cancellation.task?.status?.state ?? 'unknown'}, not TASK_STATE_CANCELED`);
    await waitForRootTrace(pool, rootTraceId, 'cancelled');
    const remainingLeases = await pool.query(
      `SELECT lease_id, status
         FROM argus_runtime_mcp_leases
        WHERE root_trace_id=$1::uuid AND status IN ('pending','active','revoking')`,
      [rootTraceId],
    );
    if (remainingLeases.rows.length > 0) throw new Error('Runtime MCP lease cleanup is incomplete after cancellation');
    emit({
      ok: true,
      taskId,
      rootTraceId,
      ticketId,
      finalState: cancellation.task.status.state,
      runtimeSelection: launchSelection,
      changedFiles: evidence.fileDiffs.length,
      testsPassed: evidence.testsPassed,
      reviewPassed: evidence.reviewPassed,
      managedCoderTraceId: persisted.managedCoderTraceId,
      logsUrl: `${baseUrl}/observe/logs?root_trace=${rootTraceId}`,
    });
  } finally {
    if (taskId && cookie && !canceled) {
      await fetch(`${baseUrl}/api/admin/solution-packs/${PACK_ID}/agents/${AGENT_ID}/a2a/tasks/${taskId}/cancel`, {
        method: 'POST',
        headers: { cookie, origin: baseUrl, 'content-type': 'application/json' },
        body: '{}',
      }).catch(() => undefined);
    }
    await pool.query('DELETE FROM mcp_sessions WHERE id=$1', [sessionId]).catch(() => undefined);
    if (probeRootTraceId) {
      await pool.query('DELETE FROM argus_execution_grants WHERE root_trace_id=$1::uuid', [probeRootTraceId]).catch(() => undefined);
      await pool.query('DELETE FROM mcp_observability_traces WHERE id=$1::uuid', [probeRootTraceId]).catch(() => undefined);
    }
    await pool.end().catch(() => undefined);
  }
}

await main();
