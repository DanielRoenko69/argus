import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import type { ToolFilterRow } from '../../filters/toolFilters.js';

jest.mock('../../filters/toolFilters.js', () => ({
  createToolFilterAudited: jest.fn(),
  deleteToolFilterAudited: jest.fn(),
  getToolFilter: jest.fn(),
  loadAllToolFilters: jest.fn(),
  loadToolFilters: jest.fn(),
  setToolFilters: jest.fn(),
  testToolFilter: jest.fn(),
  updateToolFilterAudited: jest.fn(),
  ToolFilterMutationError: class extends Error {},
}));
jest.mock('../../agents/hooks/index.js', () => ({
  listHooks: jest.fn(() => [
    { name: 'destructive-cmd-guard', priority: 100, description: 'Blocks destructive commands' },
    { name: 'external-policy-filter', priority: 800, description: 'External policies' },
  ]),
}));
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class { async isAllowed() { return true; } cleanup() { /* no-op */ } },
}));

import { writeAdminAudit } from '../../lib/adminAudit.js';
import {
  createToolFilterAudited,
  deleteToolFilterAudited,
  getToolFilter,
  loadAllToolFilters,
  loadToolFilters,
  setToolFilters,
  testToolFilter,
  updateToolFilterAudited,
} from '../../filters/toolFilters.js';
import { registerConsoleApi } from '../consoleApi.js';

const admin: SessionUser = {
  id: 7, username: 'admin', display_name: 'Admin', role: 'platform_admin', allowed_bundles: null, entra_groups: [],
};
const policy: ToolFilterRow = {
  id: 11, name: 'change_freeze', description: 'Blocks production changes',
  webhook_url: 'https://policy.example.test/decide', hmac_secret: 'enc:v1:ciphertext',
  timeout_ms: 2500, tool_patterns: ['terraform_*'], enabled: true, on_timeout: 'deny',
  created_at: '2026-08-01T10:00:00.000Z', updated_at: '2026-08-01T11:00:00.000Z',
};

const mockCreate = createToolFilterAudited as jest.MockedFunction<typeof createToolFilterAudited>;
const mockDelete = deleteToolFilterAudited as jest.MockedFunction<typeof deleteToolFilterAudited>;
const mockGet = getToolFilter as jest.MockedFunction<typeof getToolFilter>;
const mockList = loadAllToolFilters as jest.MockedFunction<typeof loadAllToolFilters>;
const mockLoadActive = loadToolFilters as jest.MockedFunction<typeof loadToolFilters>;
const mockSet = setToolFilters as jest.MockedFunction<typeof setToolFilters>;
const mockTest = testToolFilter as jest.MockedFunction<typeof testToolFilter>;
const mockUpdate = updateToolFilterAudited as jest.MockedFunction<typeof updateToolFilterAudited>;
const mockAudit = writeAdminAudit as jest.MockedFunction<typeof writeAdminAudit>;
const startRuntimeAuthSession = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
const loadRuntimeAuthSession = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
const submitRuntimeAuthCode = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
const cancelRuntimeAuthSession = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();

