import assert from 'node:assert/strict';
import test from 'node:test';
import { CORE_AGENT_NAME_BY_ROLE, type CoreAgentInvoker, type CoreAgentResponse } from './coreClient.js';
import { buildInvestigationPlan } from './domain.js';
import type { PackExecutionGrant } from './executionGrant.js';
import { InvestigationRunner } from './investigationRunner.js';
import { InMemoryTaskStore, type A2aTask } from './taskStore.js';

const grant: PackExecutionGrant = {
  token: 'eg_v1.payload.signature',
  claims: {
    jti: '48b965a2-7888-4bd2-999b-132571107d82', bundleIds: [9], coreAgentIds: [1, 2, 3],
    coreAgents: [{ name: 'aiops-researcher', id: 1 }, { name: 'aiops-knowledge', id: 2 }, { name: 'aiops-reviewer', id: 3 }],
    principalKind: 'user', principalId: '1', messageId: 'message-1',
    rootTraceId: 'ad7c7498-cdb5-4ac0-9cf5-9ecbe6601a4a', iat: 1, exp: 2,
    resourceScope: { kind: 'kubernetes', backendId: 7, targetId: 'test-cluster', cluster: 'test', namespace: 'production', environment: 'test' },
  },
};

const plan = buildInvestigationPlan({
  title: 'Checkout latency', summary: 'P95 increased.', severity: 'critical', service: 'checkout',
  environment: 'production', correlation_window_minutes: 30,
}, {
  now: new Date('2026-08-11T10:00:00.000Z'),
  selectedBundleIds: [9],
  resourceScope: grant.claims.resourceScope,
});

function reviewerResult(): string {
  return JSON.stringify({
    conclusion: 'suspected',
    executiveAssessment: 'The deployment hypothesis is plausible but not proven.',
    rootCause: null,
    hypotheses: [{
      id: 'recent-change-regression',
      statement: 'A recent change caused the degradation.',
      verdict: 'supported',
      confidence: 68,
      evidenceFor: ['The change overlaps the incident window.'],
      evidenceAgainst: ['No comparison with unchanged instances is available.'],
    }],
    evidence: [{ lane: 'metrics', claim: 'Error rate increased in the incident window.', sourceRefs: ['aiops_prometheus_query_range'] }],
    recommendedActions: [{ priority: 'next', action: 'Compare changed and unchanged instances.', rationale: 'This differentiates the leading hypothesis.', requiresApproval: false }],
  });
}

function kubernetesList(items: Record<string, unknown>[]): string {
  return JSON.stringify({ apiVersion: 'v1', kind: 'List', items });
}

