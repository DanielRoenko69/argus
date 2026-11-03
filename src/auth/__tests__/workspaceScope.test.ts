import { describe, expect, it } from '@jest/globals';
import type { SessionUser } from '../userAuth.js';
import {
  auditScopesForUser,
  resolveAuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
} from '../workspaceScope.js';

const user: SessionUser = {
  id: 7,
  username: 'alex',
  display_name: 'Alex',
  role: 'platform_admin',
  allowed_bundles: null,
  entra_groups: [],
  workspace_scopes: [
    { tenantKey: 'tenant-a', workspaceKey: 'shared-name', isDefault: true },
    { tenantKey: 'tenant-b', workspaceKey: 'shared-name', isDefault: false },
  ],
};

function request(headers: Partial<Record<string, string>> = {}) {
  return { header: (name: string) => headers[name.toLowerCase()] };
}

describe('server-authorized workspace scopes', () => {
  it('selects the persisted default without trusting client input', () => {
    expect(resolveAuthorizedWorkspaceScope(request(), user)).toEqual({
      tenantKey: 'tenant-a', workspaceKey: 'shared-name',
    });
  });

  it('allows an explicitly selected membership with the same workspace name in another tenant', () => {
    expect(resolveAuthorizedWorkspaceScope(request({
      'x-argus-tenant-key': 'tenant-b',
      'x-argus-workspace-key': 'shared-name',
    }), user)).toEqual({ tenantKey: 'tenant-b', workspaceKey: 'shared-name' });
  });

  it.each([
    { 'x-argus-tenant-key': 'tenant-b' },
    { 'x-argus-workspace-key': 'shared-name' },
    { 'x-argus-tenant-key': 'tenant-c', 'x-argus-workspace-key': 'shared-name' },
    { 'x-argus-tenant-key': '../tenant-a', 'x-argus-workspace-key': 'shared-name' },
  ])('fails closed with the same opaque result for invalid or unauthorized selectors', headers => {
    expect(() => resolveAuthorizedWorkspaceScope(request(headers), user)).toThrow(WorkspaceScopeAccessError);
    try {
      resolveAuthorizedWorkspaceScope(request(headers), user);
    } catch (error) {
      expect(error).toMatchObject({ status: 404, code: 'WORKSPACE_SCOPE_NOT_FOUND' });
      expect(String((error as Error).message)).not.toContain('tenant-c');
    }
  });

  it('exposes only memberships from the authenticated session to multi-scope evidence reads', () => {
    expect(auditScopesForUser(user)).toEqual([
      { tenantKey: 'tenant-a', workspaceKey: 'shared-name' },
      { tenantKey: 'tenant-b', workspaceKey: 'shared-name' },
    ]);
  });

  it('does not turn an explicitly empty persisted membership set into default access', () => {
    const withoutMembership = { ...user, workspace_scopes: [] };
    expect(auditScopesForUser(withoutMembership)).toEqual([]);
    expect(() => resolveAuthorizedWorkspaceScope(request(), withoutMembership)).toThrow(WorkspaceScopeAccessError);
  });
});
