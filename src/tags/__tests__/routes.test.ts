import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../store.js', () => ({
  createWorkspaceTagAudited: jest.fn(),
  deleteWorkspaceTagAudited: jest.fn(),
  getWorkspaceTag: jest.fn(),
  listResourceTags: jest.fn(),
  listWorkspaceTags: jest.fn(),
  replaceResourceTagsAudited: jest.fn(),
  updateWorkspaceTagAudited: jest.fn(),
}));
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));

import { writeAdminAudit } from '../../lib/adminAudit.js';
import {
  createWorkspaceTagAudited,
  deleteWorkspaceTagAudited,
  getWorkspaceTag,
  listResourceTags,
  listWorkspaceTags,
  replaceResourceTagsAudited,
  updateWorkspaceTagAudited,
} from '../store.js';
import { registerTagRoutes } from '../routes.js';

const tag = {
  id: '3', slug: 'platform', label: 'Platform', color: '#7c3aed', description: '', usageCount: 0,
  createdAt: '2026-09-07T12:00:00.000Z', updatedAt: '2026-09-07T12:00:00.000Z',
};
const tagRef = { id: '3', label: 'Platform', color: '#7c3aed' };
const baseUser: SessionUser = {
  id: 17, username: 'alex', display_name: 'Alex', role: 'developer', allowed_bundles: null, entra_groups: [],
};

const mockCreate = createWorkspaceTagAudited as jest.MockedFunction<typeof createWorkspaceTagAudited>;
const mockDelete = deleteWorkspaceTagAudited as jest.MockedFunction<typeof deleteWorkspaceTagAudited>;
const mockGet = getWorkspaceTag as jest.MockedFunction<typeof getWorkspaceTag>;
const mockList = listWorkspaceTags as jest.MockedFunction<typeof listWorkspaceTags>;
const mockListResource = listResourceTags as jest.MockedFunction<typeof listResourceTags>;
const mockReplace = replaceResourceTagsAudited as jest.MockedFunction<typeof replaceResourceTagsAudited>;
const mockUpdate = updateWorkspaceTagAudited as jest.MockedFunction<typeof updateWorkspaceTagAudited>;
const mockAudit = writeAdminAudit as jest.MockedFunction<typeof writeAdminAudit>;

let authenticated = true;
let sameOrigin = true;
let currentUser = baseUser;
let server: Server;
let baseUrl: string;

async function request(path: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json() as Record<string, unknown>,
  };
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
  registerTagRoutes(app, {} as pg.Pool, requireAuth, requireSameOrigin);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  jest.clearAllMocks();
  authenticated = true;
  sameOrigin = true;
  currentUser = baseUser;
  mockList.mockResolvedValue([tag]);
  mockCreate.mockResolvedValue({ value: tag, before: null, auditEvent: {} as never, replayed: false });
  mockDelete.mockResolvedValue({ value: true, before: tag, auditEvent: {} as never, replayed: false });
  mockGet.mockResolvedValue(tag);
  mockListResource.mockResolvedValue([tagRef]);
  mockReplace.mockResolvedValue({ value: [tagRef], before: [tagRef], auditEvent: {} as never, replayed: false });
  mockUpdate.mockResolvedValue({
    value: { ...tag, label: 'Platform Core' }, before: tag, auditEvent: {} as never, replayed: false,
  });
});