let authenticated = true;
let sameOriginAllowed = true;
let currentUser = admin;
let sameOriginCalls = 0;
let server: Server;
let baseUrl: string;
const pool = {} as pg.Pool;

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!authenticated) { res.status(401).json({ error: 'auth' }); return; }
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, res, next) => {
    sameOriginCalls += 1;
    if (!sameOriginAllowed) { res.status(403).json({ error: 'origin' }); return; }
    next();
  };
  registerConsoleApi(app, {
    pool, requireAuth, requireSameOrigin,
    loadStatus: jest.fn(async () => ({})), listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined), refreshDynamicTools: jest.fn(async () => undefined),
    startRuntimeAuthSession, loadRuntimeAuthSession, submitRuntimeAuthCode, cancelRuntimeAuthSession,
    publicWidgetEnabled: true,
  } as unknown as Parameters<typeof registerConsoleApi>[1]);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  jest.clearAllMocks();
  authenticated = true;
  sameOriginAllowed = true;
  currentUser = admin;
  sameOriginCalls = 0;
  mockList.mockResolvedValue([policy]);
  mockLoadActive.mockResolvedValue([policy]);
  mockGet.mockResolvedValue(policy);
  const auditedPolicy = { value: policy, auditEvent: { eventId: 'audit-policy-11' }, replayed: false };
  mockCreate.mockResolvedValue(auditedPolicy as never);
  mockUpdate.mockResolvedValue(auditedPolicy as never);
  mockDelete.mockResolvedValue(auditedPolicy as never);
  mockTest.mockResolvedValue({
    reachable: true, status: 200, ok: true, decision: 'deny', reason: 'change freeze',
    latencyMs: 12, signed: true, responsePreview: '{"allow":false}',
  });
  const runtimeSession = {
    id: '11111111-1111-4111-8111-111111111111', provider: 'codex', state: 'waiting_for_user',
    verificationUri: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345',
  };
  startRuntimeAuthSession.mockResolvedValue(runtimeSession);
  loadRuntimeAuthSession.mockResolvedValue(runtimeSession);
  submitRuntimeAuthCode.mockResolvedValue({ ...runtimeSession, provider: 'claude-code', state: 'code_submitted', userCode: null });
  cancelRuntimeAuthSession.mockResolvedValue({ ...runtimeSession, state: 'canceled' });
});

