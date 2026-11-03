import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import { signExecutionGrant, type ExecutionGrantClaims } from '../../solutionPacks/executionGrant.js';
import { createInternalCredsRouter } from '../internalCredsRoutes.js';

const secret = 'internal-creds-execution-grant-secret-32-bytes';

function managedRuntimeClaims(): ExecutionGrantClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    jti: '687dbbf1-2d2e-45e0-a20c-e2d13d7dfd33',
    iss: 'argus.core',
    aud: 'argus.hermes',
    agent: 'hermes-http',
    sub: 'service:hermes',
    principalKind: 'service',
    principalId: 'hermes',
    bundleIds: [3],
    coreAgentIds: [42],
    coreAgents: [{ name: 'coder', id: 42 }],
    messageId: 'managed-run-42',
    rootTraceId: 'f2b063cb-77bd-46ef-8688-4ee3b7dc35dc',
    executionSurface: 'runtime_mcp',
    policy: 'mcp-bundle-v1',
    iat: now - 1,
    exp: now + 600,
  };
}

describe('internal bundle credential execution-grant surface', () => {
  let server: Server;
  let baseUrl: string;
  const pool = { query: jest.fn() } as unknown as pg.Pool;

  beforeAll(async () => {
    const app = express();
    app.use(createInternalCredsRouter(pool, secret));
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', error => {
        if (error) reject(error);
        else resolve();
      });
    });
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('rejects a runtime-MCP grant before any bundle credential is read', async () => {
    const grant = managedRuntimeClaims();
    const response = await fetch(`${baseUrl}/api/internal/bundle-creds/3/git`, {
      headers: {
        authorization: `Bearer ${signExecutionGrant(secret, grant)}`,
        'x-argus-root-trace-id': grant.rootTraceId,
      },
    });

    expect(response.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
