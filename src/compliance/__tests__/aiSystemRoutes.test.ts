import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import {
  aiActClassificationDecisionInputSchema,
  aiActCreateSystemInputSchema,
  aiActReleaseDecisionInputSchema,
  aiActRevisionDecisionInputSchema,
  aiActSystemRevisionSchema,
} from '../aiActContracts.js';
import {
  registerAiSystemRoutes,
  type AiSystemRouteDependencies,
} from '../aiSystemRoutes.js';

const revision = aiActSystemRevisionSchema.parse(JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/ai-act-compliance/ai-system-revision.v1.fixture.json',
), 'utf8')));
const createInput = aiActCreateSystemInputSchema.parse({
  displayName: revision.displayName,
  intendedPurpose: revision.intendedPurpose,
  prohibitedUses: revision.prohibitedUses,
  targetUsers: revision.targetUsers,
  affectedGroups: revision.affectedGroups,
  regions: revision.regions,
  marketRoles: revision.marketRoles.map(role => ({
    role: role.role,
    organisationId: role.organisationId,
    organisationName: role.organisationName,
    rationale: role.rationale,
  })),
  prohibitedPracticeCheck: {
    decision: revision.prohibitedPracticeCheck.decision,
    articleRefs: revision.prohibitedPracticeCheck.articleRefs,
    rationale: revision.prohibitedPracticeCheck.rationale,
  },
  classification: {
    classification: revision.classification.classification,
    articleRefs: revision.classification.articleRefs,
    annexRefs: revision.classification.annexRefs,
    rationale: revision.classification.rationale,
    legalReviewRequired: revision.classification.legalReviewRequired,
    nextReviewAt: revision.classification.nextReviewAt,
  },
  componentBindings: revision.componentBindings,
  dataCategories: revision.dataCategories,
  controlCatalog: revision.controlCatalog,
});
const listItem = {
  aiSystemId: revision.aiSystemId,
  revisionId: revision.revisionId,
  revision: revision.revision,
  revisionSha256: revision.revisionSha256,
  displayName: revision.displayName,
  lifecycleState: revision.lifecycleState,
  classification: revision.classification.classification,
  owner: revision.owner,
  marketRoles: revision.marketRoles.map(role => role.role),
  componentCount: revision.componentBindings.length,
  createdAt: revision.createdAt,
  releasedAt: revision.releasedAt,
};
const auditEvent = { eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as never;
const decisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const revisionInput = aiActRevisionDecisionInputSchema.parse({
  expectedRevision: revision.revision,
  expectedRevisionSha256: revision.revisionSha256,
  changeSummary: 'Bind a newly certified workflow revision.',
  displayName: revision.displayName,
  intendedPurpose: revision.intendedPurpose,
  prohibitedUses: revision.prohibitedUses,
  targetUsers: revision.targetUsers,
  affectedGroups: revision.affectedGroups,
  regions: revision.regions,
  marketRoles: revision.marketRoles.map(({ confirmedBy: _confirmedBy, confirmedAt: _confirmedAt, ...role }) => role),
  componentBindings: revision.componentBindings,
  dataCategories: revision.dataCategories,
  controlCatalog: revision.controlCatalog,
});
const classificationInput = aiActClassificationDecisionInputSchema.parse({
  expectedRevision: revision.revision,
  expectedRevisionSha256: revision.revisionSha256,
  prohibitedPracticeCheck: {
    decision: revision.prohibitedPracticeCheck.decision,
    articleRefs: revision.prohibitedPracticeCheck.articleRefs,
    rationale: revision.prohibitedPracticeCheck.rationale,
  },
  classification: {
    classification: revision.classification.classification,
    articleRefs: revision.classification.articleRefs,
    annexRefs: revision.classification.annexRefs,
    rationale: revision.classification.rationale,
    legalReviewRequired: revision.classification.legalReviewRequired,
    nextReviewAt: revision.classification.nextReviewAt,
  },
});
const releaseInput = aiActReleaseDecisionInputSchema.parse({
  expectedRevision: revision.revision,
  expectedRevisionSha256: revision.revisionSha256,
  decisionRationale: 'Independent evidence review completed.',
  evidence: [{
    evidenceType: 'canonical_event',
    evidenceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    sha256: '7'.repeat(64),
  }],
});
const baseUser: SessionUser = {
  id: 17,
  username: 'oidc:alex',
  display_name: 'Alex',
  role: 'operations_admin',
  allowed_bundles: null,
  entra_groups: [],
  auth_method: 'oidc',
  mfa_verified_at: '2026-09-09T11:58:00.000Z',
  mfa_method: 'otp',
};

const list = jest.fn<AiSystemRouteDependencies['list']>();
const getRevision = jest.fn<AiSystemRouteDependencies['getRevision']>();
const create = jest.fn<AiSystemRouteDependencies['create']>();
const revise = jest.fn<AiSystemRouteDependencies['revise']>();
const classify = jest.fn<AiSystemRouteDependencies['classify']>();
const release = jest.fn<AiSystemRouteDependencies['release']>();
const listTags = jest.fn<AiSystemRouteDependencies['listTags']>();
const evaluateReadiness = jest.fn<AiSystemRouteDependencies['evaluateReadiness']>();
const getWorkflowBinding = jest.fn<AiSystemRouteDependencies['getWorkflowBinding']>();
const configureWorkflowBinding = jest.fn<AiSystemRouteDependencies['configureWorkflowBinding']>();
let currentUser = baseUser;
let authenticated = true;
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
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!authenticated) {
      res.status(401).json({ error: 'auth' });
      return;
    }
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, res, next) => {
    if (!sameOrigin) {
      res.status(403).json({ error: 'origin' });
      return;
    }
    next();
  };
  const requireFreshMfa: RequestHandler = (_req, res, next) => {
    if (!freshMfa) {
      res.status(428).json({ code: 'MFA_STEP_UP_REQUIRED' });
      return;
    }
    next();
  };
  registerAiSystemRoutes(app, {} as pg.Pool, requireAuth, requireSameOrigin, {
    list,
    getRevision,
    create,
    revise,
    classify,
    release,
    listTags,
    evaluateReadiness,
    getWorkflowBinding,
    configureWorkflowBinding,
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  }, {
    requireFreshMfa,
    mfaMaxAgeSeconds: 600,
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
  authenticated = true;
  sameOrigin = true;
  freshMfa = true;
  currentUser = baseUser;
  list.mockResolvedValue([listItem]);
  getRevision.mockResolvedValue(revision);
  create.mockResolvedValue({ value: revision, replayed: false, auditEvent });
  revise.mockResolvedValue({ value: revision, decisionId, replayed: false, auditEvent });
  classify.mockResolvedValue({ value: revision, decisionId, replayed: false, auditEvent });
  release.mockResolvedValue({ value: revision, decisionId, replayed: false, auditEvent });
  listTags.mockResolvedValue([{ id: '1', label: 'Regulated', color: '#7c3aed' }]);
  evaluateReadiness.mockImplementation((value, options) => ({
    schemaVersion: 1,
    kind: 'ai-system-registration-readiness',
    aiSystemId: value.aiSystemId,
    revisionId: value.revisionId,
    state: value.lifecycleState,
    generatedAt: options?.now?.toISOString() ?? '2026-09-09T12:00:00.000Z',
    evidenceCoverage: { applicable: 0, satisfied: 0, blocked: 0, notAssessed: 0, expiring: 0 },
    steps: [
      'identity', 'intended_purpose', 'market_roles', 'prohibited_practices',
      'classification', 'components', 'controls', 'independent_review',
    ].map(stepId => ({
      stepId,
      title: stepId,
      status: 'complete',
      blocking: false,
      issues: [],
      action: null,
    })) as never,
    customerResponsibilities: [],
    allowedActions: options?.allowedActions ?? [],
    claimBoundary: 'Not a legal conformity decision.',
  }));
  getWorkflowBinding.mockResolvedValue({
    workflowId: 42,
    workflowName: 'governed_coding',
    lifecycleStatus: 'draft',
    governed: true,
    aiSystemId: revision.aiSystemId,
    aiSystemRevision: revision.revision,
  });
  configureWorkflowBinding.mockResolvedValue({
    value: {
      workflowId: 42,
      workflowName: 'governed_coding',
      lifecycleStatus: 'draft',
      governed: true,
      aiSystemId: revision.aiSystemId,
      aiSystemRevision: revision.revision,
    },
    replayed: false,
    auditEvent,
  });
});