test('collects, reviews and persists only bounded redacted evidence', async () => {
  const store = new InMemoryTaskStore();
  const task: A2aTask = {
    id: '48b965a2-7888-4bd2-999b-132571107d83', contextId: '48b965a2-7888-4bd2-999b-132571107d84',
    status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: 'plan', name: 'plan', parts: [{ data: plan as unknown as Record<string, unknown> }] }],
  };
  await store.save(task);
  const core: CoreAgentInvoker = {
    async callAgent(input): Promise<CoreAgentResponse> {
      return {
        response: input.agentName === 'reviewer' ? reviewerResult() : `${input.agentName} evidence`,
        sessionId: `${input.agentName}-session`, iterations: 1,
        toolCalls: input.agentName === 'researcher'
          ? [
              { name: 'aiops_prometheus_query_range', args: { query: 'rate(errors[5m])', end: '2026-08-11T10:00:00.000Z', bearerToken: 'do-not-store' } },
              { name: 'aiops_loki_query_range', args: { query: '{service="checkout"}', end: '2026-08-11T10:00:00.000Z' } },
              { name: 'aiops_jaeger_find_traces', args: { service: 'checkout', end_micros: '1786442400000000' } },
              {
                name: 'aiops_kubernetes_k8s_get_resources',
                args: { resource_type: 'services', namespace: 'production', output: 'json' },
                toolCallId: 'call-services', traceId: grant.claims.rootTraceId,
                spanId: 'bd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4b',
                result: kubernetesList([{
                  kind: 'Service', metadata: { name: 'checkout', namespace: 'production', labels: { 'app.kubernetes.io/name': 'checkout' } },
                  spec: { selector: { 'app.kubernetes.io/name': 'checkout' }, clusterIP: 'raw-provider-detail-do-not-store' }, status: {},
                }]),
              },
              {
                name: 'aiops_kubernetes_k8s_get_resources',
                args: { resource_type: 'deployments', namespace: 'production', output: 'json' },
                toolCallId: 'call-deployments', traceId: grant.claims.rootTraceId,
                spanId: 'cd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4c',
                result: kubernetesList([{
                  kind: 'Deployment', metadata: { name: 'checkout', namespace: 'production', labels: { 'app.kubernetes.io/name': 'checkout' } },
                  spec: { replicas: 2, selector: { matchLabels: { 'app.kubernetes.io/name': 'checkout' } } },
                  status: { replicas: 2, readyReplicas: 2 },
                }]),
              },
              {
                name: 'aiops_kubernetes_k8s_get_resources',
                args: { resource_type: 'pods', namespace: 'production', output: 'json' },
                toolCallId: 'call-pods', traceId: grant.claims.rootTraceId,
                spanId: 'dd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4d',
                result: kubernetesList([{
                  kind: 'Pod', metadata: {
                    name: 'checkout-abc', namespace: 'production', uid: 'pod-current', labels: { 'app.kubernetes.io/name': 'checkout' },
                    ownerReferences: [{ controller: true, kind: 'ReplicaSet', name: 'checkout-abc' }],
                  },
                  status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
                }]),
              },
              {
                name: 'aiops_kubernetes_k8s_get_events', args: { namespace: 'production' },
                toolCallId: 'call-events', traceId: grant.claims.rootTraceId,
                spanId: 'ed7c7498-cdb5-4ac0-9cf5-9ecbe6601a4e',
                result: kubernetesList([{
                  kind: 'Event', type: 'Warning', reason: 'Unhealthy', message: 'checkout readiness probe failed',
                  lastTimestamp: '2026-08-11T09:59:00.000Z', involvedObject: { kind: 'Pod', name: 'checkout-abc', namespace: 'production', uid: 'pod-current' },
                }, {
                  kind: 'Event', type: 'Warning', reason: 'HistoricalFailure', message: 'checkout old pod failed',
                  lastTimestamp: '2026-08-11T09:58:00.000Z', involvedObject: { kind: 'Pod', name: 'checkout-old', namespace: 'production', uid: 'pod-old' },
                }]),
              },
            ]
          : [],
        ragCitations: input.agentName === 'knowledge'
          ? [{ source: 'checkout-incident-runbook.md', index: 'operations-runbooks', score: 0.93 }]
          : [],
        agent: { id: grant.claims.coreAgents.find(agent => agent.name === CORE_AGENT_NAME_BY_ROLE[input.agentName as keyof typeof CORE_AGENT_NAME_BY_ROLE])!.id, name: input.agentName, label: input.agentName, model: 'test-model' },
      };
    },
  };
  await new InvestigationRunner(store, core).run({ taskId: task.id, plan, grant });
  const completed = await store.get(task.id);
  assert.equal(completed?.status.state, 'TASK_STATE_COMPLETED');
  const result = completed?.artifacts?.at(-1)?.parts[0]?.data;
  assert.equal(result?.['kind'], 'aiops-investigation-evidence');
  assert.equal(result?.['schemaVersion'], 2);
  assert.equal(result?.['quality'], 'reviewed');
  assert.equal((result?.['diagnosis'] as { conclusion: string }).conclusion, 'suspected');
  assert.equal(result?.['synthesis'], 'The deployment hypothesis is plausible but not proven.');
  assert.deepEqual((result?.['signalCoverage'] as Array<{ lane: string; status: string }>).filter(item => ['metrics', 'logs', 'traces'].includes(item.lane)).map(item => item.status), ['collected', 'collected', 'collected']);
  assert.equal((result?.['timeline'] as unknown[]).length, 8);
  const kubernetes = result?.['kubernetesEvidence'] as {
    namespace: string; resources: Array<{ kind: string; name: string; status: string; owner?: string; provenance: { toolCallId?: string; spanId?: string } }>;
    edges: Array<{ from: string; to: string; relation: string }>; events: Array<{ reason: string; provenance: { toolCallId?: string; spanId?: string } }>;
  };
  assert.equal(kubernetes.namespace, 'production');
  assert.deepEqual(kubernetes.resources.map(item => item.kind), ['Service', 'Deployment', 'Pod']);
  assert.equal(kubernetes.resources.find(item => item.kind === 'Deployment')?.status, 'Healthy (2/2)');
  assert.equal(kubernetes.resources.find(item => item.kind === 'Pod')?.owner, 'Deployment/checkout');
  assert.equal(kubernetes.resources.find(item => item.kind === 'Pod')?.provenance.toolCallId, 'call-pods');
  assert.equal(kubernetes.resources.find(item => item.kind === 'Pod')?.provenance.spanId, 'dd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4d');
  assert.deepEqual(kubernetes.edges.map(edge => edge.relation), ['selects', 'owns']);
  assert.equal(kubernetes.events[0]?.reason, 'Unhealthy');
  assert.equal(kubernetes.events[0]?.provenance.toolCallId, 'call-events');
  assert.equal(kubernetes.events[0]?.provenance.spanId, 'ed7c7498-cdb5-4ac0-9cf5-9ecbe6601a4e');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /do-not-store/);
  assert.doesNotMatch(serialized, /raw-provider-detail-do-not-store/);
  assert.match(serialized, /\[REDACTED\]/);
});

