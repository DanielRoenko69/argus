import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import type { AuthorizedWorkspaceScope } from '../../auth/workspaceScope.js';
import { goldenPathPreflightSchema, type GoldenPathPreflight } from '../contracts.js';
import { registerGoldenPathRoutes } from '../routes.js';

let currentUser: SessionUser = {
  id: 7, username: 'viewer', display_name: 'Viewer', role: 'viewer', allowed_bundles: null, entra_groups: [],
};
let authenticated = true;
let server: Server;
let baseUrl: string;
const loadPreflight = jest.fn<(
  pool: pg.Pool,
  user: SessionUser,
  query: { mode: 'certification' | 'live_demo'; writeMode: 'read_only' | 'guarded' },
  scope?: AuthorizedWorkspaceScope,
) => Promise<GoldenPathPreflight>>();
const claimRun = jest.fn<(...args: unknown[]) => Promise<any>>();
const attachExecution = jest.fn<(...args: unknown[]) => Promise<void>>();
const failRun = jest.fn<(...args: unknown[]) => Promise<void>>();
const reloadRunRow = jest.fn<(...args: unknown[]) => Promise<any>>();
const loadRun = jest.fn<(...args: unknown[]) => Promise<any>>();
const startWorkflow = jest.fn<(...args: any[]) => Promise<{ executionId: number; traceId: string; replayed: boolean }>>();
const RUN_ID = '8b7b7ed1-df48-4f2e-b119-d913771f70dc';

const startingRow = {
  id: RUN_ID,
  workflow_execution_id: null,
  idempotency_key_sha256: '9'.repeat(64),
  status: 'starting',
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!authenticated) return void res.status(401).json({ error: 'auth' });
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  registerGoldenPathRoutes(app, {} as pg.Pool, requireAuth, {
    auditEvidenceEnabled: true,
    requireSameOrigin: (_req, _res, next) => next(),
    loadPackState: async () => ({ state: 'ready', version: '1.0.0' }),
    loadPreflight,
    claimRun,
    attachExecution,
    failRun,
    reloadRunRow,
    loadRun,
    startWorkflow,
  });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  authenticated = true;
  currentUser = { id: 7, username: 'viewer', display_name: 'Viewer', role: 'viewer', allowed_bundles: null, entra_groups: [] };
  loadPreflight.mockReset();
  loadPreflight.mockResolvedValue(goldenPathPreflightSchema.parse(JSON.parse(`{
    "schemaVersion":1,"kind":"argus.golden-path-preflight","mode":"certification","state":"ready","generatedAt":"2026-09-10T10:00:00.000Z",
    "scope":{"tenantKey":"default","workspaceKey":"default","environment":"demo"},
    "targets":{"git":{"provider":"gitea","repository":"argus/demo","issueNumber":1,"baseUrlOrigin":"http://gitea:3000","allowedOperations":["comment","add_label"],"writeScopeSha256":"${'a'.repeat(64)}"},"notification":{"provider":"slack_fixture","destination":"demo","allowedOperations":["post_message"],"writeScopeSha256":"${'b'.repeat(64)}"}},
    "runtime":{"preferred":"hermes","selected":"hermes","fallbackAllowed":true,"profileId":"1","grantSha256":"${'c'.repeat(64)}"},
    "workflow":{"id":"1","revision":"1","sha256":"${'d'.repeat(64)}","saved":true,"agent":{"id":"2","revision":"1","sha256":"${'e'.repeat(64)}"}},
    "policy":{"writeMode":"guarded","approvalRequired":true,"separationOfDutiesRequired":true,"policySha256":"${'f'.repeat(64)}","writes":["git_comment","git_add_label","slack_post_message"]},
    "checks":[${['core','argus_dev','runtime','mcp_git','mcp_notification','workflow','policy','evidence'].map(id => `{"id":"${id}","label":"${id}","required":true,"state":"ready","detail":"ready"}`).join(',')}],
    "allowedActions":["start","refresh"]
  }`)));
  claimRun.mockReset();
  claimRun.mockResolvedValue({ row: startingRow, created: true });
  attachExecution.mockReset();
  attachExecution.mockResolvedValue(undefined);
  failRun.mockReset();
  failRun.mockResolvedValue(undefined);
  reloadRunRow.mockReset();
  reloadRunRow.mockResolvedValue({ ...startingRow, workflow_execution_id: 240, status: 'running' });
  loadRun.mockReset();
  startWorkflow.mockReset();
  startWorkflow.mockResolvedValue({ executionId: 240, traceId: 'trace-240', replayed: false });
});

