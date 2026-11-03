import { describe, expect, it, jest } from '@jest/globals';
import { A2aClientError, A2aHttpJsonClient, codingWorkspaceRoot } from '../client.js';
import { SOLUTION_PACK_MANIFEST_PATH, SolutionPackRegistry } from '../../solutionPacks/discovery.js';
import { ExecutionGrantError } from '../../solutionPacks/executionGrant.js';

function manifest(): string {
  return JSON.stringify({
    apiVersion: 'argus.eu/v1alpha1',
    kind: 'SolutionPack',
    metadata: { id: 'argus.dev', version: '0.1.0', displayName: 'Argus Dev' },
    spec: {
      delivery: { type: 'container', protocol: 'argus-pack-v1alpha1' },
      requires: { core: '>=1.0.0' },
      components: {
        agents: [{
          id: 'coding-orchestrator',
          runtime: 'a2a',
          skills: ['coding-preflight'],
          bundles: ['dev-workspace'],
          credentials: [],
          coreAgents: ['planner', 'knowledge', 'coder', 'reviewer', 'researcher'],
          a2aAgentCardPath: '/.well-known/agent-card.json',
        }],
        skills: ['coding-preflight'],
        bundles: ['dev-workspace'],
      },
      readiness: { smokeTests: ['pack-health'] },
    },
  });
}

describe('codingWorkspaceRoot', () => {
  it('isolates a configured retry in a fresh trace-bound workspace without changing its ticket ID', () => {
    const attempt = 'a41d3d4c-e496-4e51-bb5b-40cd08cfb33f';
    const input = { data: { operation: 'workflow.start', workflowId: 'backlog-grooming', input: { backlog_id: 'GEM-182' }, retry: { sourceThreadId: 'old' } } };
    expect(codingWorkspaceRoot(input, attempt)).toBe(`/workspace/GEM-182-retry-${attempt}`);
    expect(codingWorkspaceRoot(input, '../../escape')).toBe('/workspace/GEM-182');
  });
  it.each([
    ['DEMO-GEM-182-PLAN-01', 'DEMO-GEM-182-PLAN-01'],
    ['  GEM/182: plan_02  ', 'GEM-182-plan-02'],
    ['../../outside', 'outside'],
    ['---', 'untitled'],
  ])('binds Backlog Planning to the same sanitized backlog ID as the Pack: %s', (backlogId, directory) => {
    expect(codingWorkspaceRoot({ data: {
      operation: 'workflow.start',
      workflowId: 'backlog-grooming',
      input: { backlog_id: backlogId, ticket_id: 'must-not-override-backlog' },
    } })).toBe(`/workspace/${directory}`);
  });

  it.each([undefined, '', '   ', 182, {}, []])('does not invent a backlog workspace for invalid ID %p', backlogId => {
    expect(codingWorkspaceRoot({ data: {
      operation: 'workflow.start',
      workflowId: 'backlog-grooming',
      input: { backlog_id: backlogId, ticket_id: 'must-not-be-a-fallback' },
    } })).toBeUndefined();
  });

  it.each(['coding.start', 'workflow.start'])('preserves ticket workspace binding for %s', operation => {
    expect(codingWorkspaceRoot({ data: {
      operation,
      workflowId: 'ticket-to-pull-request',
      input: { ticket_id: 'ARGUS-42', backlog_id: 'must-not-override-ticket' },
    } })).toBe('/workspace/ARGUS-42');
  });

  it.each([
    ['workflow.preflight', 'backlog-grooming'],
    ['workflow.start', 'unrelated-workflow'],
    ['coding.start', 'backlog-grooming'],
  ])('does not infer backlog authority for %s / %s', (operation, workflowId) => {
    expect(codingWorkspaceRoot({ data: {
      operation, workflowId, input: { backlog_id: 'ARGUS-EPIC-123' },
    } })).toBeUndefined();
  });

  it('binds visual Agent chains to the fixed prototype workspace boundary', () => {
    expect(codingWorkspaceRoot({ data: {
      operation: 'workflow.start',
      workflowId: 'visual-147-governed-agent-delivery-prototype',
      input: { task: 'Validate the Agent chain' },
    } })).toBe('/workspace/visual-147-governed-agent-delivery-prototype');
  });
});