describe('workspace tag routes', () => {
  it('requires both authentication and tags.read', async () => {
    authenticated = false;
    expect((await request('/api/ui/tags')).status).toBe(401);
    authenticated = true;
    currentUser = { ...baseUser, role: 'chat_user' };
    expect((await request('/api/ui/tags')).status).toBe(403);
  });

  it('returns bounded tag catalog results to a viewer', async () => {
    currentUser = { ...baseUser, role: 'viewer' };
    const response = await request('/api/ui/tags?q=platform');
    expect(response).toMatchObject({ status: 200, body: { schemaVersion: 1, tags: [tag] } });
    expect(mockList).toHaveBeenCalledWith(expect.anything(), undefined, 'platform');
  });

  it('requires tags.manage and same-origin before creating a tag', async () => {
    currentUser = { ...baseUser, role: 'agent_operator' };
    expect((await request('/api/ui/tags', 'POST', { slug: 'platform', label: 'Platform' })).status).toBe(403);
    currentUser = baseUser;
    sameOrigin = false;
    expect((await request('/api/ui/tags', 'POST', { slug: 'platform', label: 'Platform' })).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates and audits a normalized tag for a developer', async () => {
    const response = await request('/api/ui/tags', 'POST', {
      slug: ' Platform ', label: ' Platform ', color: '#AABBCC',
    });
    expect(response).toMatchObject({ status: 201, body: { schemaVersion: 1, tag } });
    expect(mockCreate).toHaveBeenCalledWith(expect.anything(), {
      slug: 'platform', label: 'Platform', color: '#aabbcc', description: '',
    }, 17, expect.objectContaining({
      environment: 'test',
      producerEventId: expect.any(String),
      actor: expect.objectContaining({ id: '17', effectiveRoles: ['developer'] }),
    }));
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'tag_created', 'mcp_workspace_tags', '3', 'Platform', null, tag,
    );
  });

  it('forwards a valid idempotency key and stable OIDC subject to canonical audit', async () => {
    currentUser = { ...baseUser, username: 'entra:stable-subject' };
    const response = await request(
      '/api/ui/tags', 'POST', { slug: 'platform', label: 'Platform' },
      { 'idempotency-key': 'tag-create-request-7', 'x-request-id': 'request-7' },
    );
    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 17,
      expect.objectContaining({
        producerEventId: 'tag-create-request-7',
        requestId: 'request-7',
        actor: expect.objectContaining({ ssoSubject: 'entra:stable-subject', authMethod: 'oidc' }),
      }),
    );
  });

  it('rejects malformed idempotency keys before running the mutation', async () => {
    const response = await request(
      '/api/ui/tags', 'POST', { slug: 'platform', label: 'Platform' },
      { 'idempotency-key': 'contains spaces and / separators' },
    );
    expect(response).toEqual({ status: 400, body: { error: 'idempotency-key header is invalid' } });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not duplicate the legacy audit row when canonical idempotency replays', async () => {
    mockCreate.mockResolvedValueOnce({ value: tag, before: null, auditEvent: {} as never, replayed: true });
    expect((await request('/api/ui/tags', 'POST', { slug: 'platform', label: 'Platform' })).status).toBe(201);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('replays a completed delete without trying to read the deleted tag first', async () => {
    mockDelete.mockResolvedValueOnce({ value: true, before: null, auditEvent: {} as never, replayed: true });
    expect((await request('/api/ui/tags/3', 'DELETE', undefined, {
      'idempotency-key': 'tag-delete-request-3',
    })).status).toBe(204);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('patches only supplied tag fields and preserves the rest', async () => {
    const response = await request('/api/ui/tags/3', 'PATCH', { label: ' Platform Core ' });
    expect(response).toMatchObject({
      status: 200,
      body: { schemaVersion: 1, tag: { ...tag, label: 'Platform Core' } },
    });
    expect(mockUpdate).toHaveBeenCalledWith(expect.anything(), '3', {
      label: 'Platform Core',
      color: '#7c3aed',
      description: '',
    }, expect.objectContaining({ producerEventId: expect.any(String) }));
  });

  it('rejects unknown resource types before calling the store', async () => {
    const response = await request('/api/ui/resources/postgres_table/42/tags');
    expect(response).toEqual({ status: 400, body: { error: 'unsupported resource type' } });
    expect(mockListResource).not.toHaveBeenCalled();
  });

  it('replaces resource tags through the audited write boundary', async () => {
    const response = await request('/api/ui/resources/workflow/42/tags', 'PUT', { tagIds: [3, 3] });
    expect(response).toMatchObject({
      status: 200,
      body: { schemaVersion: 1, resource: { type: 'workflow', id: '42' }, tags: [tagRef] },
    });
    expect(mockReplace).toHaveBeenCalledWith(
      expect.anything(), 'workflow', '42', ['3'], 17,
      expect.objectContaining({ producerEventId: expect.any(String) }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'resource_tags_replaced', 'workflow', '42', 'workflow',
      { tags: [tagRef] }, { tags: [tagRef] },
    );
  });
});