test('fails closed before review when the researcher has no scoped provider evidence', async () => {
  const store = new InMemoryTaskStore();
  const task: A2aTask = {
    id: '58b965a2-7888-4bd2-999b-132571107d83', contextId: '58b965a2-7888-4bd2-999b-132571107d84',
    status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: 'plan', name: 'plan', parts: [{ data: plan as unknown as Record<string, unknown> }] }],
  };
  await store.save(task);
  const invoked: string[] = [];
  const core: CoreAgentInvoker = {
    async callAgent(input): Promise<CoreAgentResponse> {
      invoked.push(input.agentName);
      return {
        response: 'I inspected a local source tree instead of telemetry.',
        sessionId: `${input.agentName}-session`, iterations: 1,
        toolCalls: input.agentName === 'researcher' ? [{ name: 'workspace_read', args: { path: '/workspace/app.ts' } }] : [],
        agent: { id: grant.claims.coreAgents.find(agent => agent.name === CORE_AGENT_NAME_BY_ROLE[input.agentName as keyof typeof CORE_AGENT_NAME_BY_ROLE])!.id, name: input.agentName, label: input.agentName, model: 'test-model' },
      };
    },
  };

  await new InvestigationRunner(store, core).run({ taskId: task.id, plan, grant });

  const failed = await store.get(task.id);
  assert.equal(failed?.status.state, 'TASK_STATE_FAILED');
  assert.deepEqual(invoked.sort(), ['knowledge', 'researcher']);
  const result = failed?.artifacts?.at(-1)?.parts[0]?.data;
  assert.equal(result?.['quality'], 'failed');
  assert.match(String(result?.['synthesis']), /did not collect scoped provider evidence/i);
  assert.match(JSON.stringify(result), /workspace_read/);
});

