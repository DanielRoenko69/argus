import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { ExecutionGrantIssuer } from '../solutionPacks/executionGrant.js';

const ticketId = process.env['ARGUS_E2E_TICKET_ID']?.trim() || 'ARGUS-E2E';
const description = process.env['ARGUS_E2E_DESCRIPTION']?.trim()
  || 'Modify the existing project and add an automated test for the requested behavior.';
const bundleName = process.env['ARGUS_E2E_BUNDLE']?.trim() || 'argus-dev-demo';
const codeIntelligenceEnabled = process.env['ARGUS_E2E_CODE_INTELLIGENCE'] !== 'false';
const databaseUrl = process.env['POSTGRES_CONNECTION_URL'] ?? '';
const signingSecret = process.env['ARGUS_EXECUTION_GRANT_SECRET'] ?? '';
const langgraphUrl = (process.env['LANGGRAPH_URL'] ?? 'http://argus-dev:2025').replace(/\/$/, '');

if (!databaseUrl) throw new Error('POSTGRES_CONNECTION_URL is required');
if (Buffer.byteLength(signingSecret, 'utf8') < 32) {
  throw new Error('ARGUS_EXECUTION_GRANT_SECRET must contain at least 32 bytes');
}

const safeTicket = ticketId.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
const rootTraceId = randomUUID();
const messageId = randomUUID();
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const bundleNames = [
    bundleName,
    ...(codeIntelligenceEnabled
      ? ['argus-code-intelligence-read', 'argus-code-intelligence-index']
      : []),
  ];
  const bundles = await pool.query<{ id: number; name: string }>(
    'SELECT id, name FROM mcp_service_bundles WHERE name=ANY($1::text[])',
    [bundleNames],
  );
  const bundleIdsByName = new Map(bundles.rows.map(row => [row.name, Number(row.id)]));
  const missingBundles = bundleNames.filter(name => !bundleIdsByName.has(name));
  if (missingBundles.length > 0) throw new Error(`Required bundles were not found: ${missingBundles.join(', ')}`);
  const requestedBundleIds = bundleNames.map(name => bundleIdsByName.get(name)!);
  const bundleId = bundleIdsByName.get(bundleName)!;

  const grant = await new ExecutionGrantIssuer(pool, signingSecret).issue({
    packId: 'argus.dev',
    agentId: 'coding-orchestrator',
    principalKind: 'service',
    principalId: 'local-e2e',
    principalAllowedBundleIds: null,
    requestedBundleIds,
    coreAgentNames: ['planner', 'knowledge', 'coder', 'reviewer', 'researcher'],
    messageId,
    rootTraceId,
    workspaceRoot: `/workspace/${safeTicket}`,
  });

  const spanId = randomBytes(8).toString('hex');
  const response = await fetch(`${langgraphUrl}/message:send`, {
    method: 'POST',
    headers: {
      accept: 'application/a2a+json',
      'content-type': 'application/a2a+json',
      'a2a-version': '1.0',
      traceparent: `00-${rootTraceId.replaceAll('-', '')}-${spanId}-01`,
      'x-argus-root-trace-id': rootTraceId,
      'x-argus-execution-grant': grant,
    },
    body: JSON.stringify({
      message: {
        messageId,
        role: 'ROLE_USER',
        parts: [{
          data: {
            operation: 'workflow.start',
            workflowId: 'ticket-to-pull-request',
            input: { ticket_id: ticketId, description },
          },
        }],
        metadata: {
          argusRootTraceId: rootTraceId,
          argusPackId: 'argus.dev',
          argusAgentId: 'coding-orchestrator',
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json() as {
    task?: { id?: string; status?: { state?: string }; metadata?: { workflowThreadId?: string } };
    error?: unknown;
  };
  if (!response.ok || !body.task?.id) {
    throw new Error(`Argus.Dev start failed (${response.status}): ${JSON.stringify(body.error ?? body)}`);
  }
  process.stdout.write(JSON.stringify({
    rootTraceId,
    taskId: body.task.id,
    workflowThreadId: body.task.metadata?.workflowThreadId ?? rootTraceId,
    state: body.task.status?.state ?? 'unknown',
    ticketId,
    bundleId,
    bundleIds: requestedBundleIds,
    codeIntelligenceEnabled,
  }));
} finally {
  await pool.end();
}
