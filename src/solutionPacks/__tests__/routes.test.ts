import { afterEach, describe, expect, it } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { SOLUTION_PACK_MANIFEST_PATH, SolutionPackRegistry } from '../discovery.js';
import { registerSolutionPackRoutes, type HermesManagedRuntimeUiCatalog } from '../routes.js';
import type { A2aGateway, A2aTask } from '../../a2a/client.js';
import type { RuntimeAdapterGateway } from '../runtimeAdapterClient.js';
import type { ManagedRuntimeLifecycleGateway } from '../managedRuntimeCoordinator.js';
import type { IncidentAiopsTaskRecord, IncidentAiopsTaskStore } from '../../observability/incidentAiopsTasks.js';
import type { IncidentAiopsFeedbackStore } from '../../observability/incidentAiopsFeedback.js';
import type { NativeAlertAiopsAutomationReader } from '../../observability/nativeAlertAiopsAutomation.js';
import type { IncidentImpactReader } from '../../observability/incidentImpact.js';
import type {
  IncidentRemediationRecord,
  IncidentRemediationStore,
} from '../../observability/incidentRemediations.js';
import type { IncidentRemediationExecutor } from '../../observability/incidentRemediationExecutor.js';

const servers: Server[] = [];
const pass: RequestHandler = (_req, _res, next) => next();

function manifest(): string {
  return JSON.stringify({
    apiVersion: 'argus.eu/v1alpha1',
    kind: 'SolutionPack',
    metadata: { id: 'argus.dev', version: '0.1.0', displayName: 'Argus Dev' },
    spec: {
      delivery: { type: 'container', protocol: 'argus-pack-v1alpha1' },
      requires: { core: '>=1.0.0' },
      components: {},
      readiness: { smokeTests: ['pack-health'] },
    },
  });
}

