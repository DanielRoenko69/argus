import { afterEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { AuthenticatedRequest } from '../../auth/sessionMiddleware.js';
import type { SessionWorkspaceScope } from '../../auth/userAuth.js';
import { registerAuditReportRoutes } from '../reportRoutes.js';

let server: Server | null = null;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = null; });

async function start(
  enabled: boolean,
  rejectMfa = false,
  role = 'operations_admin',
  workspaceScopes?: SessionWorkspaceScope[],
) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as AuthenticatedRequest).user = { id: 1, username: 'oidc:test', display_name: 'Test', role, allowed_bundles: null, entra_groups: [], auth_method: 'oidc', mfa_verified_at: new Date().toISOString(), mfa_method: 'webauthn', workspace_scopes: workspaceScopes }; next(); });
  registerAuditReportRoutes(app, {} as pg.Pool, (_req, _res, next) => next(), {
    enabled,
    signer: null,
    requireFreshMfa: rejectMfa
      ? (_req, res) => { res.status(428).json({ code: 'MFA_STEP_UP_REQUIRED' }); }
      : (_req, _res, next) => next(),
  });
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve));
  return (server.address() as AddressInfo).port;
}

describe('audit report routes', () => {
  it('fails closed when canonical evidence is disabled', async () => {
    const port = await start(false);
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/reports/v1`);
    expect(response.status).toBe(404);
  });

  it('does not query reports for an unauthorized tenant/workspace selector', async () => {
    const port = await start(true, false, 'operations_admin', [
      { tenantKey: 'tenant-a', workspaceKey: 'workspace-1', isDefault: true },
    ]);
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/reports/v1`, {
      headers: {
        'x-argus-tenant-key': 'tenant-b',
        'x-argus-workspace-key': 'workspace-1',
      },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Workspace scope was not found.',
      code: 'WORKSPACE_SCOPE_NOT_FOUND',
    });
  });

  it('refuses report generation when no checkpoint signer is configured', async () => {
    const port = await start(true);
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/report-runs/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ environment: 'production' }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'AUDIT_SIGNING_NOT_CONFIGURED' });
  });

  it('enforces fresh MFA before report generation reaches the handler', async () => {
    const port = await start(true, true);
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/report-runs/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ environment: 'production' }),
    });
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ code: 'MFA_STEP_UP_REQUIRED' });
  });

  it('fails visibly when a platform admin requests anchoring without a configured provider', async () => {
    const port = await start(true, false, 'platform_admin');
    const response = await fetch(`http://127.0.0.1:${port}/api/ui/audit/report-runs/v1/10000000-0000-4000-8000-000000000001/external-anchors`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'anchor-test-1' }, body: JSON.stringify({ anchorKind: 'worm_object' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'EXTERNAL_ANCHOR_NOT_CONFIGURED' });
  });
});
