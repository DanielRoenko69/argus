import { describe, expect, it, jest } from '@jest/globals';
import { SOLUTION_PACK_MANIFEST_PATH, SolutionPackRegistry } from '../discovery.js';
import {
  RuntimeAdapterClientError,
  SolutionPackRuntimeAdapterClient,
  type ManagedRuntimeStartInput,
} from '../runtimeAdapterClient.js';

function manifest(adapterCapabilities = ['health', 'runs', 'events-sse', 'cancel', 'approval', 'mcp-fabric']): string {
  return JSON.stringify({
    apiVersion: 'argus.eu/v1alpha1',
    kind: 'SolutionPack',
    metadata: { id: 'argus.hermes', version: '0.1.0', displayName: 'Argus Hermes' },
    spec: {
      delivery: { type: 'container', protocol: 'argus-pack-v1alpha1' },
      requires: { core: '>=1.0.0' },
      components: {
        runtimeAdapters: [{
          id: 'hermes-http',
          runtime: 'hermes',
          protocol: 'argus-runtime-v1alpha1',
          endpoint: '/runtime/v1',
          modes: ['attached', 'managed'],
          capabilities: adapterCapabilities,
        }],
      },
      readiness: { smokeTests: ['pack-health'] },
    },
  });
}

function capabilities() {
  return {
    adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' },
    modes: ['attached', 'managed'],
    capabilities: ['health', 'runs', 'events-sse', 'cancel', 'approval', 'mcp-fabric'],
  };
}

function status() {
  return {
    adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' },
    state: 'ready',
    checkedAt: '2026-08-30T10:00:00.000Z',
    modes: [
      { mode: 'attached', state: 'ready' },
      { mode: 'managed', state: 'degraded', detail: 'No managed runner has been provisioned.' },
    ],
  };
}

