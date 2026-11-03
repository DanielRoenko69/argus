import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { createArgusAiopsServer } from './server.js';
import { InMemoryTaskStore } from './taskStore.js';
import { hashResolvedServiceContext } from './domain.js';

const A2A_HEADERS = {
  'a2a-version': '1.0',
  'content-type': 'application/a2a+json',
};

function grant(input: { messageId: string; rootTraceId: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    jti: '48b965a2-7888-4bd2-999b-132571107d82',
    iss: 'argus.core',
    aud: 'argus.aiops',
    agent: 'incident-orchestrator',
    principalKind: 'user',
    principalId: '1',
    bundleIds: [4, 9],
    coreAgentIds: [1, 2, 3],
    coreAgents: [
      { name: 'aiops-researcher', id: 1 },
      { name: 'aiops-knowledge', id: 2 },
      { name: 'aiops-reviewer', id: 3 },
    ],
    messageId: input.messageId,
    rootTraceId: input.rootTraceId,
    resourceScope: {
      kind: 'kubernetes', backendId: 7, targetId: 'test-cluster',
      cluster: 'test', namespace: 'production', environment: 'test',
    },
    iat: now,
    exp: now + 900,
  };
  return `eg_v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature`;
}

function resolvedServiceContext() {
  return {
    schemaVersion: 1 as const,
    kind: 'aiops-resolved-service-context' as const,
    profile: { id: 41, revision: 3, sha256: 'a'.repeat(64) },
    service: { displayName: 'Checkout API', serviceName: 'checkout-api', environment: 'production' },
    ownership: { team: 'payments', criticality: 'high' as const },
    evidence: {
      minimumCollectedLanes: 1,
      correlationWindowMinutes: 30,
      maxProviderResultBytes: 65536,
      lanes: [{
        lane: 'logs' as const,
        requirement: 'required' as const,
        bundleId: 9,
        toolNames: ['aiops_loki_query_range'],
        queryTemplates: [{
          id: 'checkout-errors', toolName: 'aiops_loki_query_range', source: { kind: 'loki' as const },
          template: '{"query":"{service_name=\\"${service.name}\\"} |= \\"${signal.keyword}\\"","start":"${window.start}","end":"${window.end}"}',
        }],
      }],
    },
    selectors: { otelServiceNames: ['checkout-api'], metricLabels: {}, logLabels: { service_name: 'checkout-api' }, traceOperations: [] },
    context: { knowledgeSourceIds: [], runbookRefs: [], dependencyOverrides: [] },
    remediationPolicy: {
      mode: 'diagnose-only' as const, allowedAdapterKeys: [], maxRiskWithoutApproval: 'none' as const,
      requireApprovalInProduction: true as const, requireVerification: true as const, requireRollbackPlan: true as const,
    },
    resolvedAt: '2026-09-08T14:00:00.000Z',
  };
}