async function serve(
  registry: SolutionPackRegistry,
  requireAdmin: RequestHandler = pass,
  a2a?: A2aGateway,
  incidentAiopsTasks?: IncidentAiopsTaskStore,
  incidentAiopsAutomation?: NativeAlertAiopsAutomationReader,
  incidentImpactReader?: IncidentImpactReader,
  incidentRemediations?: IncidentRemediationStore,
  incidentRemediationExecutor?: IncidentRemediationExecutor,
  runtimeAdapters?: RuntimeAdapterGateway,
  managedRuntimes?: ManagedRuntimeLifecycleGateway,
  requireDeveloper: RequestHandler = pass,
  managedRuntimeUi?: HermesManagedRuntimeUiCatalog,
  incidentAiopsFeedback?: IncidentAiopsFeedbackStore,
  requireAuthMiddleware: RequestHandler = pass,
): Promise<string> {
  const app = express();
  app.use(express.json());
  registerSolutionPackRoutes(app, registry, requireAuthMiddleware, requireAdmin, pass, a2a, incidentAiopsTasks, incidentAiopsAutomation, incidentImpactReader, incidentRemediations, incidentRemediationExecutor, runtimeAdapters, managedRuntimes, requireDeveloper, managedRuntimeUi, incidentAiopsFeedback);
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('Solution Pack admin routes', () => {
  it('lists not-checked packs and refreshes their discovered readiness', async () => {
    const registry = new SolutionPackRegistry(
      [{ packId: 'argus.dev', endpoint: 'http://argus-dev:8080' }],
      {
        coreVersion: '1.0.0',
        fetchFn: async input => String(input).endsWith(SOLUTION_PACK_MANIFEST_PATH)
          ? new Response(manifest(), { status: 200 })
          : new Response('', { status: 200 }),
      },
    );
    const baseUrl = await serve(registry);

    const before = await fetch(`${baseUrl}/api/admin/solution-packs`).then(response => response.json()) as {
      packs: Array<{ state: string }>;
    };
    expect(before.packs[0]?.state).toBe('not_checked');

    const refreshed = await fetch(`${baseUrl}/api/admin/solution-packs/refresh`, { method: 'POST' })
      .then(response => response.json()) as { packs: Array<{ state: string }> };
    expect(refreshed.packs[0]?.state).toBe('ready');
  });

  it('keeps the inventory behind the platform-admin middleware', async () => {
    const deny: RequestHandler = (_req, res) => { res.status(403).json({ error: 'admin only' }); };
    const baseUrl = await serve(new SolutionPackRegistry([], { coreVersion: '1.0.0' }), deny);
    const response = await fetch(`${baseUrl}/api/admin/solution-packs`);
    expect(response.status).toBe(403);
  });

  it('proxies only sanitized read-only runtime adapter status and capabilities to platform admins', async () => {
    const calls: string[][] = [];
    const adapter = {
      id: 'hermes-http',
      runtime: 'hermes',
      protocol: 'argus-runtime-v1alpha1' as const,
      endpoint: '/runtime/v1',
      modes: ['attached', 'managed'] as Array<'attached' | 'managed'>,
      capabilities: ['health', 'runs'],
    };
    const runtimeAdapters: RuntimeAdapterGateway = {
      async getCapabilities(packId, adapterId) {
        calls.push(['capabilities', packId, adapterId]);
        return {
          adapter,
          capabilities: {
            adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' },
            modes: ['attached', 'managed'],
            capabilities: ['health', 'runs'],
          },
        };
      },
      async getStatus(packId, adapterId) {
        calls.push(['status', packId, adapterId]);
        return {
          adapter,
          status: {
            adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' },
            state: 'ready',
            checkedAt: '2026-08-30T12:00:00.000Z',
            modes: [{ mode: 'attached', state: 'ready' }],
          },
        };
      },
    };
    const baseUrl = await serve(
      new SolutionPackRegistry([], { coreVersion: '1.0.0' }),
      pass,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runtimeAdapters,
    );

    const capabilities = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/capabilities`);
    expect(capabilities.status).toBe(200);
    await expect(capabilities.json()).resolves.toMatchObject({
      adapter: { id: 'hermes-http', endpoint: '/runtime/v1' },
      capabilities: { capabilities: ['health', 'runs'] },
    });
    const status = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/status`);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ status: { state: 'ready' } });
    expect(calls).toEqual([
      ['capabilities', 'argus.hermes', 'hermes-http'],
      ['status', 'argus.hermes', 'hermes-http'],
    ]);
  });

  it('fails closed when no runtime adapter gateway is configured', async () => {
    const baseUrl = await serve(new SolutionPackRegistry([], { coreVersion: '1.0.0' }));
    const response = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/status`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'runtime_adapter_gateway_unavailable' });
  });

  it('proxies an attached Hermes smoke lifecycle without accepting endpoint, credential or governance overrides', async () => {
    const calls: unknown[] = [];
    const adapter = {
      id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' as const, endpoint: '/runtime/v1',
      modes: ['attached', 'managed'] as Array<'attached' | 'managed'>, capabilities: ['health', 'runs', 'cancel'],
    };
    const result = (state: 'running' | 'completed' | 'stopping') => ({
      apiVersion: 'argus-runtime-v1alpha1' as const,
      trust: 'external_attested' as const,
      governance: { coreMcpLease: false as const, nativeToolsExternallyGoverned: true as const },
      run: { id: 'run_smoke-1', mode: 'attached' as const, state, updatedAt: '2026-08-31T12:00:00.000Z' },
    });
    const runtimeAdapters: RuntimeAdapterGateway = {
      async getCapabilities() { return { adapter, capabilities: { adapter, modes: ['attached'], capabilities: ['health', 'runs', 'cancel'] } }; },
      async getStatus() { return { adapter, status: { adapter, state: 'ready', modes: [{ mode: 'attached', state: 'ready' }] } }; },
      async startAttachedRun(input) { calls.push(['start', input]); return result('running'); },
      async getAttachedRunStatus(input) { calls.push(['status', input]); return result('completed'); },
      async stopAttachedRun(input) { calls.push(['stop', input]); return result('stopping'); },
    };
    const baseUrl = await serve(
      new SolutionPackRegistry([], { coreVersion: '1.0.0' }),
      pass, undefined, undefined, undefined, undefined, undefined, undefined, runtimeAdapters,
    );

    const rejected = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/attached-runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { text: 'smoke' }, endpoint: 'http://attacker', apiKey: 'secret' }),
    });
    expect(rejected.status).toBe(400);
    expect(calls).toEqual([]);

    const start = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/attached-runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: { text: 'Read-only smoke.' } }),
    });
    expect(start.status).toBe(202);
    await expect(start.json()).resolves.toMatchObject({ trust: 'external_attested', governance: { coreMcpLease: false } });
    const status = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/attached-runs/run_smoke-1`);
    expect(status.status).toBe(200);
    const stop = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/attached-runs/run_smoke-1/stop`, { method: 'POST' });
    expect(stop.status).toBe(200);
    expect(calls).toEqual([
      ['start', { packId: 'argus.hermes', adapterId: 'hermes-http', input: { text: 'Read-only smoke.' } }],
      ['status', { packId: 'argus.hermes', adapterId: 'hermes-http', runId: 'run_smoke-1' }],
      ['stop', { packId: 'argus.hermes', adapterId: 'hermes-http', runId: 'run_smoke-1' }],
    ]);
  });

  it('keeps managed runtime launch unavailable until Core wires an explicit coordinator', async () => {
    const baseUrl = await serve(new SolutionPackRegistry([], { coreVersion: '1.0.0' }));
    const response = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'managed_runtime_orchestration_unavailable' });
  });

  it('derives the managed-runtime principal and target identity in Core instead of accepting them from the browser', async () => {
    const calls: unknown[] = [];
    const coordinator: ManagedRuntimeLifecycleGateway = {
      async list() {
        return [await this.getStatus({ packId: '', adapterId: '', runId: '' })];
      },
      async launch(input) {
        calls.push(input);
        return {
          idempotent: false,
          run: {
            id: '950610b9-97b4-41cb-908f-46cc80bd22a2', mode: 'managed',
            rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b', state: 'queued',
            acceptedAt: '2026-08-30T14:00:00.000Z', updatedAt: '2026-08-30T14:00:00.000Z',
          },
          lease: {
            leaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1', packId: 'argus.hermes', adapterId: 'hermes-http',
            coreAgentId: 42, runId: '950610b9-97b4-41cb-908f-46cc80bd22a2', requestId: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd',
            rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b', mode: 'managed', status: 'active',
            issuedAt: '2026-08-30T14:00:00.000Z', activatedAt: '2026-08-30T14:00:00.000Z',
            expiresAt: '2026-08-30T14:15:00.000Z', revokedAt: null, terminalAt: null,
          },
        };
      },
      async getStatus() {
        return {
          run: {
            id: '950610b9-97b4-41cb-908f-46cc80bd22a2', mode: 'managed' as const,
            rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b', state: 'running' as const,
            acceptedAt: '2026-08-30T14:00:00.000Z', updatedAt: '2026-08-30T14:00:02.000Z',
          },
          lease: {
            leaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1', packId: 'argus.hermes', adapterId: 'hermes-http',
            coreAgentId: 42, runId: '950610b9-97b4-41cb-908f-46cc80bd22a2', requestId: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd',
            rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b', mode: 'managed' as const, status: 'active' as const,
            issuedAt: '2026-08-30T14:00:00.000Z', activatedAt: '2026-08-30T14:00:00.000Z',
            expiresAt: '2026-08-30T14:15:00.000Z', revokedAt: null, terminalAt: null,
          },
        };
      },
      async cancel() {
        return this.getStatus({ packId: '', adapterId: '', runId: '' });
      },
      async getEvents() {
        return {
          run: {
            id: '950610b9-97b4-41cb-908f-46cc80bd22a2', mode: 'managed' as const,
            rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b', state: 'running' as const,
            acceptedAt: '2026-08-30T14:00:00.000Z', updatedAt: '2026-08-30T14:00:02.000Z', eventCursor: 'event-1',
          },
          events: [{
            apiVersion: 'argus-runtime-v1alpha1' as const, eventId: 'event-1', sequence: 1,
            occurredAt: '2026-08-30T14:00:02.000Z',
            run: { id: '950610b9-97b4-41cb-908f-46cc80bd22a2', rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b', state: 'running' as const },
            type: 'run.started' as const,
          }],
          lastEventId: 'event-1',
        };
      },
    };
    const authenticatedAdmin: RequestHandler = (req, _res, next) => {
      (req as unknown as { user: unknown }).user = {
        id: 7, username: 'alex', display_name: 'Alex', role: 'platform_admin', allowed_bundles: [3], entra_groups: [],
      };
      next();
    };
    const baseUrl = await serve(
      new SolutionPackRegistry([], { coreVersion: '1.0.0' }),
      authenticatedAdmin,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      coordinator,
    );
    const response = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd', coreAgentName: 'planner', bundleIds: [3],
        input: { text: 'Summarize evidence.' },
        // A browser cannot smuggle any alternate identity or lease details.
        principal: { kind: 'service', id: 'attacker', allowedBundleIds: null },
      }),
    });
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);

    const safeResponse = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd', coreAgentName: 'planner', bundleIds: [3],
        input: { text: 'Summarize evidence.' },
      }),
    });
    expect(safeResponse.status).toBe(202);
    expect(calls).toEqual([expect.objectContaining({
      packId: 'argus.hermes', adapterId: 'hermes-http',
      principal: {
        kind: 'user', id: '7', allowedBundleIds: [3],
        tenantKey: 'default', workspaceKey: 'default',
      },
    })]);
    expect(JSON.stringify(await safeResponse.json())).not.toContain('eg_v1.');

    const status = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/runs/950610b9-97b4-41cb-908f-46cc80bd22a2`);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ run: { state: 'running' }, lease: { status: 'active' } });
    const events = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/runs/950610b9-97b4-41cb-908f-46cc80bd22a2/events`, {
      headers: { 'last-event-id': 'event-0' },
    });
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({ lastEventId: 'event-1', events: [{ eventId: 'event-1' }] });
    const cancellation = await fetch(`${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/runs/950610b9-97b4-41cb-908f-46cc80bd22a2/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: '77b94eb1-c83d-42dd-b66e-17b2981e1b97', reason: 'operator stopped test' }),
    });
    expect(cancellation.status).toBe(200);
  });

  it('exposes SSO-owned Managed Hermes lifecycle without granting Solution Pack administration', async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const run = {
      id: '950610b9-97b4-41cb-908f-46cc80bd22a2', mode: 'managed' as const,
      rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b', state: 'running' as const,
      acceptedAt: '2026-08-30T14:00:00.000Z', updatedAt: '2026-08-30T14:00:02.000Z',
    };
    const lease = {
      leaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1', packId: 'argus.hermes', adapterId: 'hermes-http',
      coreAgentId: 42, runId: run.id, requestId: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd',
      rootTraceId: run.rootTraceId, mode: 'managed' as const, status: 'active' as const,
      issuedAt: run.acceptedAt, activatedAt: run.acceptedAt, expiresAt: '2026-08-30T14:15:00.000Z',
      revokedAt: null, terminalAt: null,
    };
    const coordinator: ManagedRuntimeLifecycleGateway = {
      async launch(input) { calls.push({ operation: 'launch', input }); return { idempotent: false, run, lease }; },
      async list(input) { calls.push({ operation: 'list', input }); return [{ run, lease }]; },
      async getStatus(input) { calls.push({ operation: 'status', input }); return { run, lease }; },
      async cancel(input) { calls.push({ operation: 'cancel', input }); return { run: { ...run, state: 'cancelling' }, lease: { ...lease, status: 'revoking' } }; },
      async getEvents(input) { calls.push({ operation: 'events', input }); return { run, events: [] }; },
    };
    const denyAdmin: RequestHandler = (_req, res) => { res.status(403).json({ error: 'admin only' }); };
    const authenticatedDeveloper: RequestHandler = (req, _res, next) => {
      (req as unknown as { user: unknown }).user = {
        id: 7, username: 'entra:developer-7', display_name: 'Hermes Developer', role: 'developer',
        allowed_bundles: [3], entra_groups: ['argus-developers'],
      };
      next();
    };
    const memoryCalls: Array<{ operation: string; values: unknown[] }> = [];
    const managedRuntimeUi: HermesManagedRuntimeUiCatalog = {
      approvedBundleIds: [3],
      async listCoreAgents() { return [{ id: 42, name: 'researcher', label: 'Researcher' }]; },
      async listMemoryProposals(user, limit) {
        memoryCalls.push({ operation: 'list', values: [user.id, limit] });
        return [{
          id: '31', kind: 'semantic', content: 'The repository uses pnpm.', importance: 0.8,
          validDays: 90, status: 'pending', workspaceLabel: 'ARGUS-42',
          sourceTraceId: run.rootTraceId, sourceRuntimeRunId: run.id,
          proposalCount: 1, createdAt: run.updatedAt, reviewedAt: null,
        }];
      },
      async decideMemoryProposal(user, proposalId, decision) {
        memoryCalls.push({ operation: 'decide', values: [user.id, proposalId, decision] });
        return true;
      },
    };
    const baseUrl = await serve(
      new SolutionPackRegistry([], { coreVersion: '1.0.0' }),
      denyAdmin,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      coordinator,
      authenticatedDeveloper,
      managedRuntimeUi,
    );

    expect((await fetch(`${baseUrl}/api/admin/solution-packs`)).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/ui/solution-packs`)).status).toBe(200);
    const listed = await fetch(`${baseUrl}/api/hermes-dev/runtime/runs`);
    expect(listed.status).toBe(200);
    const status = await fetch(`${baseUrl}/api/hermes-dev/runtime/runs/${run.id}`);
    expect(status.status).toBe(200);
    const cancellation = await fetch(`${baseUrl}/api/hermes-dev/runtime/runs/${run.id}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: '77b94eb1-c83d-42dd-b66e-17b2981e1b97' }),
    });
    expect(cancellation.status).toBe(200);
    const proposals = await fetch(`${baseUrl}/api/hermes-dev/runtime/memory-proposals`);
    expect(proposals.status).toBe(200);
    await expect(proposals.json()).resolves.toMatchObject({ proposals: [{ id: '31', status: 'pending' }] });
    const decision = await fetch(`${baseUrl}/api/hermes-dev/runtime/memory-proposals/31/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'accepted' }),
    });
    expect(decision.status).toBe(200);
    expect(memoryCalls).toEqual([
      { operation: 'list', values: [7, 30] },
      { operation: 'decide', values: [7, '31', 'accepted'] },
    ]);
    expect(calls).toEqual([
      {
        operation: 'list',
        input: {
          packId: 'argus.hermes', adapterId: 'hermes-http',
          principal: { kind: 'user', id: '7', tenantKey: 'default', workspaceKey: 'default' },
          limit: 20,
        },
      },
      {
        operation: 'status',
        input: {
          packId: 'argus.hermes', adapterId: 'hermes-http', runId: run.id,
          principal: { kind: 'user', id: '7', tenantKey: 'default', workspaceKey: 'default' },
        },
      },
      {
        operation: 'cancel',
        input: {
          packId: 'argus.hermes', adapterId: 'hermes-http', runId: run.id,
          requestId: '77b94eb1-c83d-42dd-b66e-17b2981e1b97',
          principal: { kind: 'user', id: '7', tenantKey: 'default', workspaceKey: 'default' },
        },
      },
    ]);
  });

  it('requires explicit confirmation before creating a rollback request', async () => {
    const registry = new SolutionPackRegistry(
      [{ packId: 'argus.dev', endpoint: 'http://argus-dev:8080' }],
      { coreVersion: '1.0.0' },
    );
    const baseUrl = await serve(registry);
    const response = await fetch(`${baseUrl}/api/admin/solution-packs/argus.dev/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'rollback the release' }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'rollback_confirmation_required' });
  });

  it('exposes persisted rollback history for a configured pack', async () => {
    const registry = new SolutionPackRegistry(
      [{ packId: 'argus.dev', endpoint: 'http://argus-dev:8080' }],
      { coreVersion: '1.0.0' },
    );
    await registry.attachPersistence({
      async load() { return []; },
      async save() {},
      async createRollbackRequest() { return {} as never; },
      async listRollbackRequestsForPack(packId, limit) {
        return [{ id: 'rollback-1', packId, status: 'accepted' as const, targetVersion: '0.4.0', requestedBy: 'Alex', reason: 'safe rollback', sourceRevision: 4, currentVersion: '0.5.0', targetManifest: {} as never, error: null, requestedAt: '2026-08-10T12:00:00.000Z', updatedAt: '2026-08-10T12:00:00.000Z', appliedAt: null, claimedBy: 'controller-1', claimedAt: '2026-08-10T12:01:00.000Z', claimExpiresAt: '2026-08-10T12:06:00.000Z' }].slice(0, limit);
      },
    });
    const baseUrl = await serve(registry);
    const response = await fetch(`${baseUrl}/api/admin/solution-packs/argus.dev/rollback-requests?limit=5`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ packId: 'argus.dev', total: 1, requests: [{ id: 'rollback-1', claimedBy: 'controller-1' }] });
  });

  it('exposes the Core-owned A2A proxy without leaking Pack credentials', async () => {
    const task: A2aTask = {
      id: 'task-1',
      contextId: 'context-1',
      status: { state: 'TASK_STATE_COMPLETED' },
      metadata: { argusRootTraceId: 'trace-1' },
    };
    const calls: Array<{ operation: string; values: unknown[] }> = [];
    const a2a: A2aGateway = {
      async getAgentCard(packId, agentId) {
        calls.push({ operation: 'card', values: [packId, agentId] });
        return {
          name: 'Argus Dev',
          version: '0.4.0',
          supportedInterfaces: [{ url: 'http://argus-dev:2025', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
          capabilities: {},
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          skills: [{ id: 'ticket-to-pull-request', name: 'Ticket to pull request' }],
        };
      },
      async sendMessage(packId, agentId, input) {
        calls.push({ operation: 'send', values: [packId, agentId, input] });
        return {
          rootTraceId: 'trace-1',
          agentCard: {
            name: 'Argus Dev',
            version: '0.1.0',
            supportedInterfaces: [{ url: 'http://argus-dev:2025', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
            capabilities: {},
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['application/json'],
            skills: [{ id: 'coding-preflight', name: 'Coding preflight' }],
          },
          task,
        };
      },
      async getTask(packId, agentId, taskId) {
        calls.push({ operation: 'get', values: [packId, agentId, taskId] });
        return task;
      },
      async listTasks(packId, agentId, input) {
        calls.push({ operation: 'list', values: [packId, agentId, input] });
        return {
          tasks: [{ task, createdAt: '2026-08-11T08:00:00.000Z', updatedAt: '2026-08-11T08:01:00.000Z' }],
          nextCursor: 'next_page',
        };
      },
      async cancelTask(packId, agentId, taskId) {
        calls.push({ operation: 'cancel', values: [packId, agentId, taskId] });
        return { ...task, status: { state: 'TASK_STATE_CANCELED' } };
      },
    };
    const baseUrl = await serve(new SolutionPackRegistry([], { coreVersion: '1.0.0' }), pass, a2a);
    const card = await fetch(`${baseUrl}/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/card`);
    expect(card.status).toBe(200);
    expect(await card.json()).toMatchObject({ agentCard: { version: '0.4.0' } });
    const sent = await fetch(`${baseUrl}/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Run preflight', data: { operation: 'coding.preflight' } }),
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ rootTraceId: 'trace-1', task: { id: 'task-1' } });
    expect(calls[1]).toEqual({
      operation: 'send',
      values: ['argus.dev', 'coding-orchestrator', { text: 'Run preflight', data: { operation: 'coding.preflight' } }],
    });
    const invalidRuntime = await fetch(`${baseUrl}/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: { operation: 'workflow.start', workflowId: 'ticket-to-pull-request', input: {} },
        execution: { bundleIds: [], runtimeMode: 'browser-controlled-profile-id' },
      }),
    });
    expect(invalidRuntime.status).toBe(400);
    expect(await invalidRuntime.json()).toMatchObject({ code: 'invalid_runtime_mode' });
    const listed = await fetch(`${baseUrl}/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/tasks?limit=6`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ tasks: [{ task: { id: 'task-1' } }], nextCursor: 'next_page' });
    expect(calls[2]).toEqual({
      operation: 'list',
      values: ['argus.dev', 'coding-orchestrator', { limit: 6 }],
    });
  });

  it('forwards only the bounded task runtime mode under the authenticated user scope', async () => {
    let execution: Parameters<A2aGateway['sendMessage']>[3];
    const a2a = {
      async sendMessage(_packId, _agentId, _input, value) {
        execution = value;
        return {
          rootTraceId: '11111111-1111-4111-8111-111111111111',
          agentCard: {
            name: 'Argus Dev', version: '1.0.0', supportedInterfaces: [], capabilities: {},
            defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'], skills: [],
          },
          task: { id: 'runtime-task', contextId: 'runtime-context', status: { state: 'TASK_STATE_WORKING' } },
        };
      },
      async getAgentCard() { throw new Error('unused'); },
      async listTasks() { throw new Error('unused'); },
      async getTask() { throw new Error('unused'); },
      async cancelTask() { throw new Error('unused'); },
    } satisfies A2aGateway;
    const withUser: RequestHandler = (req, _res, next) => {
      Object.assign(req, { user: {
        id: 7, username: 'entra:developer-7', display_name: 'Alex', role: 'developer',
        allowed_bundles: [7], entra_groups: ['argus-developers'],
      } });
      next();
    };
    const baseUrl = await serve(new SolutionPackRegistry([], { coreVersion: '1.0.0' }), withUser, a2a);
    const response = await fetch(`${baseUrl}/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: { operation: 'workflow.start', workflowId: 'ticket-to-pull-request', input: { ticket_id: 'ARGUS-42' } },
        execution: { bundleIds: [7], runtimeMode: 'managed-hermes' },
      }),
    });

    expect(response.status).toBe(200);
    expect(execution).toMatchObject({
      principalKind: 'user', principalId: '7', principalAllowedBundleIds: [7],
      requestedBundleIds: [7], runtimeMode: 'managed-hermes',
    });
  });

  it('allows remediation proposals without granting approval or execution', async () => {
    const withDeveloper: RequestHandler = (req, _res, next) => {
      Object.assign(req, { user: {
        id: 7, username: 'entra:developer-7', display_name: 'Alex', role: 'developer',
        allowed_bundles: [28], entra_groups: ['argus-developers'],
      } });
      next();
    };
    const executor = {
      async listCandidates() { return []; },
    } as unknown as IncidentRemediationExecutor;
    const baseUrl = await serve(
      new SolutionPackRegistry([], { coreVersion: '1.0.0' }),
      pass,
      {} as A2aGateway, undefined, undefined, undefined, undefined,
      executor,
      undefined, undefined, pass, undefined, undefined,
      withDeveloper,
    );

    const candidates = await fetch(`${baseUrl}/api/ui/observability/alerts/81/remediations/91/executor-candidates`);
    expect(candidates.status).toBe(200);
    await expect(candidates.json()).resolves.toMatchObject({ total: 0, candidates: [] });

    const approval = await fetch(`${baseUrl}/api/ui/observability/alerts/81/remediations/91/change-plans/71/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(approval.status).toBe(403);
    await expect(approval.json()).resolves.toMatchObject({ requiredPermission: 'aiops.remediation.approve' });

    const execution = await fetch(`${baseUrl}/api/ui/observability/alerts/81/remediations/91/change-plans/71/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(execution.status).toBe(403);
    await expect(execution.json()).resolves.toMatchObject({ requiredPermission: 'aiops.remediation.execute' });
  });

  it('persists and refreshes the Core-owned native-alert to AIOps task link', async () => {
    const createdAt = '2026-08-12T17:00:00.000Z';
    let record: IncidentAiopsTaskRecord | null = null;
    const store: IncidentAiopsTaskStore = {
      async incidentExists(incidentId) { return incidentId === 81; },
      async create(input) {
        record = {
          id: 1,
          incidentId: input.incidentId,
          packId: input.packId,
          agentId: input.agentId,
          taskId: input.taskId,
          rootTraceId: input.snapshot.rootTraceId ?? null,
          state: input.snapshot.state,
          quality: input.snapshot.quality ?? null,
          summary: input.snapshot.summary ?? null,
          result: input.snapshot.result ?? null,
          executionContext: {
            bundleIds: input.executionContext?.bundleIds ?? [],
            resourceScope: input.executionContext?.resourceScope ?? null,
            service: input.executionContext?.service ?? null,
            environment: input.executionContext?.environment ?? null,
            serviceProfile: input.executionContext?.serviceProfile ?? null,
            trigger: input.executionContext?.trigger ?? null,
            capturedAt: createdAt,
          },
          createdBy: input.createdBy,
          createdAt,
          updatedAt: createdAt,
        };
        return record;
      },
      async list() { return record ? [record] : []; },
      async listActive() { return record && record.state === 'TASK_STATE_WORKING' ? [record] : []; },
      async update(_id, snapshot) {
        if (!record) throw new Error('missing record');
        record = {
          ...record,
          rootTraceId: snapshot.rootTraceId ?? record.rootTraceId,
          state: snapshot.state,
          quality: snapshot.quality ?? record.quality,
          summary: snapshot.summary ?? record.summary,
          result: snapshot.result ?? record.result,
          updatedAt: '2026-08-12T17:01:00.000Z',
        };
        return record;
      },
    };
    const submitted: A2aTask = {
      id: 'aiops-task-81',
      contextId: 'context-81',
      status: { state: 'TASK_STATE_WORKING', message: { messageId: 'message-1', role: 'ROLE_AGENT', parts: [{ text: 'Collecting evidence.' }] } },
    };
    const completed: A2aTask = {
      ...submitted,
      status: { state: 'TASK_STATE_COMPLETED', message: { messageId: 'message-2', role: 'ROLE_AGENT', parts: [{ text: 'Reviewer confirmed the incident.' }] } },
      metadata: { rootTraceId: 'trace-aiops-81', quality: 'reviewed' },
      artifacts: [{ artifactId: 'evidence-1', parts: [{ data: {
        kind: 'aiops-investigation-evidence', schemaVersion: 2, generatedAt: createdAt, quality: 'reviewed',
        synthesis: 'Latency evidence points to the checkout dependency.',
        diagnosis: {
          conclusion: 'suspected', executiveAssessment: 'Latency evidence points to the checkout dependency.',
          rootCause: null, hypotheses: [], evidence: [], recommendedActions: [{
            priority: 'now', action: 'Inspect PostgreSQL saturation.',
            rationale: 'The database is on the failing request path.', requiresApproval: true,
          }],
        },
      } }] }],
    };
    const sentInputs: Array<Parameters<A2aGateway['sendMessage']>[2]> = [];
    let changePlanCalls = 0;
    const changePlanInputs: Array<Record<string, unknown>> = [];
    let remediation: IncidentRemediationRecord | null = null;
    const remediationStore: IncidentRemediationStore = {
      async syncFromInvestigation(investigation) {
        if (remediation || !investigation.result?.recommendedActions[0]) return 0;
        const action = investigation.result.recommendedActions[0];
        remediation = {
          id: 91, incidentId: investigation.incidentId, taskLinkId: investigation.id,
          taskId: investigation.taskId, rootTraceId: investigation.rootTraceId,
          sourceActionIndex: 0, priority: action.priority, action: action.action,
          rationale: action.rationale, requiresApproval: action.requiresApproval, riskLevel: 'high',
          executionMode: 'proposal_only', executorBundleId: null, executorToolName: null,
          targetScope: { kind: 'kubernetes', namespace: 'argus-demo' }, executionIntent: action.executionIntent ?? null,
          status: 'proposed', version: 1,
          createdBy: investigation.createdBy, decidedBy: null, decidedByUsername: null,
          decisionComment: null, decidedAt: null, createdAt, updatedAt: createdAt,
          events: [{ id: 1, type: 'proposed', actorUserId: investigation.createdBy, actorUsername: 'argus.aiops', comment: null, metadata: {}, createdAt }],
      dryRuns: [],
      changePlans: [],
        };
        return 1;
      },
      async listForIncident() { return remediation ? [remediation] : []; },
      async decide(input) {
        if (!remediation) throw new Error('missing remediation');
        remediation = {
          ...remediation,
          status: input.decision === 'approve' ? 'approved' : 'rejected',
          version: remediation.version + 1,
          decidedBy: input.reviewer.id,
          decidedByUsername: input.reviewer.username,
          decisionComment: input.comment,
          decidedAt: '2026-08-12T17:02:00.000Z',
          updatedAt: '2026-08-12T17:02:00.000Z',
        };
        return remediation;
      },
    };
    const remediationExecutor: IncidentRemediationExecutor = {
      async listCandidates() {
        return [{
          bundleId: 8, bundleName: 'aiops-observe', bundleLabel: 'AIOps Observe',
          toolName: 'argus_observe_get_trace', description: 'Inspect trace evidence.',
          backend: 'argus-observability', category: 'Observability', executorKind: 'native_read',
          parameters: [{
            name: 'trace_id', type: 'string', description: 'Native trace UUID', required: true,
            suggestedValue: 'trace-aiops-81', valueSource: 'incident', locked: true,
          }],
          suggestedArguments: { trace_id: 'trace-aiops-81' }, missingRequiredArguments: [],
        }];
      },
      async runDryRun(input) {
        if (!remediation) throw new Error('missing remediation');
        const dryRun = {
          id: 6, remediationId: 91, bundleId: input.bundleId, toolName: input.toolName,
          arguments: input.arguments as Record<string, string | number | boolean>, status: 'passed' as const,
          executionTraceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', resultPreview: 'trace loaded',
          errorMessage: null, redactionSummary: {}, startedBy: input.operator.id,
          startedByUsername: input.operator.username, startedAt: createdAt, completedAt: createdAt,
        };
        remediation = {
          ...remediation, executionMode: 'dry_run', executorBundleId: input.bundleId,
          executorToolName: input.toolName, version: remediation.version + 1, dryRuns: [dryRun],
        };
        return { remediation, dryRun };
      },
      async listWriteAdapters() {
        return [{
          adapterKey: 'kubernetes.scale.v1', label: 'Kubernetes workload scale',
          description: 'Scale a workload.', status: 'unavailable', reason: 'No write connector.',
          controls: {
            riskLevel: 'high', planApproval: 'hash_bound', verification: 'read_after_write',
            rollback: 'verified_restore', postChangeMonitoring: true, productionSeparationOfDuties: true,
          },
          bundleId: null, bundleLabel: null, writeBackendId: null, writeBackendName: null,
          writeToolName: null, target: null, workloadKinds: ['Deployment', 'StatefulSet'],
            replicas: { minimum: 1, maximum: 50 },
            intent: null,
        }];
      },
      async createChangePlan(input) {
        changePlanCalls += 1;
        changePlanInputs.push(input as unknown as Record<string, unknown>);
        return { remediation: remediation!, plan: remediation!.changePlans[0]! };
      },
      async decideChangePlan() { throw new Error('not used'); },
      async executeChangePlan() { throw new Error('not used'); },
      async monitorPostChange() { throw new Error('not used'); },
      async monitorDuePostChanges() { return 0; },
      async reconcileInterruptedOperations() { return { examined: 0, recovered: 0, failedClosed: 0, deferred: 0 }; },
      async decidePostChangeRollback() { throw new Error('not used'); },
      async executePostChangeRollback() { throw new Error('not used'); },
    };
    const a2a: A2aGateway = {
      async getAgentCard() { throw new Error('not used'); },
      async sendMessage(_packId, _agentId, input) {
        sentInputs.push(input);
        return {
          rootTraceId: 'trace-aiops-81',
          agentCard: {
            name: 'Argus AIOps', version: '0.1.0',
            supportedInterfaces: [{ url: 'http://argus-aiops:2030', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
            capabilities: {}, defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
            skills: [{ id: 'incident-investigation', name: 'Incident investigation' }],
          },
          task: submitted,
        };
      },
      async getTask() { return completed; },
      async listTasks() { return { tasks: [], nextCursor: null }; },
      async cancelTask() { return completed; },
    };
    const admin: RequestHandler = (req, _res, next) => {
      Object.assign(req, { user: { id: 1, username: 'Alex', role: 'platform_admin', allowed_bundles: null } });
      next();
    };
    const baseUrl = await serve(
      new SolutionPackRegistry([], { coreVersion: '1.0.0' }),
      admin,
      a2a,
      store,
      {
        async getForIncident() {
          return {
            id: 3, incidentId: 81, ruleId: 7, status: 'started', bundleIds: [8],
            resourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' },
            service: 'checkout-api', environment: 'demo', attemptCount: 1, availableAt: createdAt,
            serviceProfile: null,
            lastAttemptAt: createdAt, lastError: null, taskLinkId: 1, createdAt, updatedAt: createdAt,
          };
        },
      },
      {
        async getForIncident(incidentId) {
          return {
            incidentId, generatedAt: '2026-08-12T16:59:00.000Z', available: true, reason: null,
            service: 'checkout-api', environment: 'demo', window: { minutesBefore: 60, minutesAfter: 30 },
            summary: { upstreamServices: 1, downstreamServices: 0, externalDependencies: 1, failingDependencies: 1, observedCalls: 4, observedFailures: 4 },
            impactedServices: [], dependencies: [{
              sourceService: 'checkout-api', targetKind: 'database', targetName: 'postgresql', relation: 'queries',
              direction: 'downstream', depth: 1, path: ['checkout-api', 'postgresql'], calls: 4, failures: 4,
              failureRate: 1, p95DurationMs: 1200, lastSeenAt: createdAt,
            }],
            rootCauseCandidates: [{
              sourceService: 'checkout-api', targetKind: 'database', targetName: 'postgresql', relation: 'queries',
              direction: 'downstream', depth: 1, path: ['checkout-api', 'postgresql'], calls: 4, failures: 4,
              failureRate: 1, p95DurationMs: 1200, lastSeenAt: createdAt, confidence: 'high', reason: 'Correlated aggregate evidence.',
            }],
          };
        },
      },
      remediationStore,
      remediationExecutor,
      undefined,
      undefined,
      pass,
      undefined,
      undefined,
      admin,
    );

    const started = await fetch(`${baseUrl}/api/admin/solution-packs/argus.aiops/agents/incident-orchestrator/a2a/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Investigate incident 81',
        data: { operation: 'workflow.start', workflowId: 'incident-investigation', input: {
          title: 'Latency regression',
          labels: { team: 'checkout', 'argus.core.impact.candidate.1': 'spoofed browser evidence' },
        } },
        execution: { bundleIds: [8] },
        correlation: { nativeAlertIncidentId: 81 },
      }),
    });
    expect(started.status).toBe(200);
    expect(record).toMatchObject({
      incidentId: 81, taskId: 'aiops-task-81', rootTraceId: 'trace-aiops-81', state: 'TASK_STATE_WORKING',
      executionContext: { bundleIds: [8], resourceScope: null },
    });
    const labels = (sentInputs[0]!.data?.['input'] as Record<string, unknown>)['labels'] as Record<string, string>;
    expect(labels['team']).toBe('checkout');
    expect(labels['argus.core.impact.status']).toBe('observed');
    expect(labels['argus.core.impact.candidate.1']).toContain('target=database:postgresql');
    expect(labels['argus.core.impact.candidate.1']).not.toContain('spoofed');

    const linked = await fetch(`${baseUrl}/api/ui/observability/alerts/81/aiops-investigations`);
    expect(linked.status).toBe(200);
    await expect(linked.json()).resolves.toMatchObject({
      incidentId: 81,
      total: 1,
      investigations: [{
        taskId: 'aiops-task-81',
        state: 'TASK_STATE_COMPLETED',
        quality: 'reviewed',
        rootTraceId: 'trace-aiops-81',
        summary: 'Latency evidence points to the checkout dependency.',
        result: { conclusion: 'suspected', sourceSchemaVersion: 2 },
        statusAvailable: true,
      }],
      automation: { status: 'started', bundleIds: [8], taskLinkId: 1 },
      remediations: [{ id: 91, status: 'proposed', executionMode: 'proposal_only', executorToolName: null }],
    });

    const decided = await fetch(`${baseUrl}/api/ui/observability/alerts/81/remediations/91/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', version: 1, comment: 'Approved for a future governed dry run.' }),
    });
    expect(decided.status).toBe(200);
    await expect(decided.json()).resolves.toMatchObject({
      remediation: { id: 91, status: 'approved', version: 2, decidedByUsername: 'Alex', executionMode: 'proposal_only' },
    });

    const candidates = await fetch(`${baseUrl}/api/ui/observability/alerts/81/remediations/91/executor-candidates`);
    expect(candidates.status).toBe(200);
    await expect(candidates.json()).resolves.toMatchObject({
      total: 1,
      candidates: [{ bundleId: 8, toolName: 'argus_observe_get_trace', executorKind: 'native_read' }],
    });

    const dryRun = await fetch(`${baseUrl}/api/ui/observability/alerts/81/remediations/91/dry-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2, bundleId: 8, toolName: 'argus_observe_get_trace', arguments: { trace_id: 'trace-aiops-81' },
      }),
    });
    expect(dryRun.status).toBe(200);
    await expect(dryRun.json()).resolves.toMatchObject({
      remediation: { version: 3, executionMode: 'dry_run', executorToolName: 'argus_observe_get_trace' },
      dryRun: { status: 'passed', resultPreview: 'trace loaded' },
    });

    const writeAdapters = await fetch(`${baseUrl}/api/ui/observability/alerts/81/remediations/91/write-adapters`);
    expect(writeAdapters.status).toBe(200);
    await expect(writeAdapters.json()).resolves.toMatchObject({
      total: 1,
      adapters: [{ adapterKey: 'kubernetes.scale.v1', status: 'unavailable', reason: 'No write connector.' }],
    });

    const unknownAdapter = await fetch(`${baseUrl}/api/ui/observability/alerts/81/remediations/91/change-plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 3,
        adapterKey: 'shell.exec.v1',
        bundleId: 29,
        writeToolName: 'unsafe_exec',
        workloadKind: 'Deployment',
        workloadName: 'checkout-api',
        desiredReplicas: 3,
      }),
    });
    expect(unknownAdapter.status).toBe(400);
    await expect(unknownAdapter.json()).resolves.toMatchObject({ code: 'invalid_change_plan_request' });
    expect(changePlanCalls).toBe(0);

    const revisionAdapter = await fetch(`${baseUrl}/api/ui/observability/alerts/81/remediations/91/change-plans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 3,
        adapterKey: 'kubernetes.deployment-revision-rollback.v1',
        bundleId: 29,
        writeToolName: 'aiops_kubernetes_remediation_deployment_revision_rollback',
        workloadKind: 'Deployment',
        workloadName: 'checkout-api',
        targetRevision: 4,
      }),
    });
    expect(revisionAdapter.status).toBe(200);
    expect(changePlanCalls).toBe(1);
    expect(changePlanInputs[0]).toMatchObject({
      adapterKey: 'kubernetes.deployment-revision-rollback.v1',
      workloadKind: 'Deployment', workloadName: 'checkout-api', targetRevision: 4,
    });
  });

  it('exposes evidence-bound RCA review routes with the authenticated SSO identity', async () => {
    const review = {
      id: 51, incidentId: 81, taskLinkId: 15, taskId: 'task-aiops-81',
      rootTraceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      verdict: 'helpful' as const, reason: 'accurate_root_cause' as const, comment: null,
      reviewer: { id: 7, name: 'Alex' }, serviceProfile: { id: 12, revision: 3, sha256: 'd'.repeat(64) },
      supersedesId: null, createdAt: '2026-09-09T10:10:00.000Z',
    };
    const listImplementation: IncidentAiopsFeedbackStore['list'] = async (incidentId, taskLinkId) => ({
      generatedAt: '2026-09-09T10:10:00.000Z', incidentId, taskLinkId,
      taskId: review.taskId, rootTraceId: review.rootTraceId, serviceProfile: review.serviceProfile,
      currentUserFeedback: review, feedback: [review],
      summary: { reviews: 1, helpful: 1, partial: 0, incorrect: 0, helpfulPercent: 100, reviewedAt: review.createdAt },
    });
    const list = jest.fn(listImplementation);
    const submitImplementation: IncidentAiopsFeedbackStore['submit'] = async input => ({
      ...(await list(input.incidentId, input.taskLinkId, { userId: input.userId, allowedBundleIds: input.allowedBundleIds })),
      submitted: review,
      auditEvent: { eventId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } as never,
      replayed: false,
    });
    const submit = jest.fn(submitImplementation);
    const feedbackStore: IncidentAiopsFeedbackStore = { list, submit };
    const withSsoUser: RequestHandler = (req, _res, next) => {
      Object.assign(req, { user: {
        id: 7, username: 'entra:developer-7', display_name: 'Alex', role: 'agent_operator',
        allowed_bundles: [28], entra_groups: ['argus-operators'],
      } });
      next();
    };
    const baseUrl = await serve(
      new SolutionPackRegistry([], { coreVersion: '1.0.0' }),
      withSsoUser,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, pass, undefined,
      feedbackStore, withSsoUser,
    );

    const history = await fetch(`${baseUrl}/api/ui/observability/alerts/81/aiops-investigations/15/feedback`);
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({ currentUserFeedback: { verdict: 'helpful' }, summary: { helpfulPercent: 100 } });
    expect(list).toHaveBeenCalledWith(81, 15, { userId: 7, allowedBundleIds: [28] });

    const response = await fetch(`${baseUrl}/api/ui/observability/alerts/81/aiops-investigations/15/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'rca-review-81-15-7-v1' },
      body: JSON.stringify({ verdict: 'partial', reason: 'incomplete_evidence', comment: 'Needs one more log source.' }),
    });
    expect(response.status).toBe(201);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      incidentId: 81, taskLinkId: 15, userId: 7, allowedBundleIds: [28],
      verdict: 'partial', reason: 'incomplete_evidence', comment: 'Needs one more log source.',
      audit: expect.objectContaining({
        producerEventId: 'rca-review-81-15-7-v1',
        actor: expect.objectContaining({ id: '7', ssoSubject: 'entra:developer-7', authMethod: 'oidc' }),
      }),
    }));
  });
});