function agentCard() {
  return {
    name: 'Argus Dev Coding Orchestrator',
    description: 'Coding preflight',
    supportedInterfaces: [{
      // Core requires this declaration to match the operator-configured Pack
      // endpoint and never follows an Agent Card to a different origin.
      url: 'http://argus-dev:2025',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: '1.0',
    }],
    version: '0.1.0',
    capabilities: { streaming: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      { id: 'coding-preflight', name: 'Coding preflight' },
      {
        id: 'ticket-to-pull-request',
        name: 'Ticket to pull request',
        'x-argus-workflow': {
          id: 'ticket-to-pull-request',
          requiredAgents: ['planner', 'coder', 'reviewer'],
          stages: [{ id: 'implement', kind: 'code' }],
        },
      },
      {
        id: 'backlog-grooming',
        name: 'Backlog Planning',
        'x-argus-workflow': {
          id: 'backlog-grooming',
          requiredAgents: ['researcher', 'planner', 'reviewer'],
          stages: [{ id: 'research_backlog', kind: 'knowledge' }],
        },
      },
    ],
  };
}

async function readyRegistry(): Promise<SolutionPackRegistry> {
  const registry = new SolutionPackRegistry(
    [{ packId: 'argus.dev', endpoint: 'http://argus-dev:2025', tokenFile: '/run/secrets/dev-token' }],
    {
      coreVersion: '1.0.0',
      readTokenFile: async () => 'service-token',
      fetchFn: async input => String(input).endsWith(SOLUTION_PACK_MANIFEST_PATH)
        ? new Response(manifest(), { status: 200 })
        : new Response('', { status: 200 }),
    },
  );
  await registry.refresh();
  return registry;
}