test('runs one bounded evidence-gap pass when the first researcher turn skips mandatory signals', async () => {
  const store = new InMemoryTaskStore();
  const task: A2aTask = {
    id: '68b965a2-7888-4bd2-999b-132571107d83', contextId: '68b965a2-7888-4bd2-999b-132571107d84',
    status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: 'plan', name: 'plan', parts: [{ data: plan as unknown as Record<string, unknown> }] }],
  };
  await store.save(task);
  let researcherCalls = 0;
  const core: CoreAgentInvoker = {
    async callAgent(input): Promise<CoreAgentResponse> {
      const role = input.agentName;
      if (role === 'researcher') researcherCalls++;
      const toolCalls = role !== 'researcher' ? [] : researcherCalls === 1
        ? [{
            name: 'aiops_kubernetes_k8s_get_resources',
            args: { resource_type: 'deployments', namespace: 'production', output: 'json' },
            result: kubernetesList([{
              kind: 'Deployment',
              metadata: { name: 'checkout', namespace: 'production', labels: { 'app.kubernetes.io/name': 'checkout' } },
              spec: { replicas: 2, selector: { matchLabels: { 'app.kubernetes.io/name': 'checkout' } } },
              status: { replicas: 2, readyReplicas: 1 },
            }]),
          }]
        : [
            { name: 'aiops_prometheus_query', args: { query: 'up' } },
            { name: 'aiops_loki_query_range', args: { query: '{service="checkout"}' } },
            { name: 'aiops_jaeger_find_traces', args: { service: 'checkout' } },
          ];
      return {
        response: role === 'reviewer' ? reviewerResult() : `${role} evidence`, sessionId: `${role}-${researcherCalls}`, iterations: 1, toolCalls,
        ragCitations: role === 'knowledge' ? [{ source: 'runbook.md', index: 'runbooks', score: 0.9 }] : [],
        agent: {
          id: grant.claims.coreAgents.find(agent => agent.name === CORE_AGENT_NAME_BY_ROLE[role as keyof typeof CORE_AGENT_NAME_BY_ROLE])!.id,
          name: role, label: role, model: 'test-model',
        },
      };
    },
  };

  await new InvestigationRunner(store, core).run({ taskId: task.id, plan, grant });

  const completed = await store.get(task.id);
  assert.equal(completed?.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(researcherCalls, 2);
  const result = completed?.artifacts?.at(-1)?.parts[0]?.data;
  assert.deepEqual(
    (result?.['signalCoverage'] as Array<{ lane: string; status: string }>)
      .filter(item => ['metrics', 'logs', 'traces'].includes(item.lane))
      .map(item => item.status),
    ['collected', 'collected', 'collected'],
  );
});

