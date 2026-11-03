import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import { AI_ACT_CONTROL_CATALOG } from '../aiActControlCatalog.js';
import {
  registerAiSystemControlRoutes,
  type AiSystemControlRouteDependencies,
} from '../aiSystemControlRoutes.js';
import type { AiSystemControlLedger } from '../aiSystemControlLedger.js';

const AI_SYSTEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVISION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ASSESSMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EVENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REVISION_SHA = '1'.repeat(64);
const NOW = new Date('2026-09-10T12:00:00.000Z');

const ledger: AiSystemControlLedger = {
  schemaVersion: 1,
  kind: 'ai-system-control-ledger',
  aiSystemId: AI_SYSTEM_ID,
  revisionId: REVISION_ID,
  revision: 1,
  revisionSha256: REVISION_SHA,
  assessmentSourceRevision: { revisionId: REVISION_ID, revision: 1, revisionSha256: REVISION_SHA, relation: 'current_revision' },
  generatedAt: NOW.toISOString(),
  catalog: AI_ACT_CONTROL_CATALOG,
  coverage: { applicable: 2, satisfied: 0, open: 2, exceptions: 0, expired: 0 },
  releaseReady: false,
  blockingReasons: ['AIA-ART5-PROHIBITED-PRACTICES: no evidence'],
  controls: AI_ACT_CONTROL_CATALOG.controls.map(definition => ({
    definition,
    applicable: definition.applicability !== 'high_risk',
    assessment: null,
    effectiveStatus: definition.applicability === 'high_risk' ? 'not_applicable' : 'not_assessed',
    expired: false,
    releaseBlocking: definition.blocksProduction && definition.applicability !== 'high_risk',
    issues: definition.applicability === 'high_risk' ? [] : ['No evidence'],
  })),
  claimBoundary: AI_ACT_CONTROL_CATALOG.claimBoundary,
};
const assessment = {
  schemaVersion: 1 as const,
  kind: 'ai-system-control-assessment' as const,
  assessmentId: ASSESSMENT_ID,
  aiSystemId: AI_SYSTEM_ID,
  revisionId: REVISION_ID,
  revision: 1,
  revisionSha256: REVISION_SHA,
  catalogId: AI_ACT_CONTROL_CATALOG.catalogId,
  catalogVersion: AI_ACT_CONTROL_CATALOG.catalogVersion,
  catalogSha256: AI_ACT_CONTROL_CATALOG.catalogSha256,
  controlId: AI_ACT_CONTROL_CATALOG.controls[0]!.controlId,
  sequence: 1,
  status: 'in_progress' as const,
  ownerParty: 'provider' as const,
  ownerId: 'legal-owner',
  dueAt: '2026-10-01T00:00:00.000Z',
  reassessmentAt: null,
  rationale: 'Implementation is in progress.',
  evidence: [],
  exception: null,
  assessedBy: { actorType: 'user' as const, actorId: '17' },
  assessedAt: NOW.toISOString(),
  assessmentSha256: '2'.repeat(64),
};

const getCatalog = jest.fn<AiSystemControlRouteDependencies['getCatalog']>();
const getLedger = jest.fn<AiSystemControlRouteDependencies['getLedger']>();
const record = jest.fn<AiSystemControlRouteDependencies['record']>();
let user: SessionUser;
let sameOrigin = true;
let freshMfa = true;
let server: Server;
let baseUrl: string;

async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
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
    (req as unknown as { user: SessionUser }).user = user;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, res, next) => {
    if (!sameOrigin) return void res.status(403).json({ error: 'origin' });
    next();
  };
  const requireFreshMfa: RequestHandler = (_req, res, next) => {
    if (!freshMfa) return void res.status(428).json({ code: 'MFA_STEP_UP_REQUIRED' });
    next();
  };
  registerAiSystemControlRoutes(
    app,
    {} as pg.Pool,
    requireAuth,
    requireSameOrigin,
    requireFreshMfa,
    600,
    { getCatalog, getLedger, record, now: () => NOW },
  );
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
}));

beforeEach(() => {
  jest.clearAllMocks();
  sameOrigin = true;
  freshMfa = true;
  user = {
    id: 17,
    username: 'oidc:alex',
    display_name: 'Alex',
    role: 'operations_admin',
    allowed_bundles: null,
    entra_groups: [],
    auth_method: 'oidc',
    mfa_verified_at: '2026-09-10T11:58:00.000Z',
    mfa_method: 'otp',
  };
  getCatalog.mockReturnValue(AI_ACT_CONTROL_CATALOG);
  getLedger.mockResolvedValue(ledger);
  record.mockResolvedValue({ ledger, assessment, replayed: false, auditEvent: { eventId: EVENT_ID } as never });
});