describe('A2A HTTP+JSON v1 client', () => {
  it.each(['workflow.preflight', 'workflow.start'])('rejects repository conflicts before grant issuance or Pack dispatch: %s', async operation => {
    const registry = await readyRegistry();
    const issue = jest.fn<() => Promise<string>>();
    const check = jest.fn<(ids: number[], repository?: string) => Promise<void>>().mockRejectedValue(new ExecutionGrantError(409, 'repository_checkout_conflict', 'Select one repository.'));
    const urls: string[] = [];
    const card = agentCard();
    Object.assign(card.skills[1]!['x-argus-workflow']!, { requiredBundleCategories: ['repository-checkout'] });
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: { issue, assertRepositoryCheckout: check },
      fetchFn: async url => { urls.push(String(url)); return new Response(JSON.stringify(card)); },
    });
    const request = { data: { operation, workflowId: 'ticket-to-pull-request', input: { repository: 'demo-demo/gem-demo-work' } } };
    await expect(client.sendMessage('argus.dev', 'coding-orchestrator', request, {
      principalKind: 'user', principalId: '7', principalAllowedBundleIds: [5, 47], requestedBundleIds: [5, 47],
    })).rejects.toMatchObject({ code: 'repository_checkout_conflict', status: 409 });
    expect(check).toHaveBeenCalledWith([5, 47], 'demo-demo/gem-demo-work');
    expect(issue).not.toHaveBeenCalled();
    expect(urls.every(url => url.endsWith('/.well-known/agent-card.json'))).toBe(true);
    check.mockClear();
    await expect(client.sendMessage('argus.dev', 'coding-orchestrator', request, {
      principalKind: 'user', principalId: '7', principalAllowedBundleIds: [47], requestedBundleIds: [5, 47],
    })).rejects.toMatchObject({ code: 'bundle_scope_denied', status: 403 });
    expect(check).not.toHaveBeenCalled();
  });

  it('validates the Agent Card and sends an authenticated, trace-correlated task through the configured endpoint', async () => {
    const registry = await readyRegistry();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/.well-known/agent-card.json')) {
          return new Response(JSON.stringify(agentCard()), { status: 200 });
        }
        const sent = JSON.parse(String(init?.body)) as {
          message: { messageId: string; metadata: { argusRootTraceId: string } };
        };
        return new Response(JSON.stringify({
          task: {
            id: 'c295ea44-7543-4f78-b524-7a38915ad6e4',
            contextId: '43667960-d455-4453-b0cf-1bae4955270d',
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [{ artifactId: 'artifact-1', parts: [{ data: { ready: true } }] }],
            metadata: { argusRootTraceId: sent.message.metadata.argusRootTraceId },
          },
        }), { status: 200 });
      },
    });

    const result = await client.sendMessage('argus.dev', 'coding-orchestrator', {
      text: 'Check the coding workflow.',
      data: { operation: 'coding.preflight' },
    });

    expect(result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(result.task.metadata?.['argusRootTraceId']).toBe(result.rootTraceId);
    expect(calls.map(call => call.url)).toEqual([
      'http://argus-dev:2025/.well-known/agent-card.json',
      'http://argus-dev:2025/message:send',
    ]);
    const headers = calls[1]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer service-token');
    expect(headers['a2a-version']).toBe('1.0');
    expect(headers['content-type']).toBe('application/a2a+json');
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('fails closed for undiscovered packs and malformed v1 Agent Cards', async () => {
    const unchecked = new SolutionPackRegistry(
      [{ packId: 'argus.dev', endpoint: 'http://argus-dev:2025' }],
      { coreVersion: '1.0.0' },
    );
    await expect(new A2aHttpJsonClient(unchecked).sendMessage('argus.dev', 'coding-orchestrator', { text: 'hello' }))
      .rejects.toMatchObject({ status: 409, code: 'pack_not_ready' });

    const ready = await readyRegistry();
    const invalid = new A2aHttpJsonClient(ready, {
      readTokenFile: async () => 'service-token',
      fetchFn: async () => new Response(JSON.stringify({ name: 'missing interfaces' }), { status: 200 }),
    });
    await expect(invalid.sendMessage('argus.dev', 'coding-orchestrator', { text: 'hello' }))
      .rejects.toBeInstanceOf(A2aClientError);
    await expect(invalid.sendMessage('argus.dev', 'coding-orchestrator', { text: 'hello' }))
      .rejects.toMatchObject({ status: 502, code: 'invalid_agent_card' });
  });

  it.each([
    { workflowId: 'ticket-to-pull-request', input: { ticket_id: 'ARGUS-42', description: 'Implement it.' }, workspaceRoot: '/workspace/ARGUS-42' },
    { workflowId: 'backlog-grooming', input: { backlog_id: 'DEMO-GEM-182-PLAN-01', issue_body: 'Plan it.' }, workspaceRoot: '/workspace/DEMO-GEM-182-PLAN-01' },
  ])('attaches a workspace-bound grant to $workflowId without putting it in the message body', async ({ workflowId, input, workspaceRoot }) => {
    const registry = await readyRegistry();
    const issued: unknown[] = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: {
        async issue(input) {
          issued.push(input);
          return 'eg_v1.payload.signature';
        },
      },
      fetchFn: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/.well-known/agent-card.json')) {
          return new Response(JSON.stringify(agentCard()), { status: 200 });
        }
        const sent = JSON.parse(String(init?.body)) as { message: { metadata: { argusRootTraceId: string } } };
        return new Response(JSON.stringify({
          task: {
            id: 'c295ea44-7543-4f78-b524-7a38915ad6e4',
            contextId: '43667960-d455-4453-b0cf-1bae4955270d',
            status: { state: 'TASK_STATE_WORKING' },
            metadata: { argusRootTraceId: sent.message.metadata.argusRootTraceId },
          },
        }), { status: 200 });
      },
    });

    await client.sendMessage('argus.dev', 'coding-orchestrator', {
      data: {
        operation: 'workflow.start',
        workflowId,
        input,
      },
    }, {
      principalKind: 'user',
      principalId: '7',
      principalAllowedBundleIds: [11],
      requestedBundleIds: [11],
      runtimeMode: 'managed-hermes',
    });

    expect(issued[0]).toMatchObject({
      packId: 'argus.dev',
      agentId: 'coding-orchestrator',
      principalId: '7',
      requestedBundleIds: [11],
      coreAgentNames: ['planner', 'knowledge', 'coder', 'reviewer', 'researcher'],
      workspaceRoot,
      runtimeMode: 'managed-hermes',
    });
    const request = calls[1]!.init!;
    expect((request.headers as Record<string, string>)['x-argus-execution-grant']).toBe('eg_v1.payload.signature');
    expect(String(request.body)).not.toContain('eg_v1.payload.signature');
  });

  it('blocks a workflow before grant issuance when the selected bundles lack its MCP categories', async () => {
    const registry = await readyRegistry();
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: {
        async checkBundleCapabilities() {
          return {
            ok: false,
            required: ['repository', 'ci'],
            provided: ['repository'],
            missing: ['ci'],
            operationalBlockers: [],
            bundles: [],
          };
        },
        async issue() {
          throw new Error('grant must not be issued');
        },
      },
      fetchFn: async (input) => {
        if (String(input).endsWith('/.well-known/agent-card.json')) {
          return new Response(JSON.stringify({
            ...agentCard(),
            skills: [{ id: 'ticket-to-pull-request', name: 'Ticket to pull request', 'x-argus-workflow': { requiredBundleCategories: ['repository', 'ci'] } }],
          }), { status: 200 });
        }
        throw new Error('workflow request should not be sent');
      },
    });

    await expect(client.sendMessage('argus.dev', 'coding-orchestrator', {
      data: {
        operation: 'workflow.start',
        workflowId: 'ticket-to-pull-request',
        input: { ticket_id: 'ARGUS-42', description: 'Implement it.' },
      },
    }, {
      principalKind: 'user',
      principalId: '7',
      principalAllowedBundleIds: [11],
      requestedBundleIds: [11],
    })).rejects.toMatchObject({ status: 409, code: 'bundle_capabilities_missing' });
  });

  it('requires and forwards a Core-selected runtime target declared by the workflow', async () => {
    const registry = await readyRegistry();
    const issued: unknown[] = [];
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: {
        async issue(input) { issued.push(input); return 'eg_v1.payload.signature'; },
      },
      fetchFn: async (input, init) => {
        if (String(input).endsWith('/.well-known/agent-card.json')) {
          return new Response(JSON.stringify({
            ...agentCard(),
            skills: [{ id: 'incident-investigation', name: 'Incident investigation', 'x-argus-workflow': {
              requiredExecutionTargetKinds: ['kubernetes'],
            } }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          task: { id: 'task-1', contextId: 'context-1', status: { state: 'TASK_STATE_WORKING' } },
        }), { status: 200 });
      },
    });
    const message = {
      data: { operation: 'workflow.start', workflowId: 'incident-investigation', input: { environment: 'argus-demo' } },
    };
    const execution = {
      principalKind: 'user' as const,
      principalId: '7',
      principalAllowedBundleIds: [8],
      requestedBundleIds: [8],
    };
    await expect(client.sendMessage('argus.dev', 'coding-orchestrator', message, execution))
      .rejects.toMatchObject({ status: 409, code: 'execution_target_required' });

    await client.sendMessage('argus.dev', 'coding-orchestrator', message, {
      ...execution,
      requestedResourceScope: {
        kind: 'kubernetes', backendId: 17, targetId: 'argus-aiops-kind', namespace: 'argus-demo',
      },
    });
    expect(issued.at(-1)).toMatchObject({ requestedResourceScope: {
      kind: 'kubernetes', backendId: 17, targetId: 'argus-aiops-kind', namespace: 'argus-demo',
    } });
  });

  it('attaches Core-owned bundle capability evidence to a selected workflow preflight', async () => {
    const registry = await readyRegistry();
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: {
        async checkBundleCapabilities(bundleIds, required) {
          expect(bundleIds).toEqual([11]);
          expect(required).toEqual(['repository', 'ci']);
          return {
            ok: true,
            required,
            provided: ['repository', 'ci'],
            missing: [],
            operationalBlockers: [],
            bundles: [{ bundleId: 11, bundleName: 'dev-workspace', categories: ['repository', 'ci'], signals: ['gitea'] }],
          };
        },
        async issue() { throw new Error('preflight must not issue a workflow grant'); },
      },
      fetchFn: async input => {
        if (String(input).endsWith('/.well-known/agent-card.json')) {
          return new Response(JSON.stringify({
            ...agentCard(),
            skills: [{ id: 'ticket-to-pull-request', name: 'Ticket to pull request', 'x-argus-workflow': { requiredBundleCategories: ['repository', 'ci'] } }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          task: {
            id: 'preflight-task',
            contextId: '43667960-d455-4453-b0cf-1bae4955270d',
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [{ artifactId: 'pack-evidence', parts: [{ data: { engine: 'langgraph' } }] }],
          },
        }), { status: 200 });
      },
    });

    const result = await client.sendMessage('argus.dev', 'coding-orchestrator', {
      data: { operation: 'workflow.preflight', workflowId: 'ticket-to-pull-request' },
    }, {
      principalKind: 'user',
      principalId: '7',
      principalAllowedBundleIds: [11],
      requestedBundleIds: [11],
    });

    const capabilityArtifact = result.task.artifacts?.find(artifact => artifact.name === 'Argus Core bundle capability preflight');
    expect(capabilityArtifact?.parts[0]).toMatchObject({ data: {
      source: 'argus.core',
      kind: 'bundle-capability-preflight',
      ok: true,
      selectedBundleIds: [11],
      missing: [],
    } });
  });

  it('resolves Auto server-side and returns its deterministic routing evidence', async () => {
    const registry = await readyRegistry();
    const issued: unknown[] = [];
    const asserted: unknown[] = [];
    let sentBody: Record<string, unknown> | undefined;
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: {
        async assertRuntimeSelection(packId, bundleIds, mode) {
          asserted.push({ packId, bundleIds, mode });
        },
        async issue(input) {
          issued.push(input);
          return 'eg_v1.payload.signature';
        },
      },
      fetchFn: async (input, init) => {
        if (String(input).endsWith('/.well-known/agent-card.json')) {
          return new Response(JSON.stringify(agentCard()), { status: 200 });
        }
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          task: {
            id: 'auto-task-1', contextId: 'auto-context-1',
            status: { state: 'TASK_STATE_WORKING' }, metadata: {},
          },
        }), { status: 200 });
      },
    });

    const result = await client.sendMessage('argus.dev', 'coding-orchestrator', {
      data: {
        operation: 'workflow.start', workflowId: 'ticket-to-pull-request',
        input: { ticket_id: 'ARGUS-AUTO-1', description: 'Implement it.' },
      },
    }, {
      principalKind: 'user', principalId: '7', principalAllowedBundleIds: [11],
      requestedBundleIds: [11], runtimeMode: 'auto',
    });

    expect(asserted).toEqual([{ packId: 'argus.dev', bundleIds: [11], mode: 'default' }]);
    expect(issued[0]).toMatchObject({
      runtimeMode: 'default',
      runtimeSelection: {
        requestedMode: 'auto', effectiveMode: 'default',
        reason: 'managed_hermes_unavailable_use_agent_default',
      },
    });
    expect(JSON.stringify(sentBody)).toContain('coreRuntimeSelection');
    expect(result.task.metadata?.['coreRuntimeSelection']).toMatchObject({ requestedMode: 'auto', effectiveMode: 'default' });
    expect(result.task.artifacts?.some(artifact => artifact.name === 'Argus Core runtime selection')).toBe(true);
  });

  it('refreshes stale Hermes discovery before resolving an Auto preflight', async () => {
    let hermesOnline = true;
    const registry = new SolutionPackRegistry([
      { packId: 'argus.dev', endpoint: 'http://argus-dev:2025', tokenFile: '/run/secrets/dev-token' },
      { packId: 'argus.hermes', endpoint: 'http://argus-hermes:2040' },
    ], {
      coreVersion: '1.0.0',
      readTokenFile: async () => 'service-token',
      fetchFn: async input => {
        const url = String(input);
        if (url.startsWith('http://argus-hermes:2040')) {
          if (!hermesOnline) throw new Error('connector offline');
          return url.endsWith(SOLUTION_PACK_MANIFEST_PATH)
            ? new Response(manifest().replace('argus.dev', 'argus.hermes'), { status: 200 })
            : new Response('', { status: 200 });
        }
        return url.endsWith(SOLUTION_PACK_MANIFEST_PATH)
          ? new Response(manifest(), { status: 200 })
          : new Response('', { status: 200 });
      },
    });
    await registry.refresh();
    expect(registry.get('argus.hermes')?.state).toBe('ready');
    hermesOnline = false;

    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: {
        async assertRuntimeSelection(_packId, _bundleIds, mode) {
          expect(mode).toBe('default');
        },
        async issue() { throw new Error('preflight must not issue a workflow grant'); },
      },
      fetchFn: async input => String(input).endsWith('/.well-known/agent-card.json')
        ? new Response(JSON.stringify(agentCard()), { status: 200 })
        : new Response(JSON.stringify({
          task: { id: 'fresh-auto-preflight', contextId: 'fresh-auto-context', status: { state: 'TASK_STATE_COMPLETED' } },
        }), { status: 200 }),
    });
    const result = await client.sendMessage('argus.dev', 'coding-orchestrator', {
      data: { operation: 'workflow.preflight', workflowId: 'ticket-to-pull-request' },
    }, {
      principalKind: 'user', principalId: '7', principalAllowedBundleIds: [11],
      requestedBundleIds: [11], runtimeMode: 'auto',
    });

    expect(registry.get('argus.hermes')?.state).toBe('unreachable');
    expect(result.task.metadata?.['coreRuntimeSelection']).toMatchObject({
      requestedMode: 'auto', effectiveMode: 'default',
      reason: 'managed_hermes_unavailable_use_agent_default',
    });
  });

  it('falls back when Pack discovery is ready but the Managed Hermes mode is not ready', async () => {
    const registry = await readyRegistry();
    jest.spyOn(registry, 'refreshPack').mockResolvedValue({
      configuredId: 'argus.hermes', endpoint: 'http://argus-hermes:2040', state: 'ready',
      checkedAt: '2026-09-02T00:00:00.000Z',
    });
    const managedHermesAvailable = jest.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      managedHermesAvailable,
      executionGrantIssuer: {
        async assertRuntimeSelection(_packId, _bundleIds, mode) { expect(mode).toBe('default'); },
        async issue() { throw new Error('preflight must not issue a workflow grant'); },
      },
      fetchFn: async input => String(input).endsWith('/.well-known/agent-card.json')
        ? new Response(JSON.stringify(agentCard()), { status: 200 })
        : new Response(JSON.stringify({
          task: { id: 'managed-mode-fallback', contextId: 'managed-mode-context', status: { state: 'TASK_STATE_COMPLETED' } },
        }), { status: 200 }),
    });

    const result = await client.sendMessage('argus.dev', 'coding-orchestrator', {
      data: { operation: 'workflow.preflight', workflowId: 'ticket-to-pull-request' },
    }, {
      principalKind: 'user', principalId: '7', principalAllowedBundleIds: [11],
      requestedBundleIds: [11], runtimeMode: 'auto',
    });

    expect(managedHermesAvailable).toHaveBeenCalledTimes(1);
    expect(result.task.metadata?.['coreRuntimeSelection']).toMatchObject({
      effectiveMode: 'default', reason: 'managed_hermes_unavailable_use_agent_default',
    });
  });

  it('blocks a selected workflow preflight before calling the Pack when a Bundle connection is disabled', async () => {
    const registry = await readyRegistry();
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: {
        async checkBundleCapabilities() {
          return {
            ok: false,
            required: ['repository', 'ci'],
            provided: ['repository', 'ci'],
            missing: [],
            operationalBlockers: ["argus-dev-demo: connection 'langgraph_local' is disabled"],
            operationalIssues: [{
              bundleId: 3,
              bundleName: 'argus-dev-demo',
              backendId: 8,
              backendName: 'langgraph_local',
              kind: 'connection_disabled' as const,
              recovery: 'enable_connection' as const,
              message: "argus-dev-demo: connection 'langgraph_local' is disabled",
            }],
            bundles: [],
          };
        },
        async issue() { throw new Error('preflight must not issue a workflow grant'); },
      },
      fetchFn: async input => {
        if (String(input).endsWith('/.well-known/agent-card.json')) {
          return new Response(JSON.stringify({
            ...agentCard(),
            skills: [{ id: 'ticket-to-pull-request', name: 'Ticket to pull request', 'x-argus-workflow': { requiredBundleCategories: ['repository', 'ci'] } }],
          }), { status: 200 });
        }
        throw new Error('workflow preflight must not be sent to the Pack');
      },
    });

    await expect(client.sendMessage('argus.dev', 'coding-orchestrator', {
      data: { operation: 'workflow.preflight', workflowId: 'ticket-to-pull-request' },
    }, {
      principalKind: 'user',
      principalId: '7',
      principalAllowedBundleIds: [3],
      requestedBundleIds: [3],
    })).rejects.toMatchObject({
      status: 409,
      code: 'bundle_connections_not_ready',
      message: expect.stringContaining("connection 'langgraph_local' is disabled"),
      details: {
        missing: [],
        operationalIssues: [expect.objectContaining({ backendId: 8, recovery: 'enable_connection' })],
      },
    });
  });

  it('blocks Managed Hermes preflight before calling the Pack when no approved read-only Bundle is selected', async () => {
    const registry = await readyRegistry();
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: {
        async assertRuntimeSelection(_packId, bundleIds, runtimeMode) {
          expect(bundleIds).toEqual([3]);
          expect(runtimeMode).toBe('managed-hermes');
          throw new ExecutionGrantError(
            409,
            'managed_hermes_read_bundle_required',
            'Managed Hermes requires at least one operator-approved read-only Bundle in the execution scope',
          );
        },
        async issue() { throw new Error('preflight must not issue a workflow grant'); },
      },
      fetchFn: async input => {
        if (String(input).endsWith('/.well-known/agent-card.json')) {
          return new Response(JSON.stringify(agentCard()), { status: 200 });
        }
        throw new Error('workflow preflight must not be sent to the Pack');
      },
    });

    await expect(client.sendMessage('argus.dev', 'coding-orchestrator', {
      data: { operation: 'workflow.preflight', workflowId: 'ticket-to-pull-request' },
    }, {
      principalKind: 'user',
      principalId: '7',
      principalAllowedBundleIds: [3],
      requestedBundleIds: [3],
      runtimeMode: 'managed-hermes',
    })).rejects.toMatchObject({ status: 409, code: 'managed_hermes_read_bundle_required' });
  });

  it('keeps an unscoped workflow preflight ready until bundles are selected', async () => {
    const registry = await readyRegistry();
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: {
        async checkBundleCapabilities() {
          throw new Error('an empty preflight scope must not be checked');
        },
        async issue() { throw new Error('preflight must not issue a workflow grant'); },
      },
      fetchFn: async input => {
        if (String(input).endsWith('/.well-known/agent-card.json')) {
          return new Response(JSON.stringify({
            ...agentCard(),
            skills: [{ id: 'ticket-to-pull-request', name: 'Ticket to pull request', 'x-argus-workflow': { requiredBundleCategories: ['repository', 'ci'] } }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          task: {
            id: 'unscoped-preflight-task',
            contextId: '43667960-d455-4453-b0cf-1bae4955270d',
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [{
              artifactId: 'pack-evidence',
              parts: [{ data: { ready: true, workflowId: 'ticket-to-pull-request' } }],
            }],
          },
        }), { status: 200 });
      },
    });

    const result = await client.sendMessage('argus.dev', 'coding-orchestrator', {
      data: { operation: 'coding.preflight' },
    }, {
      principalKind: 'user',
      principalId: '7',
      principalAllowedBundleIds: null,
      requestedBundleIds: [],
    });

    expect(result.task.artifacts).toHaveLength(2);
    expect(result.task.artifacts?.find(artifact => artifact.artifactId === 'pack-evidence')?.parts[0]).toMatchObject({ data: {
      ready: true,
      workflowId: 'ticket-to-pull-request',
    } });
    expect(result.task.artifacts?.some(artifact => artifact.name === 'Argus Core runtime selection')).toBe(true);
  });

  it('attaches Core-owned connector freshness evidence to an AIOps preflight', async () => {
    const registry = await readyRegistry();
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: {
        async issue() { throw new Error('preflight must not issue a workflow grant'); },
        async checkExecutionTargetReadiness(packId, bundleIds, requestedResourceScope) {
          expect(packId).toBe('argus.dev');
          expect(bundleIds).toEqual([8]);
          expect(requestedResourceScope).toMatchObject({ targetId: 'argus-aiops-kind', namespace: 'argus-demo' });
          return {
            source: 'argus.core',
            kind: 'execution-target-preflight',
            ok: true,
            reason: 'ready',
            resourceScope: {
              kind: 'kubernetes', backendId: 17, targetId: 'argus-aiops-kind',
              cluster: 'local-kind', namespace: 'argus-demo', environment: 'local-demo',
            },
            certification: null,
            policy: { warningAgeHours: 120, maxAgeHours: 168, enforceAIOps: true },
          };
        },
      },
      fetchFn: async input => {
        if (String(input).endsWith('/.well-known/agent-card.json')) {
          return new Response(JSON.stringify({
            ...agentCard(),
            skills: [{ id: 'incident-investigation', name: 'Incident investigation', 'x-argus-workflow': {
              requiredExecutionTargetKinds: ['kubernetes'],
            } }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          task: { id: 'target-preflight', contextId: 'context-1', status: { state: 'TASK_STATE_COMPLETED' } },
        }), { status: 200 });
      },
    });

    const result = await client.sendMessage('argus.dev', 'coding-orchestrator', {
      data: { operation: 'workflow.preflight', workflowId: 'incident-investigation' },
    }, {
      principalKind: 'user', principalId: '7', principalAllowedBundleIds: [8], requestedBundleIds: [8],
      requestedResourceScope: { kind: 'kubernetes', backendId: 17, targetId: 'argus-aiops-kind', namespace: 'argus-demo' },
    });

    expect(result.task.artifacts?.find(artifact => artifact.name === 'Argus Core execution target preflight'))
      .toMatchObject({ parts: [{ data: { kind: 'execution-target-preflight', ok: true, reason: 'ready' } }] });
  });

  it('finalizes a persisted Solution Pack root trace when UI polling observes a terminal task', async () => {
    const registry = await readyRegistry();
    const finalized: unknown[] = [];
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      executionGrantIssuer: {
        async issue() { return 'eg_v1.payload.signature'; },
        async finalizeRootTrace(...args) { finalized.push(args); },
      },
      fetchFn: async () => new Response(JSON.stringify({
        id: 'completed-task',
        contextId: '43667960-d455-4453-b0cf-1bae4955270d',
        status: {
          state: 'TASK_STATE_COMPLETED',
          message: { messageId: 'done', role: 'ROLE_AGENT', parts: [{ text: 'Evidence reviewed.' }] },
        },
        metadata: { rootTraceId: '5cd3dd65-5a0d-4433-931b-8cc4ecace812' },
      }), { status: 200 }),
    });

    await client.getTask('argus.dev', 'coding-orchestrator', 'completed-task');

    expect(finalized).toEqual([[
      '5cd3dd65-5a0d-4433-931b-8cc4ecace812',
      'completed',
      { taskId: 'completed-task', state: 'TASK_STATE_COMPLETED', message: 'Evidence reviewed.' },
    ]]);
  });

  it('loads a bounded persisted task catalog without exposing Pack credentials to the caller', async () => {
    const registry = await readyRegistry();
    const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    const client = new A2aHttpJsonClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), headers: init?.headers });
        return new Response(JSON.stringify({
          tasks: [{
            task: {
              id: 'completed-task',
              contextId: '43667960-d455-4453-b0cf-1bae4955270d',
              status: { state: 'TASK_STATE_COMPLETED' },
            },
            createdAt: '2026-08-11T08:00:00.000Z',
            updatedAt: '2026-08-11T08:01:00.000Z',
          }],
          nextCursor: 'next_page',
        }), { status: 200 });
      },
    });

    const page = await client.listTasks('argus.dev', 'coding-orchestrator', { limit: 6, cursor: 'current_page' });

    expect(page.tasks[0]?.task.id).toBe('completed-task');
    expect(page.nextCursor).toBe('next_page');
    expect(calls[0]?.url).toBe('http://argus-dev:2025/tasks?limit=6&cursor=current_page');
    expect((calls[0]?.headers as Record<string, string>).authorization).toBe('Bearer service-token');
  });
});
