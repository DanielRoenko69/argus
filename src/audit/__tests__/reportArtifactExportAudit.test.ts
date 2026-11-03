import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { AuthenticatedRequest } from '../../auth/sessionMiddleware.js';
import type { AuditReportRun } from '../reportTypes.js';

const run = {
  id: '10000000-0000-4000-8000-000000000001', workspaceKey: 'default', tenantKey: 'default', environment: 'production',
  packDigest: 'pack-digest', reviews: [],
} as unknown as AuditReportRun;

jest.mock('../reportStore.js', () => ({
  getAuditReportRun: jest.fn(async () => run),
  createAuditReportDefinition: jest.fn(), disableAuditReportDefinition: jest.fn(), getAuditReportDefinition: jest.fn(),
  listAuditReportDefinitions: jest.fn(), listAuditReportRuns: jest.fn(),
}));
jest.mock('../reportExport.js', () => ({
  auditReportArtifact: jest.fn(() => '{"synthetic":"report"}'),
  auditReportPdf: jest.fn(),
}));

import { registerAuditReportRoutes } from '../reportRoutes.js';

let server: Server | null = null;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = null; });

async function start(recordArtifactExport: Parameters<typeof registerAuditReportRoutes>[3]['recordArtifactExport']) {
  const app = express();
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).user = {
      id: 7, username: 'oidc:abc:auditor', display_name: 'Auditor', role: 'operations_admin', allowed_bundles: null,
      entra_groups: [], auth_method: 'oidc', mfa_verified_at: new Date().toISOString(), mfa_method: 'webauthn',
    };
    next();
  });
  registerAuditReportRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
    enabled: true, signer: null, requireFreshMfa: (_req, _res, next) => next(), recordArtifactExport,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  return (server.address() as AddressInfo).port;
}

describe('audit report artifact download', () => {
  it('records a user-attributed canonical export event before sending the artifact', async () => {
    const order: string[] = [];
    const recorder = jest.fn(async (_pool: pg.Pool, _run: AuditReportRun, artifact: { format: string; sha256: string; bytes: number }, actor: { id: string; type: string }) => {
      order.push(`audit:${artifact.format}:${actor.type}:${actor.id}`);
      return { eventId: 'event-1' };
    });
    const port = await start(recorder as never);
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/report-runs/v1/${run.id}/artifacts/json`);
    order.push('response');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-argus-audit-event-id')).toBe('event-1');
    expect(await response.text()).toBe('{"synthetic":"report"}');
    expect(order).toEqual(['audit:json:human:7', 'response']);
    expect(recorder.mock.calls[0]?.[2]).toMatchObject({ bytes: 22, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('sends nothing when the export cannot be recorded', async () => {
    const port = await start((async () => { throw new Error('audit store down'); }) as never);
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/report-runs/v1/${run.id}/artifacts/json`);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('AUDIT_EXPORT_NOT_RECORDED');
    expect(body).not.toContain('synthetic');
  });
});