describe('native runtime control routes', () => {
  it('returns the ordered hook chain and redacts encrypted policy secrets', async () => {
    const response = await request('/api/ui/runtime-controls');
    expect(response.status).toBe(200);
    expect(response.body['hooks']).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'external-policy-filter', priority: 800, kind: 'external' }),
    ]));
    expect(response.body['policies']).toEqual([
      expect.objectContaining({ id: 11, name: 'change_freeze', hasHmacSecret: true }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain('ciphertext');
    expect(JSON.stringify(response.body)).not.toContain('hmac_secret');
  });

  it('requires platform-admin access', async () => {
    currentUser = { ...admin, role: 'viewer' };
    expect((await request('/api/ui/runtime-controls')).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('enforces same-origin before policy mutation', async () => {
    sameOriginAllowed = false;
    const response = await request('/api/ui/runtime-controls/policies', 'POST', {
      name: 'new_policy', webhookUrl: 'https://policy.example.test/decide', secretAction: 'clear',
    });
    expect(response.status).toBe(403);
    expect(sameOriginCalls).toBe(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('enforces same-origin before runtime approval decisions', async () => {
    sameOriginAllowed = false;
    const response = await request('/api/ui/governance/runtime-approvals/1/approve', 'POST', {});

    expect(response.status).toBe(403);
    expect(sameOriginCalls).toBe(1);
  });

  it('creates fail-closed policies and audits only the safe projection', async () => {
    const response = await request('/api/ui/runtime-controls/policies', 'POST', {
      name: 'change_freeze', webhookUrl: 'https://policy.example.test/decide',
      secretAction: 'replace', hmacSecret: 'new-plaintext-secret', toolPatterns: ['terraform_*'],
    });
    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(pool, expect.objectContaining({
      name: 'change_freeze', on_timeout: 'deny', hmac_secret: 'new-plaintext-secret', enabled: true,
    }), expect.objectContaining({ actor: expect.objectContaining({ id: '7' }) }));
    expect(mockSet).toHaveBeenCalledWith([policy]);
    expect(mockAudit).toHaveBeenCalledWith(
      pool, expect.anything(), 'created', 'mcp_tool_filters', '11', 'change_freeze', null,
      expect.objectContaining({ hasHmacSecret: true }),
    );
    expect(JSON.stringify(mockAudit.mock.calls[0]?.[7])).not.toContain('new-plaintext-secret');
  });

  it('keeps the secret unless replace or clear is explicit', async () => {
    const response = await request('/api/ui/runtime-controls/policies/11', 'PUT', { enabled: false });
    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      pool, 11, { enabled: false }, expect.objectContaining({ actor: expect.objectContaining({ id: '7' }) }),
    );
  });

  it('uses the signed runtime test path and excludes response content from audit evidence', async () => {
    const response = await request('/api/ui/runtime-controls/policies/11/test', 'POST', {
      toolName: 'terraform_apply', args: { workspace: 'prod' },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ decision: 'deny', signed: true });
    expect(mockTest).toHaveBeenCalledWith(policy, 'terraform_apply', { workspace: 'prod' });
    expect(mockAudit).toHaveBeenCalledWith(
      pool, expect.anything(), 'tested', 'mcp_tool_filters', '11', 'change_freeze', null,
      expect.not.objectContaining({ responsePreview: expect.anything() }),
    );
  });

  it('deletes with before-state evidence', async () => {
    expect((await request('/api/ui/runtime-controls/policies/11', 'DELETE')).status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith(
      pool, 11, expect.objectContaining({ actor: expect.objectContaining({ id: '7' }) }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      pool, expect.anything(), 'deleted', 'mcp_tool_filters', '11', 'change_freeze',
      expect.objectContaining({ hasHmacSecret: true }), null,
    );
  });

  it('allows an idempotent delete replay after the policy row is gone', async () => {
    mockGet.mockResolvedValueOnce(null);
    mockDelete.mockResolvedValueOnce({
      value: null,
      auditEvent: { eventId: 'audit-policy-delete-11' },
      replayed: true,
    } as never);

    const response = await request('/api/ui/runtime-controls/policies/11', 'DELETE');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      deleted: true,
      replayed: true,
      auditEventId: 'audit-policy-delete-11',
    });
    expect(mockDelete).toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('starts a same-origin platform-admin runtime login and audits only session metadata', async () => {
    const response = await request('/api/ui/runtime/codex/auth/sessions', 'POST', { sso: true });

    expect(response.status).toBe(201);
    expect(startRuntimeAuthSession).toHaveBeenCalledWith('codex', { sso: true });
    expect(sameOriginCalls).toBe(1);
    expect(mockAudit).toHaveBeenCalledWith(
      pool, expect.anything(), 'authentication_started', 'agent_runtime_profiles', 'codex', 'codex', null,
      expect.objectContaining({ sessionId: '11111111-1111-4111-8111-111111111111', provider: 'codex' }),
    );
  });

  it('passes a Claude code to the workspace without putting it in audit evidence', async () => {
    const secretCode = 'temporary-provider-code';
    const response = await request(
      '/api/ui/runtime/claude-code/auth/sessions/11111111-1111-4111-8111-111111111111/code',
      'POST',
      { code: secretCode },
    );

    expect(response.status).toBe(202);
    expect(submitRuntimeAuthCode).toHaveBeenCalledWith(
      'claude-code', '11111111-1111-4111-8111-111111111111', secretCode,
    );
    expect(JSON.stringify(mockAudit.mock.calls.at(-1)?.[7])).not.toContain(secretCode);
  });

  it('rejects control characters before a runtime authorization code reaches the workspace', async () => {
    const response = await request(
      '/api/ui/runtime/claude-code/auth/sessions/11111111-1111-4111-8111-111111111111/code',
      'POST',
      { code: 'provider-code\nsecond-line' },
    );

    expect(response.status).toBe(400);
    expect(submitRuntimeAuthCode).not.toHaveBeenCalled();
  });

  it('prevents non-admins from opening shared runtime authentication', async () => {
    currentUser = { ...admin, role: 'developer' };
    expect((await request('/api/ui/runtime/codex/auth/sessions', 'POST', {})).status).toBe(403);
    expect(startRuntimeAuthSession).not.toHaveBeenCalled();
  });
});
