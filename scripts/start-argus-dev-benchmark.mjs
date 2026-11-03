#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { ExecutionGrantIssuer } from '../dist/solutionPacks/executionGrant.js';

dotenv.config({ quiet: true });

const SUPPORTED_BENCHMARKS = new Set(['nestjs-4873', 'rclone-8675']);
const SUPPORTED_RETRIEVAL_VARIANTS = new Set(['baseline', 'candidate']);
const BENCHMARK_GRANT_TTL_SECONDS = 60 * 60;
const A2A_HEADERS = Object.freeze({
  accept: 'application/a2a+json',
  'content-type': 'application/a2a+json',
  'a2a-version': '1.0',
});

function required(name, fallback = '') {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function responseJson(response, operation) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${operation} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function resolveBundles(pool, benchmark) {
  const names = [
    `argus-dev-${benchmark}`,
    'argus-code-intelligence-read',
    'argus-code-intelligence-index',
  ];
  const result = await pool.query(
    'SELECT id, name FROM mcp_service_bundles WHERE name=ANY($1::text[])',
    [names],
  );
  const byName = new Map(result.rows.map(row => [row.name, Number(row.id)]));
  const missing = names.filter(name => !byName.has(name));
  if (missing.length) {
    throw new Error(`Required benchmark bundles are missing: ${missing.join(', ')}`);
  }
  // Argus.Dev resolves git credentials from the first execution bundle.
  return names.map(name => byName.get(name));
}

async function main() {
  const benchmark = argument('benchmark') ?? process.argv[2];
  if (!SUPPORTED_BENCHMARKS.has(benchmark)) {
    throw new Error('Usage: node scripts/start-argus-dev-benchmark.mjs --benchmark <nestjs-4873|rclone-8675> [--variant <baseline|candidate>]');
  }
  const retrievalVariant = argument('variant') ?? 'candidate';
  if (!SUPPORTED_RETRIEVAL_VARIANTS.has(retrievalVariant)) {
    throw new Error('--variant must be baseline or candidate');
  }

  const manifestPath = path.resolve(`demo/argus-dev/${benchmark}/benchmark.json`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const databaseUrl = required('POSTGRES_CONNECTION_URL');
  const signingSecret = required(
    'ARGUS_EXECUTION_GRANT_SECRET',
    process.env.WORKSPACE_SECRET?.trim(),
  );
  const argusDevUrl = (
    process.env.ARGUS_BENCHMARK_A2A_URL?.trim()
    || process.env.ARGUS_STAGE3_LANGGRAPH_URL?.trim()
    || 'http://127.0.0.1:2025'
  ).replace(/\/$/u, '');

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const bundleIds = await resolveBundles(pool, benchmark);
    // Hard real-repository workflows legitimately span several subscription
    // runtime calls. Keep the benchmark grant bounded by Core's maximum while
    // avoiding a mid-run expiry caused by the short interactive default.
    const issuer = new ExecutionGrantIssuer(pool, signingSecret, BENCHMARK_GRANT_TTL_SECONDS);
    const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`.toUpperCase();
    const ticketId = `${benchmark}-${suffix}`;
    const rootTraceId = randomUUID();
    const messageId = randomUUID();
    const grant = await issuer.issue({
      packId: 'argus.dev',
      agentId: 'coding-orchestrator',
      principalKind: 'service',
      principalId: 'real-repository-benchmark',
      principalAllowedBundleIds: null,
      requestedBundleIds: bundleIds,
      coreAgentNames: ['planner', 'knowledge', 'coder', 'reviewer', 'researcher'],
      messageId,
      rootTraceId,
      workspaceRoot: `/workspace/${ticketId}`,
      codeContextVariant: retrievalVariant,
    });

    const spanId = randomBytes(8).toString('hex');
    const response = await fetch(`${argusDevUrl}/message:send`, {
      method: 'POST',
      headers: {
        ...A2A_HEADERS,
        traceparent: `00-${rootTraceId.replaceAll('-', '')}-${spanId}-01`,
        'x-argus-root-trace-id': rootTraceId,
        'x-argus-execution-grant': grant,
      },
      body: JSON.stringify({
        message: {
          messageId,
          role: 'ROLE_USER',
          parts: [{ data: {
            operation: 'workflow.start',
            workflowId: 'ticket-to-pull-request',
            input: {
              ticket_id: ticketId,
              description: manifest.ticket.description,
              test_command: manifest.oracle.projectTestCommand,
            },
          } }],
          metadata: {
            argusRootTraceId: rootTraceId,
            argusPackId: 'argus.dev',
            argusAgentId: 'coding-orchestrator',
          },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await responseJson(response, 'start Argus.Dev benchmark');
    if (!body.task?.id) throw new Error('Argus.Dev returned no A2A task ID');

    console.log(JSON.stringify({
      benchmark,
      retrievalVariant,
      ticketId,
      taskId: body.task.id,
      workflowThreadId: body.task.metadata?.workflowThreadId ?? rootTraceId,
      rootTraceId,
      bundleIds,
      grantTtlSeconds: BENCHMARK_GRANT_TTL_SECONDS,
      taskState: body.task.status?.state ?? 'TASK_STATE_UNKNOWN',
      argusDevUrl: `http://localhost:3000/solutions/argus.dev?task=${body.task.id}`,
      traceUrl: `http://localhost:3000/runs/workflow/${rootTraceId}`,
      logUrl: `http://localhost:3000/observe/logs?root_trace=${rootTraceId}`,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
