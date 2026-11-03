import assert from 'node:assert/strict';
import test from 'node:test';
import { ArgusCoreClient, CoreAgentClientError } from './coreClient.js';
import type { PackExecutionGrant } from './executionGrant.js';

const grant: PackExecutionGrant = {
  token: 'eg_v1.payload.signature',
  claims: {
    jti: '48b965a2-7888-4bd2-999b-132571107d82', bundleIds: [9], coreAgentIds: [12, 14],
    coreAgents: [{ name: 'aiops-researcher', id: 12 }, { name: 'aiops-reviewer', id: 14 }],
    principalKind: 'user', principalId: '1', messageId: 'message-1',
    rootTraceId: 'ad7c7498-cdb5-4ac0-9cf5-9ecbe6601a4a', iat: 1, exp: 2,
    resourceScope: { kind: 'kubernetes', backendId: 7, targetId: 'test-cluster', cluster: 'test', namespace: 'production', environment: 'test' },
  },
};

test('calls only the Core Agent bound into the execution grant', async () => {
  let request: Request | undefined;
  const client = new ArgusCoreClient({
    baseUrl: 'http://argus-core:3000/',
    fetchFn: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({
        response: 'Metrics deviated before pod restarts.', session_id: 'session-1',
        tool_calls: [{
          name: 'prometheus_query_range',
          args: { query: 'rate(errors[5m])' },
          result: '{"status":"success"}',
          tool_call_id: 'call-provider-1',
          trace_id: 'ad7c7498-cdb5-4ac0-9cf5-9ecbe6601a4a',
          span_id: 'bd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4b',
        }], iterations: 2,
        citations: [{ source: 'incident-runbook.md', index: 'argus-aiops-runbooks', score: 0.92, snippet: 'not retained by Pack' }],
        agent: { id: 12, name: 'researcher', label: 'Researcher', model: 'provider-model' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await client.callAgent({ agentName: 'researcher', message: 'Investigate read-only.', grant });
  assert.equal(new URL(request!.url).pathname, '/api/agents/12/chat');
  assert.equal(request!.headers.get('authorization'), `Bearer ${grant.token}`);
  assert.equal(request!.headers.get('x-argus-root-trace-id'), grant.claims.rootTraceId);
  assert.deepEqual((await request!.clone().json() as { execution_tool_allow_patterns: string[] }).execution_tool_allow_patterns, [
    'aiops_*', 'argus_observe_*',
  ]);
  assert.equal((await request!.clone().json() as { include_tool_results: boolean }).include_tool_results, true);
  assert.equal(result.toolCalls[0]?.name, 'prometheus_query_range');
  assert.equal(result.toolCalls[0]?.result, '{"status":"success"}');
  assert.equal(result.toolCalls[0]?.toolCallId, 'call-provider-1');
  assert.equal(result.toolCalls[0]?.traceId, 'ad7c7498-cdb5-4ac0-9cf5-9ecbe6601a4a');
  assert.equal(result.toolCalls[0]?.spanId, 'bd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4b');
  assert.deepEqual(result.ragCitations, [{ source: 'incident-runbook.md', index: 'argus-aiops-runbooks', score: 0.92 }]);
});

test('uses the exact provider-neutral tools in a signed AIOps service-profile grant', async () => {
  let request: Request | undefined;
  const client = new ArgusCoreClient({
    baseUrl: 'http://argus-core:3000',
    fetchFn: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({
        response: 'OpenSearch evidence collected.', session_id: 'session-2', tool_calls: [], iterations: 1,
        agent: { id: 12, name: 'researcher', label: 'Researcher', model: 'provider-model' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const profileGrant: PackExecutionGrant = {
    ...grant,
    claims: {
      ...grant.claims,
      toolNames: ['aiops_loki_query_range', 'opensearch_prod_search'],
      aiopsServiceContext: {
        profileId: 2, revision: 2, profileSha256: 'a'.repeat(64), resolvedContextSha256: 'b'.repeat(64),
      },
    },
  };

  await client.callAgent({ agentName: 'researcher', message: 'Collect the exact configured recipes.', grant: profileGrant });

  assert.deepEqual((await request!.clone().json() as { execution_tool_allow_patterns: string[] }).execution_tool_allow_patterns, [
    'aiops_loki_query_range', 'opensearch_prod_search',
  ]);
});

test('fails closed when a role is not bound into the grant', async () => {
  const client = new ArgusCoreClient({ baseUrl: 'http://argus-core:3000', fetchFn: async () => new Response('{}') });
  await assert.rejects(
    client.callAgent({ agentName: 'knowledge', message: 'Search runbooks.', grant }),
    (error: unknown) => error instanceof CoreAgentClientError && error.status === 403,
  );
});
