import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import { createInternalTelemetryRouter } from '../internalTelemetryRoutes.js';

const SECRET = 'argus-internal-telemetry-test-secret';
const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('internal LangGraph telemetry lifecycle route', () => {
  let server: Server;
  let baseUrl = '';
  const previousSecret = process.env['WORKSPACE_SECRET'];

  beforeAll(async () => {
    process.env['WORKSPACE_SECRET'] = SECRET;
    const app = express();
    app.use(express.json());
    app.use(createInternalTelemetryRouter());
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    // Node's global fetch can retain keep-alive sockets after a response has
    // been asserted. Force idle connections closed before waiting for the
    // server close callback so CI runners do not leave this shard hanging.
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousSecret === undefined) delete process.env['WORKSPACE_SECRET'];
    else process.env['WORKSPACE_SECRET'] = previousSecret;
  });

  it('rejects missing or incorrect workspace secrets', async () => {
    for (const providedSecret of [null, 'wrong-secret']) {
      const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' };
      if (providedSecret) headers['x-workspace-secret'] = providedSecret;
      const response = await fetch(`${baseUrl}/api/internal/telemetry/langgraph`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ threadId: THREAD_ID, event: 'started' }),
      });
      expect(response.status).toBe(401);
    }
  });

  it('validates lifecycle payloads after authentication', async () => {
    const invalidThread = await fetch(`${baseUrl}/api/internal/telemetry/langgraph`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', 'x-workspace-secret': SECRET },
      body: JSON.stringify({ threadId: 'not-a-uuid', event: 'started' }),
    });
    expect(invalidThread.status).toBe(400);

    const invalidEvent = await fetch(`${baseUrl}/api/internal/telemetry/langgraph`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', 'x-workspace-secret': SECRET },
      body: JSON.stringify({ threadId: THREAD_ID, event: 'invented' }),
    });
    expect(invalidEvent.status).toBe(400);
  });

  it('validates Codex child trace payloads before touching telemetry storage', async () => {
    const invalidTrace = await fetch(`${baseUrl}/api/internal/telemetry/codex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', 'x-workspace-secret': SECRET },
      body: JSON.stringify({
        traceId: 'not-a-uuid',
        rootTraceId: THREAD_ID,
        event: 'started',
      }),
    });
    expect(invalidTrace.status).toBe(400);

    const invalidEvent = await fetch(`${baseUrl}/api/internal/telemetry/codex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', 'x-workspace-secret': SECRET },
      body: JSON.stringify({
        traceId: '22222222-2222-4222-8222-222222222222',
        rootTraceId: THREAD_ID,
        event: 'invented',
      }),
    });
    expect(invalidEvent.status).toBe(400);
  });

  it('accepts an authenticated LangGraph lifecycle event', async () => {
    const response = await fetch(`${baseUrl}/api/internal/telemetry/langgraph`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', 'x-workspace-secret': SECRET },
      body: JSON.stringify({
        threadId: THREAD_ID,
        workflowType: 'coding_workflow',
        event: 'started',
        input: { apiToken: 'must-be-redacted-by-store' },
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      traceId: THREAD_ID,
      status: 'started',
    });
  });

  it('starts an authenticated deterministic workflow stage span', async () => {
    const response = await fetch(`${baseUrl}/api/internal/telemetry/langgraph-stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', 'x-workspace-secret': SECRET },
      body: JSON.stringify({
        threadId: THREAD_ID,
        stageId: 'tests',
        stageLabel: 'npm dependency setup',
        phase: 'setup',
        profileId: 'node:.',
        runner: 'node',
        root: '.',
        command: 'npm ci',
        event: 'started',
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, traceId: THREAD_ID, status: 'started' });
    expect(body['spanId']).toMatch(UUID_RE);
  });

  it('validates deterministic workflow stage lifecycle payloads', async () => {
    const response = await fetch(`${baseUrl}/api/internal/telemetry/langgraph-stage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', 'x-workspace-secret': SECRET },
      body: JSON.stringify({
        threadId: THREAD_ID,
        stageId: 'tests',
        phase: 'setup',
        event: 'invented',
      }),
    });
    expect(response.status).toBe(400);
  });
});