describe('AI-system legal control routes', () => {
  it('publishes the server-owned catalog and scoped ledger', async () => {
    const catalogResponse = await request('/api/ui/compliance/ai-control-catalog');
    const ledgerResponse = await request(`/api/ui/compliance/ai-systems/${AI_SYSTEM_ID}/controls`);

    expect(catalogResponse).toMatchObject({ status: 200, body: { catalog: { catalogSha256: AI_ACT_CONTROL_CATALOG.catalogSha256 } } });
    expect(ledgerResponse).toMatchObject({ status: 200, body: { kind: 'ai-system-control-ledger', aiSystemId: AI_SYSTEM_ID } });
    expect(getLedger).toHaveBeenCalledWith(expect.anything(), { workspaceKey: 'default', tenantKey: 'default' }, AI_SYSTEM_ID, { now: NOW });
  });

  it('uses an authorized secondary tenant scope and rejects foreign scope probes opaquely', async () => {
    user = {
      ...user,
      workspace_scopes: [
        { tenantKey: 'tenant-a', workspaceKey: 'shared', isDefault: true },
        { tenantKey: 'tenant-b', workspaceKey: 'shared', isDefault: false },
      ],
    };
    const selected = await request(`/api/ui/compliance/ai-systems/${AI_SYSTEM_ID}/controls`, 'GET', undefined, {
      'x-argus-tenant-key': 'tenant-b',
      'x-argus-workspace-key': 'shared',
    });
    expect(selected.status).toBe(200);
    expect(getLedger).toHaveBeenCalledWith(expect.anything(), { workspaceKey: 'shared', tenantKey: 'tenant-b' }, AI_SYSTEM_ID, { now: NOW });

    getLedger.mockClear();
    const foreign = await request(`/api/ui/compliance/ai-systems/${AI_SYSTEM_ID}/controls`, 'GET', undefined, {
      'x-argus-tenant-key': 'tenant-c',
      'x-argus-workspace-key': 'shared',
    });
    expect(foreign).toMatchObject({ status: 404, body: { error: { code: 'WORKSPACE_SCOPE_NOT_FOUND' } } });
    expect(getLedger).not.toHaveBeenCalled();
  });

  it('requires the named manage permission', async () => {
    user = { ...user, role: 'viewer' };
    const response = await request(`/api/ui/compliance/ai-systems/${AI_SYSTEM_ID}/controls/${assessment.controlId}/assessments`, 'POST', {
      expectedRevision: 1, expectedRevisionSha256: REVISION_SHA, status: 'in_progress',
      ownerParty: 'provider', ownerId: 'legal-owner', dueAt: null, reassessmentAt: null,
      rationale: 'Implementation is in progress.', evidence: [], exception: null,
    }, { 'idempotency-key': 'control-assessment-1' });

    expect(response.status).toBe(403);
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps same-origin, fresh MFA and idempotency in front of storage', async () => {
    const payload = {
      expectedRevision: 1, expectedRevisionSha256: REVISION_SHA, status: 'in_progress',
      ownerParty: 'provider', ownerId: 'legal-owner', dueAt: null, reassessmentAt: null,
      rationale: 'Implementation is in progress.', evidence: [], exception: null,
    };
    freshMfa = false;
    expect((await request(`/api/ui/compliance/ai-systems/${AI_SYSTEM_ID}/controls/${assessment.controlId}/assessments`, 'POST', payload, { 'idempotency-key': 'control-assessment-1' })).status).toBe(428);
    freshMfa = true;
    expect((await request(`/api/ui/compliance/ai-systems/${AI_SYSTEM_ID}/controls/${assessment.controlId}/assessments`, 'POST', payload)).body).toMatchObject({ error: { code: 'AI_CONTROL_IDEMPOTENCY_REQUIRED' } });
    sameOrigin = false;
    expect((await request(`/api/ui/compliance/ai-systems/${AI_SYSTEM_ID}/controls/${assessment.controlId}/assessments`, 'POST', payload, { 'idempotency-key': 'control-assessment-1' })).status).toBe(403);
    expect(record).not.toHaveBeenCalled();
  });

  it('records an assessment with SSO and MFA assurance', async () => {
    const response = await request(`/api/ui/compliance/ai-systems/${AI_SYSTEM_ID}/controls/${assessment.controlId}/assessments`, 'POST', {
      expectedRevision: 1, expectedRevisionSha256: REVISION_SHA, status: 'in_progress',
      ownerParty: 'provider', ownerId: 'legal-owner', dueAt: null, reassessmentAt: null,
      rationale: 'Implementation is in progress.', evidence: [], exception: null,
    }, { 'idempotency-key': 'control-assessment-1', 'x-request-id': 'request-1' });

    expect(response).toMatchObject({ status: 201, body: { kind: 'ai-system-control-assessment-result', auditEventId: EVENT_ID } });
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      producerEventId: 'control-assessment-1', requestId: 'request-1',
      mfaVerifiedAt: user.mfa_verified_at, mfaMethod: 'otp',
      actor: expect.objectContaining({ authMethod: 'oidc', ssoSubject: 'oidc:alex' }),
    }), AI_SYSTEM_ID, assessment.controlId, expect.objectContaining({ status: 'in_progress' }));
  });

  it('reserves exceptions for compliance.exception_manage', async () => {
    const response = await request(`/api/ui/compliance/ai-systems/${AI_SYSTEM_ID}/controls/${assessment.controlId}/assessments`, 'POST', {
      expectedRevision: 1, expectedRevisionSha256: REVISION_SHA, status: 'exception',
      ownerParty: 'provider', ownerId: 'legal-owner', dueAt: null, reassessmentAt: null,
      rationale: 'Independent exception review is pending.', evidence: [],
      exception: { rationale: 'Temporary constrained use.', compensatingControls: ['Mandatory human review'], expiresAt: '2026-10-01T00:00:00.000Z' },
    }, { 'idempotency-key': 'control-exception-1' });

    expect(response).toMatchObject({ status: 403, body: { error: { code: 'AI_CONTROL_EXCEPTION_FORBIDDEN' } } });
    expect(record).not.toHaveBeenCalled();
  });
});