test('runs an evidence-gap pass for every configured provider recipe in one lane', async () => {
  const store = new InMemoryTaskStore();
  const recipePlan = {
    ...plan,
    evidenceLanes: plan.evidenceLanes.map(lane => lane.id === 'logs' ? {
      ...lane,
      queryTemplates: [
        { id: 'checkout-loki', toolName: 'aiops_loki_query_range', template: '{service="checkout"}' },
        { id: 'checkout-opensearch', toolName: 'opensearch_prod_search', template: '{"index":"logs"}' },
      ],
    } : lane),
  } as typeof plan;
  const task: A2aTask = {
    id: '69b965a2-7888-4bd2-999b-132571107d83', contextId: '69b965a2-7888-4bd2-999b-132571107d84',
    status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: 'plan', name: 'plan', parts: [{ data: recipePlan as unknown as Record<string, unknown> }] }],
  };
  await store.save(task);
  let researcherCalls = 0;
  let gapPrompt = '';
  const core: CoreAgentInvoker = {
    async callAgent(input): Promise<CoreAgentResponse> {
      if (input.agentName === 'researcher') {
        researcherCalls++;
        if (researcherCalls === 2) gapPrompt = input.message;
      }
      const toolCalls = input.agentName !== 'researcher' ? [] : researcherCalls === 1
        ? [
            { name: 'aiops_prometheus_query', args: { query: 'up' } },
            { name: 'aiops_loki_query_range', args: { query: '{service="checkout"}' } },
            { name: 'aiops_jaeger_find_traces', args: { service: 'checkout' } },
            {
              name: 'aiops_kubernetes_k8s_get_resources',
              args: { resource_type: 'deployments', namespace: 'production', output: 'json' },
              result: kubernetesList([{
                kind: 'Deployment',
                metadata: { name: 'checkout', namespace: 'production', labels: { 'app.kubernetes.io/name': 'checkout' } },
                spec: { replicas: 2, selector: { matchLabels: { 'app.kubernetes.io/name': 'checkout' } } },
                status: { replicas: 2, readyReplicas: 2 },
              }]),
            },
          ]
        : [{ name: 'opensearch_prod_search', args: { index: 'logs', query_json: '{}' } }];
      return {
        response: input.agentName === 'reviewer' ? reviewerResult() : `${input.agentName} evidence`,
        sessionId: `${input.agentName}-${researcherCalls}`, iterations: 1, toolCalls,
        ragCitations: input.agentName === 'knowledge' ? [{ source: 'runbook.md', index: 'runbooks', score: 0.9 }] : [],
        agent: {
          id: grant.claims.coreAgents.find(agent => agent.name === CORE_AGENT_NAME_BY_ROLE[input.agentName as keyof typeof CORE_AGENT_NAME_BY_ROLE])!.id,
          name: input.agentName, label: input.agentName, model: 'test-model',
        },
      };
    },
  };

  await new InvestigationRunner(store, core).run({ taskId: task.id, plan: recipePlan, grant });

  assert.equal(researcherCalls, 2);
  assert.match(gapPrompt, /opensearch_prod_search/);
  assert.equal((await store.get(task.id))?.status.state, 'TASK_STATE_COMPLETED');
});

test('fails closed before review when a Kubernetes-scoped investigation never obtains Kubernetes evidence', async () => {
  const store = new InMemoryTaskStore();
  const task: A2aTask = {
    id: '78b965a2-7888-4bd2-999b-132571107d83', contextId: '78b965a2-7888-4bd2-999b-132571107d84',
    status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: 'plan', name: 'plan', parts: [{ data: plan as unknown as Record<string, unknown> }] }],
  };
  await store.save(task);
  const invoked: string[] = [];
  const core: CoreAgentInvoker = {
    async callAgent(input): Promise<CoreAgentResponse> {
      invoked.push(input.agentName);
      return {
        response: `${input.agentName} evidence`,
        sessionId: `${input.agentName}-session`, iterations: 1,
        toolCalls: input.agentName === 'researcher'
          ? [
              { name: 'aiops_prometheus_query', args: { query: 'up' } },
              { name: 'aiops_loki_query_range', args: { query: '{service="checkout"}' } },
              { name: 'aiops_jaeger_find_traces', args: { service: 'checkout' } },
            ]
          : [],
        ragCitations: input.agentName === 'knowledge' ? [{ source: 'runbook.md', index: 'runbooks', score: 0.9 }] : [],
        agent: {
          id: grant.claims.coreAgents.find(agent => agent.name === CORE_AGENT_NAME_BY_ROLE[input.agentName as keyof typeof CORE_AGENT_NAME_BY_ROLE])!.id,
          name: input.agentName, label: input.agentName, model: 'test-model',
        },
      };
    },
  };

  await new InvestigationRunner(store, core).run({ taskId: task.id, plan, grant });

  const failed = await store.get(task.id);
  assert.equal(failed?.status.state, 'TASK_STATE_FAILED');
  assert.equal(invoked.filter(role => role === 'researcher').length, 2);
  assert.equal(invoked.includes('reviewer'), false);
  assert.match(String(failed?.artifacts?.at(-1)?.parts[0]?.data['synthesis']), /Kubernetes resource evidence/i);
});