function profileGrant(input: { messageId: string; rootTraceId: string }, context = resolvedServiceContext()): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1, jti: '58b965a2-7888-4bd2-999b-132571107d83', iss: 'argus.core', aud: 'argus.aiops',
    agent: 'incident-orchestrator', principalKind: 'user', principalId: '1', bundleIds: [9],
    toolNames: ['aiops_loki_query_range'], coreAgentIds: [1, 2, 3],
    coreAgents: [{ name: 'researcher', id: 1 }, { name: 'knowledge', id: 2 }, { name: 'reviewer', id: 3 }],
    messageId: input.messageId, rootTraceId: input.rootTraceId,
    aiopsServiceContext: {
      profileId: context.profile.id, revision: context.profile.revision, profileSha256: context.profile.sha256,
      resolvedContextSha256: hashResolvedServiceContext(context),
    },
    iat: now, exp: now + 900,
  };
  return `eg_v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature`;
}

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const store = new InMemoryTaskStore();
  await store.setup();
  const server = createArgusAiopsServer({ store, publicUrl: 'http://127.0.0.1:2030' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('serves a discoverable Pack manifest and A2A workflow catalog', async () => {
  await withServer(async baseUrl => {
    const manifest = await fetch(`${baseUrl}/.well-known/argus-solution-pack.yaml`).then(response => response.json());
    assert.equal(manifest.metadata.id, 'argus.aiops');
    assert.equal(manifest.spec.components.workflows[0], 'incident-investigation');

    const card = await fetch(`${baseUrl}/.well-known/agent-card.json`).then(response => response.json());
    assert.equal(card.capabilities.aiopsServiceContextVersion, 1);
    const workflow = card.skills.find((skill: { id: string }) => skill.id === 'incident-investigation');
    assert.deepEqual(workflow['x-argus-workflow'].requiredBundleCategories, ['metrics', 'runtime']);
    assert.deepEqual(workflow['x-argus-workflow'].requiredExecutionTargetKinds, ['kubernetes']);
  });
});

test('persists a Core-bound read-only investigation plan through A2A', async () => {
  await withServer(async baseUrl => {
    const messageId = 'message-1';
    const rootTraceId = 'ad7c7498-cdb5-4ac0-9cf5-9ecbe6601a4a';
    const response = await fetch(`${baseUrl}/message:send`, {
      method: 'POST',
      headers: {
        ...A2A_HEADERS,
        'x-argus-root-trace-id': rootTraceId,
        'x-argus-execution-grant': grant({ messageId, rootTraceId }),
      },
      body: JSON.stringify({
        message: {
          messageId,
          role: 'ROLE_USER',
          parts: [{ data: {
            operation: 'workflow.start',
            workflowId: 'incident-investigation',
            input: {
              title: 'Checkout latency',
              summary: 'P95 latency increased after deployment.',
              severity: 'critical',
              service: 'checkout',
              environment: 'test',
              correlation_window_minutes: 30,
            },
          } }],
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.task.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(body.task.artifacts[0].parts[0].data.kind, 'aiops-investigation-plan');
    assert.deepEqual(body.task.artifacts[0].parts[0].data.scope.selectedBundleIds, [4, 9]);

    const stored = await fetch(`${baseUrl}/tasks/${body.task.id}`).then(result => result.json());
    assert.equal(stored.id, body.task.id);
    assert.equal(stored.metadata.rootTraceId, rootTraceId);

    const catalog = await fetch(`${baseUrl}/tasks?limit=1`).then(result => result.json());
    assert.equal(catalog.tasks.length, 1);
    assert.equal(catalog.tasks[0].task.id, body.task.id);
    assert.equal(typeof catalog.tasks[0].createdAt, 'string');
    assert.equal(typeof catalog.tasks[0].updatedAt, 'string');
    assert.equal(catalog.nextCursor, null);
  });
});

test('paginates the persisted task catalog with an opaque bounded cursor', async () => {
  await withServer(async baseUrl => {
    for (const [suffix, rootTraceId] of [
      ['1', 'ad7c7498-cdb5-4ac0-9cf5-9ecbe6601a4a'],
      ['2', 'bd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4b'],
    ]) {
      const messageId = `investigation-${suffix}`;
      const response = await fetch(`${baseUrl}/message:send`, {
        method: 'POST',
        headers: {
          ...A2A_HEADERS,
          'x-argus-root-trace-id': rootTraceId,
          'x-argus-execution-grant': grant({ messageId, rootTraceId }),
        },
        body: JSON.stringify({
          message: {
            messageId,
            role: 'ROLE_USER',
            parts: [{ data: {
              operation: 'workflow.start',
              workflowId: 'incident-investigation',
              input: {
                title: `Incident ${suffix}`,
                summary: 'Persisted investigation for pagination.',
                severity: 'warning',
                service: 'checkout',
                environment: 'test',
                correlation_window_minutes: 30,
              },
            } }],
          },
        }),
      });
      assert.equal(response.status, 200);
    }

    const firstResponse = await fetch(`${baseUrl}/tasks?limit=1`);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.tasks.length, 1);
    assert.equal(typeof first.nextCursor, 'string');

    const second = await fetch(`${baseUrl}/tasks?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`).then(result => result.json());
    assert.equal(second.tasks.length, 1);
    assert.notEqual(second.tasks[0].task.id, first.tasks[0].task.id);
    assert.equal(second.nextCursor, null);

    const invalid = await fetch(`${baseUrl}/tasks?limit=51`);
    assert.equal(invalid.status, 400);
  });
});

test('accepts an exact profile-backed context and rejects context tampering', async () => {
  await withServer(async baseUrl => {
    const messageId = 'profile-message-1';
    const rootTraceId = 'ed7c7498-cdb5-4ac0-9cf5-9ecbe6601a4e';
    const context = resolvedServiceContext();
    const body = (serviceContext: unknown) => ({ message: {
      messageId,
      role: 'ROLE_USER',
      parts: [{ data: {
        operation: 'workflow.start', workflowId: 'incident-investigation',
        input: {
          title: 'Checkout errors', summary: 'Deadline exceeded increased.', severity: 'critical',
          service: 'checkout-api', environment: 'production', correlation_window_minutes: 30,
          signal_keyword: 'deadline exceeded',
        },
        resolvedServiceContext: serviceContext,
      } }],
    } });
    const headers = {
      ...A2A_HEADERS,
      'x-argus-root-trace-id': rootTraceId,
      'x-argus-execution-grant': profileGrant({ messageId, rootTraceId }, context),
    };
    const accepted = await fetch(`${baseUrl}/message:send`, { method: 'POST', headers, body: JSON.stringify(body(context)) });
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json();
    assert.deepEqual(acceptedBody.task.artifacts[0].parts[0].data.evidenceLanes.map((lane: { id: string }) => lane.id), ['logs']);
    assert.equal(acceptedBody.task.metadata.serviceProfile.profileId, 41);

    const tampered = structuredClone(context);
    tampered.service.environment = 'staging';
    const rejected = await fetch(`${baseUrl}/message:send`, { method: 'POST', headers, body: JSON.stringify(body(tampered)) });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, 'SERVICE_CONTEXT_SCOPE_MISMATCH');
  });
});

test('rejects an environment outside the Core-signed execution target', async () => {
  await withServer(async baseUrl => {
    const messageId = 'environment-mismatch';
    const rootTraceId = 'cd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4c';
    const response = await fetch(`${baseUrl}/message:send`, {
      method: 'POST',
      headers: {
        ...A2A_HEADERS,
        'x-argus-root-trace-id': rootTraceId,
        'x-argus-execution-grant': grant({ messageId, rootTraceId }),
      },
      body: JSON.stringify({
        message: {
          messageId,
          role: 'ROLE_USER',
          parts: [{ data: {
            operation: 'workflow.start',
            workflowId: 'incident-investigation',
            input: {
              title: 'Checkout latency', summary: 'Environment mismatch test.', severity: 'warning',
              service: 'checkout', environment: 'production', correlation_window_minutes: 30,
            },
          } }],
        },
      }),
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, 'EXECUTION_TARGET_SCOPE_MISMATCH');
  });
});

test('rejects workflow start without a Core execution grant', async () => {
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/message:send`, {
      method: 'POST',
      headers: A2A_HEADERS,
      body: JSON.stringify({
        message: {
          messageId: 'message-2',
          role: 'ROLE_USER',
          parts: [{ data: { operation: 'workflow.start', workflowId: 'incident-investigation', input: {} } }],
        },
      }),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'EXECUTION_GRANT_REQUIRED');
  });
});