async function readyRegistry(): Promise<SolutionPackRegistry> {
  const registry = new SolutionPackRegistry(
    [{ packId: 'argus.hermes', endpoint: 'http://argus-hermes:8090', tokenFile: '/run/secrets/hermes-pack-token' }],
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

const managedStart: ManagedRuntimeStartInput = {
  packId: 'argus.hermes',
  adapterId: 'hermes-http',
  requestId: '651bb748-092e-4c43-bb6c-3ba5de7c46ba',
  run: {
    id: '15821311-46ae-45e6-b30f-9d38c5f1e43c',
    rootTraceId: '38da3bf3-2770-42a2-a957-9c8b4306c9fb',
    messageId: 'runtime-message-7',
    sessionId: 'hermes:15821311-46ae-45e6-b30f-9d38c5f1e43c',
    coreAgent: { id: 7, name: 'coder' },
    input: { text: 'Inspect the bounded runtime contract.' },
  },
  runtimeMcpLease: {
    kind: 'argus.runtime-mcp-lease/v1alpha1',
    leaseId: '44fce111-2806-4b9d-9d5c-a7c74af6b297',
    endpoint: 'http://argus-core:3000/mcp/runtime/44fce111-2806-4b9d-9d5c-a7c74af6b297',
    executionGrant: 'eg_v1.opaque_payload.opaque_signature',
    expiresAt: '2026-08-30T15:00:00.000Z',
    rootTraceId: '38da3bf3-2770-42a2-a957-9c8b4306c9fb',
    bundleIds: [3, 7],
    serverName: 'argus_core',
  },
  limits: {
    deadlineAt: '2026-08-30T14:45:00.000Z',
    maxToolCalls: 20,
    maxOutputBytes: 65_536,
  },
};

function managedSummary(state: 'queued' | 'provisioning' | 'running' | 'awaiting_approval' | 'cancelling' | 'cancelled' | 'completed' | 'failed' = 'running') {
  return {
    id: managedStart.run.id,
    mode: 'managed' as const,
    rootTraceId: managedStart.run.rootTraceId,
    state,
    acceptedAt: '2026-08-30T14:01:00.000Z',
    updatedAt: '2026-08-30T14:02:00.000Z',
    eventCursor: '42',
  };
}

function managedLifecycleEvent(sequence: number, type: 'run.started' | 'tool.completed' = 'run.started') {
  return {
    apiVersion: 'argus-runtime-v1alpha1',
    eventId: String(40 + sequence),
    sequence,
    occurredAt: `2026-08-30T14:0${sequence}:00.000Z`,
    run: {
      id: managedStart.run.id,
      rootTraceId: managedStart.run.rootTraceId,
      state: sequence === 1 ? 'running' : 'completed',
    },
    type,
    evidence: { stage: sequence === 1 ? 'runner' : 'tool', success: true },
  };
}

describe('SolutionPackRuntimeAdapterClient', () => {
  it('starts, polls and stops only the declared external-attested attached adapter path', async () => {
    const registry = await readyRegistry();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const response = (state: 'running' | 'completed' | 'stopping') => new Response(JSON.stringify({
      apiVersion: 'argus-runtime-v1alpha1',
      trust: 'external_attested',
      governance: { coreMcpLease: false, nativeToolsExternallyGoverned: true },
      run: {
        id: 'run_smoke-1', mode: 'attached', state, updatedAt: '2026-08-31T12:00:00.000Z',
        ...(state === 'completed' ? { output: 'ok' } : {}),
      },
    }), { status: state === 'running' ? 202 : 200 });
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), init });
        if (String(input).endsWith('/stop')) return response('stopping');
        if (init?.method === 'POST') return response('running');
        return response('completed');
      },
    });

    const started = await client.startAttachedRun({
      packId: 'argus.hermes', adapterId: 'hermes-http', input: { text: 'Read-only smoke.' },
    });
    const status = await client.getAttachedRunStatus({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: started.run.id,
    });
    const stopped = await client.stopAttachedRun({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: started.run.id,
    });

    expect(started).toMatchObject({ trust: 'external_attested', governance: { coreMcpLease: false }, run: { state: 'running' } });
    expect(status.run).toMatchObject({ state: 'completed', output: 'ok' });
    expect(stopped.run.state).toBe('stopping');
    expect(calls.map(call => call.url)).toEqual([
      'http://argus-hermes:8090/runtime/v1/adapters/hermes-http/attached/runs',
      'http://argus-hermes:8090/runtime/v1/adapters/hermes-http/attached/runs/run_smoke-1',
      'http://argus-hermes:8090/runtime/v1/adapters/hermes-http/attached/runs/run_smoke-1/stop',
    ]);
    expect(calls.every(call => new Headers(call.init?.headers).get('authorization') === 'Bearer service-token')).toBe(true);
  });

  it('queries only the declared Pack adapter endpoints with the Core-held service credential', async () => {
    const registry = await readyRegistry();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/capabilities')) return new Response(JSON.stringify(capabilities()), { status: 200 });
        if (url.endsWith('/status')) return new Response(JSON.stringify(status()), { status: 200 });
        return new Response('', { status: 404 });
      },
    });

    const reportedCapabilities = await client.getCapabilities('argus.hermes', 'hermes-http');
    const reportedStatus = await client.getStatus('argus.hermes', 'hermes-http');

    expect(reportedCapabilities.adapter.endpoint).toBe('/runtime/v1');
    expect(reportedCapabilities.capabilities.capabilities).toContain('runs');
    expect(reportedStatus.status.modes).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'attached', state: 'ready' }),
    ]));
    expect(calls.map(call => call.url)).toEqual([
      'http://argus-hermes:8090/runtime/v1/adapters/hermes-http/capabilities',
      'http://argus-hermes:8090/runtime/v1/adapters/hermes-http/status',
    ]);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer service-token');
    expect(headers.accept).toBe('application/json');
    expect(headers['x-argus-runtime-protocol']).toBe('argus-runtime-v1alpha1');
    expect(calls[0]?.init?.redirect).toBe('manual');
  });

  it('fails closed when the Pack is not ready or the adapter was never declared', async () => {
    const unchecked = new SolutionPackRegistry(
      [{ packId: 'argus.hermes', endpoint: 'http://argus-hermes:8090' }],
      { coreVersion: '1.0.0' },
    );
    await expect(new SolutionPackRuntimeAdapterClient(unchecked).getStatus('argus.hermes', 'hermes-http'))
      .rejects.toMatchObject({ status: 409, code: 'pack_not_ready' });

    const registry = await readyRegistry();
    await expect(new SolutionPackRuntimeAdapterClient(registry).getStatus('argus.hermes', 'not-declared'))
      .rejects.toMatchObject({ status: 404, code: 'runtime_adapter_not_found' });
  });

  it('rejects a response that changes adapter identity or expands the discovered capability contract', async () => {
    const registry = await readyRegistry();
    const wrongIdentity = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async () => new Response(JSON.stringify({
        ...capabilities(),
        adapter: { id: 'other', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' },
      }), { status: 200 }),
    });
    await expect(wrongIdentity.getCapabilities('argus.hermes', 'hermes-http'))
      .rejects.toMatchObject({ status: 502, code: 'adapter_identity_mismatch' });

    const widened = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async () => new Response(JSON.stringify({
        ...capabilities(),
        capabilities: [...capabilities().capabilities, 'host-shell'],
      }), { status: 200 }),
    });
    await expect(widened.getCapabilities('argus.hermes', 'hermes-http'))
      .rejects.toMatchObject({ status: 502, code: 'adapter_contract_mismatch' });
  });

  it('does not relay remote error bodies and enforces bounded JSON responses', async () => {
    const registry = await readyRegistry();
    const rejected = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async () => new Response(JSON.stringify({ error: 'secret: should not reach UI' }), { status: 401 }),
    });
    await expect(rejected.getStatus('argus.hermes', 'hermes-http'))
      .rejects.toMatchObject({ status: 502, code: 'peer_rejected' });
    await expect(rejected.getStatus('argus.hermes', 'hermes-http'))
      .rejects.not.toThrow(/secret/);

    const oversized = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async () => new Response('x'.repeat(64 * 1024 + 1), { status: 200 }),
    });
    await expect(oversized.getStatus('argus.hermes', 'hermes-http'))
      .rejects.toMatchObject({ status: 502, code: 'response_too_large' });
  });

  it('starts only a manifest-declared managed MCP Fabric runtime with the Core-held Pack credential', async () => {
    const registry = await readyRegistry();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({
          apiVersion: 'argus-runtime-v1alpha1',
          run: {
            id: managedStart.run.id,
            mode: 'managed',
            state: 'queued',
            rootTraceId: managedStart.run.rootTraceId,
            acceptedAt: '2026-08-30T14:01:00.000Z',
            updatedAt: '2026-08-30T14:01:00.000Z',
            eventCursor: '1',
          },
        }), { status: 202 });
      },
    });

    await expect(client.startManagedRun(managedStart)).resolves.toMatchObject({
      run: {
        id: managedStart.run.id,
        mode: 'managed',
        state: 'queued',
        acceptedAt: '2026-08-30T14:01:00.000Z',
        updatedAt: '2026-08-30T14:01:00.000Z',
        eventCursor: '1',
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://argus-hermes:8090/runtime/v1/adapters/hermes-http/runs');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers).toMatchObject({
      authorization: 'Bearer service-token',
      accept: 'application/json',
      'content-type': 'application/json',
      'x-argus-runtime-protocol': 'argus-runtime-v1alpha1',
      'x-argus-root-trace-id': managedStart.run.rootTraceId,
    });
    expect(calls[0]?.init?.redirect).toBe('manual');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      apiVersion: 'argus-runtime-v1alpha1',
      requestId: managedStart.requestId,
      mode: 'managed',
      run: managedStart.run,
      runtimeMcpLease: managedStart.runtimeMcpLease,
      limits: managedStart.limits,
    });
  });

  it('maps the expected not-provisioned contract response without relaying an opaque grant or Pack diagnostics', async () => {
    const registry = await readyRegistry();
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async () => new Response(JSON.stringify({
        error: {
          code: 'MANAGED_RUNNER_NOT_PROVISIONED',
          message: `private upstream diagnostic for ${managedStart.runtimeMcpLease.executionGrant}`,
        },
      }), { status: 409 }),
    });

    await expect(client.startManagedRun(managedStart)).rejects.toMatchObject({
      status: 409,
      code: 'managed_runner_not_provisioned',
      message: 'The managed runtime is not provisioned',
    });
    await client.startManagedRun(managedStart).catch(error => {
      expect(error).toBeInstanceOf(RuntimeAdapterClientError);
      expect(error.message).not.toContain('private upstream diagnostic');
      expect(error.message).not.toContain(managedStart.runtimeMcpLease.executionGrant);
    });
  });

  it('rejects a legacy startedAt response so a queued acceptance cannot be mistaken for a started runner', async () => {
    const registry = await readyRegistry();
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async () => new Response(JSON.stringify({
        apiVersion: 'argus-runtime-v1alpha1',
        run: {
          id: managedStart.run.id,
          mode: 'managed',
          state: 'queued',
          rootTraceId: managedStart.run.rootTraceId,
          startedAt: '2026-08-30T14:01:00.000Z',
        },
      }), { status: 202 }),
    });

    await expect(client.startManagedRun(managedStart)).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
    });
  });

  it('fails before network access if a discovered adapter does not declare managed runs and MCP Fabric', async () => {
    const registry = new SolutionPackRegistry(
      [{ packId: 'argus.hermes', endpoint: 'http://argus-hermes:8090', tokenFile: '/run/secrets/hermes-pack-token' }],
      {
        coreVersion: '1.0.0',
        readTokenFile: async () => 'service-token',
        fetchFn: async input => String(input).endsWith(SOLUTION_PACK_MANIFEST_PATH)
          ? new Response(manifest(['health', 'runs']), { status: 200 })
          : new Response('', { status: 200 }),
      },
    );
    await registry.refresh();
    const fetchFn = jest.fn<typeof fetch>();
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn,
    });

    await expect(client.startManagedRun(managedStart)).rejects.toMatchObject({
      status: 409,
      code: 'managed_runtime_not_supported',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a 202 response that is not bound to the requested managed run and trace', async () => {
    const registry = await readyRegistry();
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async () => new Response(JSON.stringify({
        apiVersion: 'argus-runtime-v1alpha1',
        run: {
          id: 'af0af8de-3a12-4b02-b7cc-6a357777495b',
          mode: 'managed',
          state: 'queued',
          rootTraceId: managedStart.run.rootTraceId,
          acceptedAt: '2026-08-30T14:01:00.000Z',
          updatedAt: '2026-08-30T14:01:00.000Z',
        },
      }), { status: 202 }),
    });

    await expect(client.startManagedRun(managedStart)).rejects.toMatchObject({
      status: 502,
      code: 'managed_run_identity_mismatch',
    });
  });

  it('reads managed status and cancels only through fixed declared lifecycle paths', async () => {
    const registry = await readyRegistry();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith(`/runs/${managedStart.run.id}/cancel`)) {
          return new Response(JSON.stringify({
            apiVersion: 'argus-runtime-v1alpha1',
            run: managedSummary('cancelled'),
          }), { status: 200 });
        }
        if (url.endsWith(`/runs/${managedStart.run.id}`)) {
          return new Response(JSON.stringify({
            apiVersion: 'argus-runtime-v1alpha1',
            run: {
              ...managedSummary('completed'),
              output: '- src/parser.ts',
              usage: {
                inputTokens: 120, outputTokens: 30, totalTokens: 150,
                cacheReadInputTokens: 40, reasoningTokens: 12, apiCalls: 3, estimatedCostUsd: 0.0042,
              },
            },
          }), { status: 200 });
        }
        return new Response('', { status: 404 });
      },
    });

    await expect(client.getManagedRunStatus({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: managedStart.run.id, rootTraceId: managedStart.run.rootTraceId,
    })).resolves.toMatchObject({
      run: {
        state: 'completed', eventCursor: '42', output: '- src/parser.ts',
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadInputTokens: 40 },
      },
    });
    await expect(client.cancelManagedRun({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: managedStart.run.id, rootTraceId: managedStart.run.rootTraceId,
      requestId: 'b5635ea8-4a89-4051-8785-0e7ff1da20d4', reason: 'operator requested stop',
    })).resolves.toMatchObject({ run: { state: 'cancelled' } });

    expect(calls.map(call => call.url)).toEqual([
      `http://argus-hermes:8090/runtime/v1/adapters/hermes-http/runs/${managedStart.run.id}`,
      `http://argus-hermes:8090/runtime/v1/adapters/hermes-http/runs/${managedStart.run.id}/cancel`,
    ]);
    const statusHeaders = calls[0]?.init?.headers as Record<string, string>;
    expect(statusHeaders).toMatchObject({
      authorization: 'Bearer service-token',
      accept: 'application/json',
      'x-argus-runtime-protocol': 'argus-runtime-v1alpha1',
      'x-argus-root-trace-id': managedStart.run.rootTraceId,
    });
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.redirect).toBe('manual');
    expect(calls[1]?.init?.method).toBe('POST');
    expect(calls[1]?.init?.redirect).toBe('manual');
    const cancelBody = String(calls[1]?.init?.body);
    expect(JSON.parse(cancelBody)).toEqual({
      apiVersion: 'argus-runtime-v1alpha1',
      requestId: 'b5635ea8-4a89-4051-8785-0e7ff1da20d4',
      rootTraceId: managedStart.run.rootTraceId,
      reason: 'operator requested stop',
    });
    expect(cancelBody).not.toContain('eg_v1.');
  });

  it('maps a missing native managed run to an explicit terminal reconciliation signal', async () => {
    const registry = await readyRegistry();
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async () => new Response(JSON.stringify({
        error: { code: 'MANAGED_RUN_NOT_FOUND', message: 'not found' },
      }), { status: 404 }),
    });

    await expect(client.getManagedRunStatus({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: managedStart.run.id,
      rootTraceId: managedStart.run.rootTraceId,
    })).rejects.toMatchObject({ status: 404, code: 'managed_run_not_found' });
  });

  it('parses only bounded normalized managed lifecycle SSE events and binds them to the requested run', async () => {
    const registry = await readyRegistry();
    const first = managedLifecycleEvent(1);
    const second = managedLifecycleEvent(2, 'tool.completed');
    const sse = [
      `id: ${first.eventId}`,
      'event: argus.runtime.event',
      `data: ${JSON.stringify(first)}`,
      '',
      `id: ${second.eventId}`,
      `data: ${JSON.stringify(second)}`,
      '',
    ].join('\n');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      },
    });

    await expect(client.getManagedRunEvents({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: managedStart.run.id,
      rootTraceId: managedStart.run.rootTraceId, after: '40',
    })).resolves.toEqual({ events: [first, second], lastEventId: '42' });
    expect(calls[0]?.url).toBe(`http://argus-hermes:8090/runtime/v1/adapters/hermes-http/runs/${managedStart.run.id}/events`);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers).toMatchObject({
      authorization: 'Bearer service-token',
      accept: 'text/event-stream',
      'last-event-id': '40',
      'x-argus-root-trace-id': managedStart.run.rootTraceId,
    });
    expect(calls[0]?.init?.redirect).toBe('manual');
  });

  it('requires the exact manifest-declared capability for each managed lifecycle operation', async () => {
    const registry = new SolutionPackRegistry(
      [{ packId: 'argus.hermes', endpoint: 'http://argus-hermes:8090', tokenFile: '/run/secrets/hermes-pack-token' }],
      {
        coreVersion: '1.0.0',
        readTokenFile: async () => 'service-token',
        fetchFn: async input => String(input).endsWith(SOLUTION_PACK_MANIFEST_PATH)
          ? new Response(manifest(['health', 'runs']), { status: 200 })
          : new Response('', { status: 200 }),
      },
    );
    await registry.refresh();
    const fetchFn = jest.fn<typeof fetch>(async () => new Response(JSON.stringify({
      apiVersion: 'argus-runtime-v1alpha1', run: managedSummary(),
    }), { status: 200 }));
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn,
    });
    const identity = {
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: managedStart.run.id, rootTraceId: managedStart.run.rootTraceId,
    };

    await expect(client.getManagedRunStatus(identity)).resolves.toMatchObject({ run: { state: 'running' } });
    await expect(client.cancelManagedRun({
      ...identity,
      requestId: '03d74f08-9de1-4b31-8056-44f54ea449a8',
    })).rejects.toMatchObject({ status: 409, code: 'managed_runtime_not_supported' });
    await expect(client.getManagedRunEvents(identity)).rejects.toMatchObject({
      status: 409,
      code: 'managed_runtime_not_supported',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed lifecycle requests, mismatched event evidence and Pack diagnostics without forwarding them', async () => {
    const registry = await readyRegistry();
    const fetchFn = jest.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { code: 'MANAGED_RUNNER_NOT_PROVISIONED', message: 'private upstream runner diagnostic' },
    }), { status: 409 }));
    const client = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn,
    });

    await expect(client.getManagedRunEvents({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: managedStart.run.id,
      rootTraceId: managedStart.run.rootTraceId, after: 'bad\nheader',
    })).rejects.toMatchObject({ status: 400, code: 'invalid_managed_runtime_lifecycle_request' });
    expect(fetchFn).not.toHaveBeenCalled();

    await expect(client.getManagedRunStatus({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: managedStart.run.id, rootTraceId: managedStart.run.rootTraceId,
    })).rejects.toMatchObject({
      status: 409,
      code: 'managed_runner_not_provisioned',
      message: 'The managed runtime is not provisioned',
    });
    await client.getManagedRunStatus({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: managedStart.run.id, rootTraceId: managedStart.run.rootTraceId,
    }).catch(error => expect(error.message).not.toContain('private upstream runner diagnostic'));

    const mismatch = new SolutionPackRuntimeAdapterClient(registry, {
      readTokenFile: async () => 'service-token',
      fetchFn: async () => new Response([
        `data: ${JSON.stringify({
          ...managedLifecycleEvent(1),
          run: { id: managedStart.run.id, rootTraceId: '10f9b0b8-b846-4e59-90a0-c4e0a9518a41', state: 'running' },
        })}`,
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    await expect(mismatch.getManagedRunEvents({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: managedStart.run.id, rootTraceId: managedStart.run.rootTraceId,
    })).rejects.toMatchObject({ status: 502, code: 'managed_run_identity_mismatch' });
  });
});
