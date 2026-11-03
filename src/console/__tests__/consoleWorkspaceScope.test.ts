import { describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import type { SessionUser } from '../../auth/userAuth.js';
import { resolveConsoleWorkspaceScope, telemetryAccess } from '../consoleApi.js';

const user: SessionUser = {
  id: 17,
  username: 'alex',
  display_name: 'Alex',
  role: 'platform_admin',
  allowed_bundles: [3, 7],
  entra_groups: [],
  workspace_scopes: [
    { tenantKey: 'tenant-a', workspaceKey: 'engineering', isDefault: true },
    { tenantKey: 'tenant-b', workspaceKey: 'engineering', isDefault: false },
  ],
};

function request(headers: Record<string, string>): Request {
  return { header: (name: string) => headers[name.toLowerCase()] } as Request;
}

function response() {
  const json = jest.fn((_body: unknown) => undefined);
  const status = jest.fn((_code: number) => ({ json }));
  return { value: { status } as unknown as Response, status, json };
}

describe('console workspace scope boundary', () => {
  it('keeps colliding workspace names distinct by tenant and forwards the selected scope to telemetry', () => {
    const res = response();
    const selected = resolveConsoleWorkspaceScope(request({
      'x-argus-tenant-key': 'tenant-b',
      'x-argus-workspace-key': 'engineering',
    }), res.value, user);
    expect(selected).toEqual({ tenantKey: 'tenant-b', workspaceKey: 'engineering' });
    expect(telemetryAccess(user, selected!)).toEqual({
      userId: 17,
      observeAll: true,
      allowedBundleIds: [3, 7],
      tenantKey: 'tenant-b',
      workspaceKey: 'engineering',
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns the shared opaque response for a foreign selector before console stores are called', () => {
    const res = response();
    expect(resolveConsoleWorkspaceScope(request({
      'x-argus-tenant-key': 'tenant-c',
      'x-argus-workspace-key': 'engineering',
    }), res.value, user)).toBeNull();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Workspace scope was not found.',
      code: 'WORKSPACE_SCOPE_NOT_FOUND',
    });
  });
});
