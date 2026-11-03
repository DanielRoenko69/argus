import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import { Agent as UndiciAgent } from 'undici';
import { ExecutionGrantIssuer } from '../dist/solutionPacks/executionGrant.js';

dotenv.config();

const databaseUrl = process.env.POSTGRES_CONNECTION_URL ?? '';
const signingSecret = process.env.ARGUS_EXECUTION_GRANT_SECRET
  || process.env.WORKSPACE_SECRET
  || '';
const coreUrl = (process.env.ARGUS_CODE_INDEX_CORE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const workspaceRoot = process.env.ARGUS_CODE_INDEX_WORKSPACE ?? '/workspace/ARGUS-E2E';
const repositoryBundle = process.env.ARGUS_CODE_INDEX_REPOSITORY_BUNDLE ?? 'argus-dev-demo';
const agentName = process.env.ARGUS_CODE_INDEX_AGENT ?? 'coder';
const certifyPolicyCycle = process.env.ARGUS_CODE_CONTEXT_CERTIFY_POLICY_CYCLE === 'true';
const indexOnly = process.env.ARGUS_CODE_INDEX_ONLY === 'true';
const requestTimeoutMs = Number(process.env.ARGUS_CODE_INDEX_REQUEST_TIMEOUT_MS ?? 900_000);

if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 60_000 || requestTimeoutMs > 1_800_000) {
  throw new Error('ARGUS_CODE_INDEX_REQUEST_TIMEOUT_MS must be an integer from 60000 to 1800000');
}

