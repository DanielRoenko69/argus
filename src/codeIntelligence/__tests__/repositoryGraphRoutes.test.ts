import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import { registerRepositoryGraphRoutes } from '../repositoryGraphRoutes.js';
import type { RepositoryGraphDataSource } from '../repositoryGraphStore.js';

let authenticated = true;
let currentUser: SessionUser = {
  id: 7, username: 'viewer', display_name: 'Viewer', role: 'viewer', allowed_bundles: [3], entra_groups: [],
};
let authorized = true;
let server: Server;
let baseUrl: string;

const loadAuthorizedSnapshot = jest.fn<RepositoryGraphDataSource['loadAuthorizedSnapshot']>();
const resolveSeedNodes = jest.fn<RepositoryGraphDataSource['resolveSeedNodes']>();
const resolveKnownEdgeTypes = jest.fn<RepositoryGraphDataSource['resolveKnownEdgeTypes']>();
const expand = jest.fn<RepositoryGraphDataSource['expand']>();
const loadArchitectureOverview = jest.fn<RepositoryGraphDataSource['loadArchitectureOverview']>();
const loadFullGraph = jest.fn<RepositoryGraphDataSource['loadFullGraph']>();
const dataSource: RepositoryGraphDataSource = { loadAuthorizedSnapshot, resolveSeedNodes, resolveKnownEdgeTypes, expand, loadArchitectureOverview, loadFullGraph };

beforeAll(async () => {
  const app = express();
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!authenticated) {
      res.status(401).json({ error: 'auth' });
      return;
    }
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  registerRepositoryGraphRoutes(app, {} as pg.Pool, requireAuth, { enabled: true, source: dataSource });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  jest.clearAllMocks();
  authenticated = true;
  authorized = true;
  currentUser = {
    id: 7, username: 'viewer', display_name: 'Viewer', role: 'viewer', allowed_bundles: [3], entra_groups: [],
  };
  loadAuthorizedSnapshot.mockImplementation(async (_id, bundleIds) => authorized && bundleIds?.includes(3) ? {
    id: '42', repository: 'org/private', branch: 'main', commitSha: 'a'.repeat(40),
    graphDigest: `sha256:${'b'.repeat(64)}`, provider: 'graphify', parserVersion: null,
    schemaVersion: 'argus-graphify-v3', status: 'ready', immutable: true,
  } : null);
  resolveKnownEdgeTypes.mockImplementation(async (_snapshotId, requested) => requested.filter(type => type === 'declares'));
  resolveSeedNodes.mockResolvedValue([
    { id: 'file:1', type: 'file', label: 'index.ts', href: null, metadata: { path: 'src/index.ts' } },
  ]);
  expand.mockResolvedValue({ nodes: [], edges: [], truncated: false });
  loadArchitectureOverview.mockResolvedValue({
    totals: { files: 10, symbols: 50, edges: 80, documents: 60, testFiles: 2, modules: 2, dependencies: 1 },
    modules: [{ id: 'module:c3Jj', path: 'src', fileCount: 8, symbolCount: 48, documentCount: 55, testFileCount: 2, languages: { typescript: 8 } }],
    dependencies: [],
    truncated: false,
  });
  loadFullGraph.mockResolvedValue({
    files: [{ id: '1', path: 'src/index.ts', language: 'typescript', module: 'src' }],
    symbols: [{ id: '11', fileId: '1', label: 'start', kind: 'function', startLine: 1, endLine: 3 }],
    edges: [],
    truncated: false,
    truncationReasons: [],
  });
});

describe('GET repository snapshot graph', () => {
  it('serves the authorized architecture overview without a client-supplied graph query', async () => {
    const response = await fetch(`${baseUrl}/api/ui/knowledge/repository-snapshots/42/overview`);
    expect(response.status).toBe(200);
    expect(loadAuthorizedSnapshot).toHaveBeenCalledWith(42, [3]);
    expect(loadArchitectureOverview).toHaveBeenCalledWith(42);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      snapshot: { id: '42', repository: 'org/private' },
      totals: { modules: 2, testFiles: 2 },
      modules: [{ path: 'src' }],
    });
  });

  it('requires authentication and repository_graph.read', async () => {
    authenticated = false;
    expect((await fetch(`${baseUrl}/api/ui/knowledge/repository-snapshots/42/graph?seed=file:1`)).status).toBe(401);
    authenticated = true;
    currentUser = { ...currentUser, role: 'chat_user' };
    expect((await fetch(`${baseUrl}/api/ui/knowledge/repository-snapshots/42/graph?seed=file:1`)).status).toBe(403);
    expect(loadAuthorizedSnapshot).not.toHaveBeenCalled();
  });

  it('passes the authenticated bundle scope into snapshot authorization', async () => {
    const response = await fetch(`${baseUrl}/api/ui/knowledge/repository-snapshots/42/graph?seed=file:1&depth=0`);
    expect(response.status).toBe(200);
    expect(loadAuthorizedSnapshot).toHaveBeenCalledWith(42, [3]);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      snapshot: { id: '42', repository: 'org/private', immutable: true },
      nodes: [{ id: 'file:1' }],
    });
  });

  it('serves one compact complete-graph payload behind the same authorization boundary', async () => {
    const response = await fetch(`${baseUrl}/api/ui/knowledge/repository-snapshots/42/full-graph`);
    expect(response.status).toBe(200);
    expect(loadAuthorizedSnapshot).toHaveBeenCalledWith(42, [3]);
    expect(loadFullGraph).toHaveBeenCalledWith(42, { maxNodes: 50_000, maxEdges: 150_000 });
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      files: [['1', 'src/index.ts', 'typescript', 'src']],
      symbols: [['11', 'start', 'function', 0, 1, 3]],
      truncated: false,
      appliedLimits: { returnedNodes: 2, returnedEdges: 1 },
    });
  });

  it('returns the same not-found shape for unauthorized and absent snapshot ids', async () => {
    authorized = false;
    const unauthorized = await fetch(`${baseUrl}/api/ui/knowledge/repository-snapshots/42/graph?seed=file:1`);
    const absent = await fetch(`${baseUrl}/api/ui/knowledge/repository-snapshots/999/graph?seed=file:1`);
    expect(unauthorized.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await unauthorized.json()).toEqual(await absent.json());
  });

  it('rejects malformed query values before seed lookup', async () => {
    const response = await fetch(`${baseUrl}/api/ui/knowledge/repository-snapshots/42/graph?seed=file:1&limit=1000`);
    expect(response.status).toBe(400);
    expect(loadAuthorizedSnapshot).not.toHaveBeenCalled();
  });

  it('keeps the endpoint fail-closed while the rollout flag is disabled', async () => {
    const app = express();
    const pass: RequestHandler = (req, _res, next) => {
      (req as unknown as { user: SessionUser }).user = currentUser;
      next();
    };
    registerRepositoryGraphRoutes(app, {} as pg.Pool, pass, { enabled: false, source: dataSource });
    const disabledServer = await new Promise<Server>(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
      const address = disabledServer.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ui/knowledge/repository-snapshots/42/graph?seed=file:1`);
      expect(response.status).toBe(404);
      expect(loadAuthorizedSnapshot).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => disabledServer.close(error => error ? reject(error) : resolve()));
    }
  });
});
