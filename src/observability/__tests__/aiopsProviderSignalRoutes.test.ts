import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type pg from 'pg';
import { registerAiOpsProviderSignalRoutes } from '../aiopsProviderSignalRoutes.js';

function signature(body: Buffer): string {
  return `sha256=${createHmac('sha256', 'provider-test-secret').update(body).digest('hex')}`;
}

describe('AIOps provider signal routes', () => {
  let server: Server | null = null;
  let baseUrl = '';
  const previousSecret = process.env['AIOPS_PROVIDER_WEBHOOK_SECRET'];
  const previousNodeEnv = process.env['NODE_ENV'];

  beforeEach(async () => {
    process.env['AIOPS_PROVIDER_WEBHOOK_SECRET'] = 'provider-test-secret';
    process.env['NODE_ENV'] = 'production';
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
    server = null;
    if (previousSecret === undefined) delete process.env['AIOPS_PROVIDER_WEBHOOK_SECRET'];
    else process.env['AIOPS_PROVIDER_WEBHOOK_SECRET'] = previousSecret;
    if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previousNodeEnv;
  });

  async function start(ingest: jest.Mock): Promise<void> {
    const app = express();
    app.use(express.json({
      verify: (req, _res, buffer) => { (req as unknown as { rawBody?: Buffer }).rawBody = buffer; },
    }));
    registerAiOpsProviderSignalRoutes(app, {} as pg.Pool, {
      ingest: ingest as never,
      dispatch: async () => undefined,
    });
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const activeServer = server;
    if (!activeServer) throw new Error('test server unavailable');
    const address = activeServer.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  it('accepts a correctly signed provider event and returns durable identities', async () => {
    const ingest = jest.fn(async (..._args: unknown[]) => ({
      provider: 'generic', dispatchRequested: true,
      results: [{
        provider: 'generic', eventId: 'event-1', disposition: 'created', signalState: 'firing',
        serviceProfile: { id: 41, revision: 3, sha256: 'a'.repeat(64) },
        alertRuleId: 501, incidentId: 801, correlationGroupId: 901,
      }],
    }));
    await start(ingest);
    const raw = Buffer.from(JSON.stringify({ schemaVersion: 1, signals: [] }));
    const response = await fetch(`${baseUrl}/api/observability/aiops/provider-signals/generic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-argus-signature': signature(raw) },
      body: raw,
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      kind: 'aiops-provider-signal-ingestion', accepted: 1, dispatchRequested: true,
      results: [{ incidentId: 801, correlationGroupId: 901 }],
    });
    expect(ingest).toHaveBeenCalledWith(expect.anything(), 'generic', expect.anything(), raw);
  });

  it('rejects an unsigned provider event before ingestion', async () => {
    const ingest = jest.fn((..._args: unknown[]) => undefined);
    await start(ingest);
    const response = await fetch(`${baseUrl}/api/observability/aiops/provider-signals/generic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, signals: [] }),
    });

    expect(response.status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('fails closed when the provider secret is missing in development', async () => {
    delete process.env['AIOPS_PROVIDER_WEBHOOK_SECRET'];
    process.env['NODE_ENV'] = 'development';
    const ingest = jest.fn((..._args: unknown[]) => undefined);
    await start(ingest);
    const response = await fetch(`${baseUrl}/api/observability/aiops/provider-signals/generic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, signals: [] }),
    });

    expect(response.status).toBe(503);
    expect(ingest).not.toHaveBeenCalled();
  });
});