if (!databaseUrl) throw new Error('POSTGRES_CONNECTION_URL is required');
if (Buffer.byteLength(signingSecret, 'utf8') < 32) {
  throw new Error('ARGUS_EXECUTION_GRANT_SECRET or the local WORKSPACE_SECRET fallback must contain at least 32 bytes');
}
if (!/^\/workspace\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceRoot)) {
  throw new Error('ARGUS_CODE_INDEX_WORKSPACE must be one exact child of /workspace');
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const dispatcher = new UndiciAgent({
  connectTimeout: 30_000,
  headersTimeout: requestTimeoutMs,
  bodyTimeout: requestTimeoutMs,
});
const rootTraceId = randomUUID();
let issuer;
let runtimePolicyRestore = null;

try {
  const bundleNames = [
    'argus-code-intelligence-read',
    'argus-code-intelligence-index',
    repositoryBundle,
  ];
  const bundles = await pool.query(
    'SELECT id, name FROM mcp_service_bundles WHERE name=ANY($1::text[])',
    [bundleNames],
  );
  const ids = new Map(bundles.rows.map(row => [row.name, Number(row.id)]));
  const missing = bundleNames.filter(name => !ids.has(name));
  if (missing.length > 0) throw new Error(`required MCP Bundles are missing: ${missing.join(', ')}`);

  const agent = await pool.query(
    `SELECT a.id,
            p.id AS runtime_profile_id,
            p.runtime_type,
            COALESCE(p.code_context_mode, 'metadata_only') AS code_context_mode,
            p.code_context_max_results,
            p.code_context_max_bytes
       FROM mcp_agents a
       LEFT JOIN mcp_agent_runtime_profiles p ON p.id = a.runtime_profile_id
      WHERE a.name=$1 AND a.enabled=true
      LIMIT 1`,
    [agentName],
  );
  const agentId = Number(agent.rows[0]?.id ?? 0);
  if (!agentId) throw new Error(`enabled Core agent '${agentName}' was not found`);
  const codeContextMode = String(agent.rows[0]?.code_context_mode ?? 'metadata_only');
  const codeContextMaxResults = Number(agent.rows[0]?.code_context_max_results ?? 4);
  const runtimeProfileId = Number(agent.rows[0]?.runtime_profile_id ?? 0);
  const runtimeType = String(agent.rows[0]?.runtime_type ?? '');
  if (certifyPolicyCycle && indexOnly) {
    throw new Error('ARGUS_CODE_CONTEXT_CERTIFY_POLICY_CYCLE cannot be combined with ARGUS_CODE_INDEX_ONLY');
  }
  if (certifyPolicyCycle) {
    if (!runtimeProfileId || !['codex', 'claude-code'].includes(runtimeType)) {
      throw new Error('policy-cycle certification requires an external runtime profile assigned to the selected Agent');
    }
    runtimePolicyRestore = {
      profileId: runtimeProfileId,
      mode: codeContextMode,
      maxResults: codeContextMaxResults,
      maxBytes: Number(agent.rows[0]?.code_context_max_bytes ?? 12_000),
    };
  }

  issuer = new ExecutionGrantIssuer(pool, signingSecret);
  const grant = await issuer.issue({
    packId: 'argus.dev',
    agentId: 'coding-orchestrator',
    principalKind: 'service',
    principalId: 'code-index-certification',
    principalAllowedBundleIds: null,
    requestedBundleIds: bundleNames.map(name => ids.get(name)),
    coreAgentNames: [agentName],
    messageId: randomUUID(),
    rootTraceId,
    workspaceRoot,
  });

  const response = await fetch(`${coreUrl}/api/agents/${agentId}/code-index`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${grant}`,
      'x-argus-root-trace-id': rootTraceId,
    },
    body: '{}',
    signal: AbortSignal.timeout(requestTimeoutMs),
    dispatcher,
  });
  const payload = await response.json();
  if (!response.ok || !payload?.snapshot?.id) {
    throw new Error(`code index handshake failed (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`);
  }
  let effectiveCodeContextMode = codeContextMode;
  let effectiveCodeContextMaxResults = codeContextMaxResults;
  if (certifyPolicyCycle) {
    await pool.query(
      `UPDATE mcp_agent_runtime_profiles
          SET code_context_mode='bounded_source', code_context_max_results=2, code_context_max_bytes=4096
        WHERE id=$1`,
      [runtimeProfileId],
    );
    effectiveCodeContextMode = 'bounded_source';
    effectiveCodeContextMaxResults = 2;
  }
  const retrievalCases = [
    { query: 'createApp', expected: ['src/app.js'] },
    { query: 'service catalog filtered by tier', expected: ['src/app.js', 'test/app.test.js'] },
    { query: 'unknown routes JSON 404', expected: ['src/app.js', 'test/app.test.js'] },
  ];
  const retrieval = [];
  let metadataOnlyDenialTested = false;
  const assertMetadataOnlyDenial = async () => {
    const deniedResponse = await fetch(`${coreUrl}/api/agents/${agentId}/code-context`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${grant}`,
        'x-argus-root-trace-id': rootTraceId,
      },
      body: JSON.stringify({ query: 'metadata-only policy certification', limit: 1 }),
      signal: AbortSignal.timeout(Math.min(requestTimeoutMs, 30_000)),
      dispatcher,
    });
    const denied = await deniedResponse.json();
    if (deniedResponse.status !== 403 || denied?.code !== 'code_context_sharing_denied') {
      throw new Error(`metadata-only policy did not fail closed (${deniedResponse.status}): ${JSON.stringify(denied).slice(0, 500)}`);
    }
    metadataOnlyDenialTested = true;
  };
  if (!indexOnly && effectiveCodeContextMode !== 'bounded_source') {
    await assertMetadataOnlyDenial();
  }
  for (const testCase of !indexOnly && effectiveCodeContextMode === 'bounded_source' ? retrievalCases : []) {
    const startedAt = performance.now();
    const contextResponse = await fetch(`${coreUrl}/api/agents/${agentId}/code-context`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${grant}`,
        'x-argus-root-trace-id': rootTraceId,
      },
      body: JSON.stringify({ query: testCase.query, limit: Math.min(6, effectiveCodeContextMaxResults) }),
      signal: AbortSignal.timeout(requestTimeoutMs),
      dispatcher,
    });
    const context = await contextResponse.json();
    if (!contextResponse.ok || !Array.isArray(context?.evidence)) {
      throw new Error(`code context retrieval failed (${contextResponse.status}): ${JSON.stringify(context).slice(0, 500)}`);
    }
    const paths = [...new Set(context.evidence.map(item => item.filePath).filter(Boolean))];
    const matched = testCase.expected.some(expected => paths.includes(expected));
    if (!matched) {
      throw new Error(`retrieval case '${testCase.query}' missed expected paths ${testCase.expected.join(', ')}`);
    }
    retrieval.push({
      query: testCase.query,
      matched,
      latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
      channels: context.channelsUsed,
      citations: context.evidence.slice(0, 3).map(item => item.citation),
    });
  }
  if (certifyPolicyCycle) {
    await pool.query(
      `UPDATE mcp_agent_runtime_profiles SET code_context_mode='metadata_only' WHERE id=$1`,
      [runtimeProfileId],
    );
    await assertMetadataOnlyDenial();
    await pool.query(
      `UPDATE mcp_agent_runtime_profiles
          SET code_context_mode=$2, code_context_max_results=$3, code_context_max_bytes=$4
        WHERE id=$1`,
      [runtimePolicyRestore.profileId, runtimePolicyRestore.mode, runtimePolicyRestore.maxResults, runtimePolicyRestore.maxBytes],
    );
    runtimePolicyRestore = null;
  }
  await issuer.finalizeRootTrace(rootTraceId, 'completed', {
    certification: 'native-code-intelligence-handshake',
    snapshotId: payload.snapshot.id,
    commitSha: payload.snapshot.commitSha,
    retrievalCases: retrieval.length,
    codeContextMode: effectiveCodeContextMode,
    policyCycle: certifyPolicyCycle,
    indexOnly,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    rootTraceId,
    workspaceRoot,
    agent: agentName,
    bundles: bundleNames,
    snapshot: payload.snapshot,
    retrieval,
    sourceContext: {
      mode: effectiveCodeContextMode,
      tested: effectiveCodeContextMode === 'bounded_source',
      denialTested: metadataOnlyDenialTested,
      policyCycle: certifyPolicyCycle,
      indexOnly,
      restoredMode: codeContextMode,
      reason: indexOnly
        ? 'index_only'
        : (effectiveCodeContextMode === 'bounded_source' ? null : 'runtime_profile_metadata_only'),
    },
  }, null, 2)}\n`);
} catch (error) {
  if (issuer) {
    await issuer.finalizeRootTrace(rootTraceId, 'failed', {
      certification: 'native-code-intelligence-handshake',
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  }
  throw error;
} finally {
  if (runtimePolicyRestore) {
    await pool.query(
      `UPDATE mcp_agent_runtime_profiles
          SET code_context_mode=$2, code_context_max_results=$3, code_context_max_bytes=$4
        WHERE id=$1`,
      [runtimePolicyRestore.profileId, runtimePolicyRestore.mode, runtimePolicyRestore.maxResults, runtimePolicyRestore.maxBytes],
    ).catch(() => undefined);
  }
  await dispatcher.close();
  await pool.end();
}