describe('AI-system registry routes', () => {
  it('lets a viewer read the scoped registry without mutation actions', async () => {
    currentUser = { ...baseUser, role: 'viewer' };
    const response = await request('/api/ui/compliance/ai-systems');

    expect(response).toMatchObject({
      status: 200,
      body: {
        kind: 'ai-system-registry-list',
        aiSystems: [{ aiSystemId: revision.aiSystemId, allowedActions: ['read', 'view_control_gaps'] }],
      },
    });
    expect(list).toHaveBeenCalledWith(expect.anything(), { workspaceKey: 'default', tenantKey: 'default' }, 100);
  });

  it('selects only a server-authorized tenant scope and hides foreign selectors', async () => {
    currentUser = {
      ...baseUser,
      workspace_scopes: [
        { tenantKey: 'tenant-a', workspaceKey: 'shared', isDefault: true },
        { tenantKey: 'tenant-b', workspaceKey: 'shared', isDefault: false },
      ],
    };

    const selected = await request('/api/ui/compliance/ai-systems', 'GET', undefined, {
      'x-argus-tenant-key': 'tenant-b',
      'x-argus-workspace-key': 'shared',
    });
    expect(selected.status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.anything(), { workspaceKey: 'shared', tenantKey: 'tenant-b' }, 100);
    expect(listTags).toHaveBeenCalledWith(expect.anything(), 'ai_system', revision.aiSystemId, 'shared');

    jest.clearAllMocks();
    const foreign = await request('/api/ui/compliance/ai-systems', 'GET', undefined, {
      'x-argus-tenant-key': 'tenant-c',
      'x-argus-workspace-key': 'shared',
    });
    expect(foreign).toMatchObject({
      status: 404,
      body: { error: { code: 'WORKSPACE_SCOPE_NOT_FOUND' } },
    });
    expect(list).not.toHaveBeenCalled();
    expect(listTags).not.toHaveBeenCalled();
  });

  it('keeps legacy global workflow bindings fail-closed outside default/default', async () => {
    currentUser = {
      ...baseUser,
      workspace_scopes: [{ tenantKey: 'tenant-a', workspaceKey: 'shared', isDefault: true }],
    };

    const response = await request('/api/ui/compliance/workflows/42/ai-system-binding');
    expect(response).toMatchObject({
      status: 404,
      body: { error: { code: 'WORKSPACE_SCOPE_NOT_FOUND' } },
    });
    expect(getWorkflowBinding).not.toHaveBeenCalled();
  });

  it('requires ai_system.create before accepting a registry mutation', async () => {
    currentUser = { ...baseUser, role: 'viewer' };
    const response = await request('/api/ui/compliance/ai-systems', 'POST', createInput);

    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('validates and creates an immutable first revision with SSO actor context', async () => {
    const response = await request('/api/ui/compliance/ai-systems', 'POST', createInput, {
      'idempotency-key': 'ai-system-create-1',
      'x-request-id': 'request-1',
    });

    expect(response).toMatchObject({
      status: 201,
      body: {
        kind: 'ai-system-registry-detail',
        auditEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        replayed: false,
      },
    });
    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: { workspaceKey: 'default', tenantKey: 'default', environment: expect.any(String) },
      actor: expect.objectContaining({ id: '17', authMethod: 'oidc', ssoSubject: 'oidc:alex' }),
      producerEventId: 'ai-system-create-1',
      requestId: 'request-1',
    }), createInput);
  });

  it('returns a detail projection and rejects invalid identities before storage', async () => {
    const detail = await request(`/api/ui/compliance/ai-systems/${revision.aiSystemId}`);
    expect(detail).toMatchObject({
      status: 200,
      body: { aiSystem: { revision: { aiSystemId: revision.aiSystemId }, tags: [{ label: 'Regulated' }] } },
    });

    const invalid = await request('/api/ui/compliance/ai-systems/not-a-uuid');
    expect(invalid).toMatchObject({ status: 400, body: { error: { code: 'validation_failed' } } });
    expect(getRevision).toHaveBeenCalledTimes(1);
  });

  it('keeps same-origin protection in front of the create handler', async () => {
    sameOrigin = false;
    const response = await request('/api/ui/compliance/ai-systems', 'POST', createInput);
    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('reads and configures the governed workflow binding through named permissions', async () => {
    const read = await request('/api/ui/compliance/workflows/42/ai-system-binding');
    expect(read).toMatchObject({
      status: 200,
      body: { kind: 'workflow-ai-system-binding', binding: { workflowId: 42, governed: true } },
    });

    const write = await request('/api/ui/compliance/workflows/42/ai-system-binding', 'PUT', {
      governed: true,
      aiSystemId: revision.aiSystemId,
      aiSystemRevision: revision.revision,
    }, { 'idempotency-key': 'workflow-binding-42' });
    expect(write).toMatchObject({
      status: 201,
      body: { kind: 'workflow-ai-system-binding', replayed: false },
    });
    expect(configureWorkflowBinding).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      producerEventId: 'workflow-binding-42',
      actor: expect.objectContaining({ authMethod: 'oidc', id: '17' }),
    }), expect.objectContaining({ workflowId: 42, governed: true }));
  });

  it('does not let a viewer change workflow governance', async () => {
    currentUser = { ...baseUser, role: 'viewer' };
    const response = await request('/api/ui/compliance/workflows/42/ai-system-binding', 'PUT', {
      governed: false,
      aiSystemId: null,
      aiSystemRevision: null,
    });
    expect(response.status).toBe(403);
    expect(configureWorkflowBinding).not.toHaveBeenCalled();
  });

  it('requires named manage permission, same-origin, fresh MFA and idempotency for revisions', async () => {
    freshMfa = false;
    const deniedMfa = await request(
      `/api/ui/compliance/ai-systems/${revision.aiSystemId}/revisions`,
      'POST',
      revisionInput,
      { 'idempotency-key': 'revise-1' },
    );
    expect(deniedMfa.status).toBe(428);
    expect(revise).not.toHaveBeenCalled();

    freshMfa = true;
    const missingKey = await request(
      `/api/ui/compliance/ai-systems/${revision.aiSystemId}/revisions`,
      'POST',
      revisionInput,
    );
    expect(missingKey).toMatchObject({
      status: 400,
      body: { error: { code: 'AI_SYSTEM_IDEMPOTENCY_REQUIRED' } },
    });

    const accepted = await request(
      `/api/ui/compliance/ai-systems/${revision.aiSystemId}/revisions`,
      'POST',
      revisionInput,
      { 'idempotency-key': 'revise-1', 'x-request-id': 'revise-request-1' },
    );
    expect(accepted).toMatchObject({ status: 201, body: { decisionId, replayed: false } });
    expect(revise).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      producerEventId: 'revise-1',
      mfaVerifiedAt: baseUser.mfa_verified_at,
      mfaMethod: baseUser.mfa_method,
      mfaMaxAgeSeconds: 600,
      actor: expect.objectContaining({ authMethod: 'oidc', ssoSubject: 'oidc:alex' }),
    }), revision.aiSystemId, revisionInput);
  });

  it('keeps classification and release behind their separate named permissions', async () => {
    const denied = await request(
      `/api/ui/compliance/ai-systems/${revision.aiSystemId}/classifications`,
      'POST',
      classificationInput,
      { 'idempotency-key': 'classify-1' },
    );
    expect(denied.status).toBe(403);
    expect(classify).not.toHaveBeenCalled();

    currentUser = { ...baseUser, role: 'platform_admin' };
    const classification = await request(
      `/api/ui/compliance/ai-systems/${revision.aiSystemId}/classifications`,
      'POST',
      classificationInput,
      { 'idempotency-key': 'classify-1' },
    );
    const releaseResponse = await request(
      `/api/ui/compliance/ai-systems/${revision.aiSystemId}/release`,
      'POST',
      releaseInput,
      { 'idempotency-key': 'release-1' },
    );
    expect(classification.status).toBe(201);
    expect(releaseResponse.status).toBe(201);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