describe('POST /api/ui/golden-path/v1/runs', () => {
  it('requires workflows.run and a bounded Idempotency-Key', async () => {
    const forbidden = await fetch(`${baseUrl}/api/ui/golden-path/v1/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'golden-key-0001' }, body: '{}',
    });
    expect(forbidden.status).toBe(403);

    currentUser = { ...currentUser, role: 'agent_operator' };
    const missingKey = await fetch(`${baseUrl}/api/ui/golden-path/v1/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(missingKey.status).toBe(400);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('starts the existing workflow engine with only server-derived scope', async () => {
    currentUser = { ...currentUser, role: 'agent_operator' };
    const response = await fetch(`${baseUrl}/api/ui/golden-path/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'golden-key-0001' },
      body: JSON.stringify({ mode: 'certification', writeMode: 'guarded' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      kind: 'argus.golden-path-run-started', runId: RUN_ID, workflowExecutionId: 240, replayed: false,
    });
    expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 1,
      scope: { tenantKey: 'default', workspaceKey: 'default', environment: 'demo' },
      source: 'golden-path',
      mockMode: false,
      user: currentUser,
      inputs: expect.objectContaining({
        repository_owner: 'argus', repository_name: 'demo', issue_number: 1,
        notification_channel: 'demo', write_mode: 'guarded', golden_path_run_id: RUN_ID,
      }),
    }));
    expect(attachExecution).toHaveBeenCalledWith(expect.anything(), RUN_ID, 240);
  });

  it('returns the original run without executing a duplicate', async () => {
    currentUser = { ...currentUser, role: 'agent_operator' };
    claimRun.mockResolvedValue({ row: { ...startingRow, workflow_execution_id: 240, status: 'running' }, created: false });
    const response = await fetch(`${baseUrl}/api/ui/golden-path/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'golden-key-0001' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runId: RUN_ID, workflowExecutionId: 240, replayed: true });
    expect(startWorkflow).not.toHaveBeenCalled();
  });
});

describe('GET /api/ui/golden-path/v1/preflight', () => {
  it('requires authentication and workflows.read', async () => {
    authenticated = false;
    expect((await fetch(`${baseUrl}/api/ui/golden-path/v1/preflight`)).status).toBe(401);
    authenticated = true;
    currentUser = { ...currentUser, role: 'chat_user' };
    expect((await fetch(`${baseUrl}/api/ui/golden-path/v1/preflight`)).status).toBe(403);
    expect(loadPreflight).not.toHaveBeenCalled();
  });

  it('passes a bounded query and server-authenticated user to the loader', async () => {
    const response = await fetch(`${baseUrl}/api/ui/golden-path/v1/preflight?mode=certification&writeMode=guarded`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'argus.golden-path-preflight', state: 'ready' });
    expect(loadPreflight).toHaveBeenCalledWith(
      expect.anything(),
      currentUser,
      { mode: 'certification', writeMode: 'guarded' },
      { tenantKey: 'default', workspaceKey: 'default' },
    );
  });

  it('rejects unsupported modes before calling persistence', async () => {
    const response = await fetch(`${baseUrl}/api/ui/golden-path/v1/preflight?mode=mock`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'GOLDEN_PATH_PREFLIGHT_INVALID' });
    expect(loadPreflight).not.toHaveBeenCalled();
  });
});

describe('POST /api/ui/golden-path/v1/runs/:runId/retry', () => {
  it('hands a failed run to checkpoint retry without accepting replacement inputs', async () => {
    currentUser = { ...currentUser, role: 'agent_operator' };
    loadRun.mockResolvedValue({
      status: 'failed',
      workflow: { id: '17' },
      correlation: { runId: '240' },
      allowedActions: ['retry', 'open_trace'],
    });

    const response = await fetch(`${baseUrl}/api/ui/golden-path/v1/runs/${RUN_ID}/retry`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/api/workflows/17/runs/240/retry');
    expect(await response.json()).toMatchObject({
      runId: RUN_ID,
      retryOfExecutionId: 240,
      frozenInputs: true,
    });
  });

  it('rejects changed inputs before handing off to the generic retry engine', async () => {
    currentUser = { ...currentUser, role: 'agent_operator' };
    const response = await fetch(`${baseUrl}/api/ui/golden-path/v1/runs/${RUN_ID}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { issue_number: 99 } }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'GOLDEN_PATH_RETRY_INPUT_FORBIDDEN' });
    expect(loadRun).not.toHaveBeenCalled();
  });
});

describe('Golden Path tenant/workspace authorization', () => {
  it('does not reveal or load a run when a caller manipulates the requested scope', async () => {
    currentUser = {
      ...currentUser,
      role: 'agent_operator',
      workspace_scopes: [{ tenantKey: 'tenant-a', workspaceKey: 'workspace-a', isDefault: true }],
    };
    const response = await fetch(`${baseUrl}/api/ui/golden-path/v1/runs/${RUN_ID}`, {
      headers: {
        'x-argus-tenant-key': 'tenant-b',
        'x-argus-workspace-key': 'workspace-a',
      },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Workspace scope was not found.',
      code: 'WORKSPACE_SCOPE_NOT_FOUND',
    });
    expect(loadRun).not.toHaveBeenCalled();
  });

  it('passes only the authenticated membership to the scoped run store', async () => {
    currentUser = {
      ...currentUser,
      role: 'agent_operator',
      workspace_scopes: [{ tenantKey: 'tenant-a', workspaceKey: 'same-name', isDefault: true }],
    };
    loadRun.mockResolvedValue(null);
    const response = await fetch(`${baseUrl}/api/ui/golden-path/v1/runs/${RUN_ID}`);

    expect(response.status).toBe(404);
    expect(loadRun).toHaveBeenCalledWith(expect.anything(), RUN_ID, {
      tenantKey: 'tenant-a', workspaceKey: 'same-name', environment: 'demo',
    });
  });
});
