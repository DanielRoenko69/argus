import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import { aiActComplianceDossierManifestSchema } from '../aiActContracts.js';
import {
  registerAiComplianceDossierRoutes,
  type AiComplianceDossierRouteDependencies,
} from '../aiComplianceDossierRoutes.js';

const manifest = aiActComplianceDossierManifestSchema.parse(JSON.parse(readFileSync(resolve(
  process.cwd(), 'docs/specs/ai-act-compliance/compliance-dossier-manifest.v1.fixture.json',
), 'utf8')));
const dossier = {
  manifest,
  sourceReportRunId: '70000000-0000-4000-8000-000000000001',
  verification: { state: 'valid' as const, reasons: [], sourceEvidencePackState: 'valid' as const },
};
const generated = {
  ...dossier,
  replayed: false,
  auditEvent: { eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as never,
};
let currentUser: SessionUser;
const baseUser: SessionUser = {
  id: 17, username: 'oidc:alex', display_name: 'Alex', role: 'operations_admin',
  allowed_bundles: null, entra_groups: [], auth_method: 'oidc',
  mfa_verified_at: '2026-09-09T11:58:00.000Z', mfa_method: 'otp',
};
const generate = jest.fn<AiComplianceDossierRouteDependencies['generate']>();
const get = jest.fn<AiComplianceDossierRouteDependencies['get']>();
const list = jest.fn<AiComplianceDossierRouteDependencies['list']>();
const loadArtifact = jest.fn<AiComplianceDossierRouteDependencies['loadArtifact']>();
const recordExport = jest.fn<AiComplianceDossierRouteDependencies['recordExport']>();
let server: Server;
let baseUrl: string;
let freshMfa = true;
let sameOrigin = true;

async function jsonRequest(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, res, next) => {
    if (!sameOrigin) { res.status(403).json({ error: 'origin' }); return; }
    next();
  };
  const requireFreshMfa: RequestHandler = (_req, res, next) => {
    if (!freshMfa) { res.status(428).json({ code: 'MFA_STEP_UP_REQUIRED' }); return; }
    next();
  };
  registerAiComplianceDossierRoutes(app, {} as pg.Pool, requireAuth, requireSameOrigin, requireFreshMfa, {
    generate, get, list, loadArtifact, recordExport,
    now: () => new Date('2026-09-09T12:00:00.000Z'),
    uuid: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  await new Promise<void>(resolveListen => { server = app.listen(0, '127.0.0.1', () => resolveListen()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolveClose, reject) => {
  server.close(error => error ? reject(error) : resolveClose());
}));

beforeEach(() => {
  jest.clearAllMocks();
  currentUser = baseUser;
  freshMfa = true;
  sameOrigin = true;
  generate.mockResolvedValue(generated);
  get.mockResolvedValue(dossier);
  list.mockResolvedValue([dossier]);
  loadArtifact.mockResolvedValue({
    bytes: Buffer.from('dossier-json'), filename: `argus-${manifest.dossierId}.json`,
    mediaType: 'application/json', dossier,
  });
  recordExport.mockResolvedValue({ replayed: false, eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
});

describe('AI compliance dossier routes', () => {
  const path = `/api/ui/compliance/ai-systems/${manifest.aiSystem.aiSystemId}/dossiers`;
  const input = {
    expectedRevision: manifest.aiSystem.revision,
    expectedRevisionSha256: manifest.aiSystem.revisionSha256,
    sourceReportRunId: '70000000-0000-4000-8000-000000000001',
  };

  it('requires fresh MFA, same origin and an idempotency key before generation', async () => {
    const missingKey = await jsonRequest(path, 'POST', input);
    expect(missingKey.status).toBe(400);
    expect(generate).not.toHaveBeenCalled();

    freshMfa = false;
    const staleMfa = await jsonRequest(path, 'POST', input, { 'idempotency-key': 'dossier-1' });
    expect(staleMfa.status).toBe(428);

    freshMfa = true;
    sameOrigin = false;
    const crossOrigin = await jsonRequest(path, 'POST', input, { 'idempotency-key': 'dossier-1' });
    expect(crossOrigin.status).toBe(403);
  });

  it('generates in server-authorized scope and returns canonical evidence identity', async () => {
    const response = await jsonRequest(path, 'POST', input, {
      'idempotency-key': 'dossier-1', 'x-request-id': 'request-1',
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ kind: 'ai-compliance-dossier', auditEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(generate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: expect.objectContaining({ workspaceKey: 'default', tenantKey: 'default' }),
      producerEventId: 'dossier-1', requestId: 'request-1',
      actor: expect.objectContaining({ authMethod: 'oidc', ssoSubject: 'oidc:alex' }),
    }), manifest.aiSystem.aiSystemId, input);
  });

  it('lists dossiers without exposing artifact bytes', async () => {
    const response = await jsonRequest(path);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ kind: 'ai-compliance-dossier-list', dossiers: [dossier] });
  });

  it('scopes dossier lists to authorized memberships and blocks foreign selectors before storage', async () => {
    currentUser = {
      ...baseUser,
      workspace_scopes: [
        { tenantKey: 'tenant-a', workspaceKey: 'shared', isDefault: true },
        { tenantKey: 'tenant-b', workspaceKey: 'shared', isDefault: false },
      ],
    };
    const selected = await jsonRequest(path, 'GET', undefined, {
      'x-argus-tenant-key': 'tenant-b',
      'x-argus-workspace-key': 'shared',
    });
    expect(selected.status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.anything(), { workspaceKey: 'shared', tenantKey: 'tenant-b' }, manifest.aiSystem.aiSystemId, 100);

    list.mockClear();
    const foreign = await jsonRequest(path, 'GET', undefined, {
      'x-argus-tenant-key': 'tenant-c',
      'x-argus-workspace-key': 'shared',
    });
    expect(foreign).toMatchObject({ status: 404, body: { error: { code: 'WORKSPACE_SCOPE_NOT_FOUND' } } });
    expect(list).not.toHaveBeenCalled();
  });

  it('audits a verified artifact before returning digest-bound bytes', async () => {
    const response = await fetch(`${baseUrl}/api/ui/compliance/dossiers/${manifest.dossierId}/artifacts/json`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('dossier-json');
    expect(response.headers.get('x-argus-dossier-digest')).toBe(manifest.dossierSha256);
    expect(response.headers.get('content-digest')).toMatch(/^sha-256=:/);
    expect(recordExport).toHaveBeenCalledWith(expect.anything(), dossier, 'json', expect.objectContaining({ id: '17' }), expect.stringMatching(/^dossier-export-/), expect.any(Date));
  });
});
