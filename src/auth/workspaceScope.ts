import type { SessionUser, SessionWorkspaceScope } from './userAuth.js';

export interface AuthorizedWorkspaceScope {
  tenantKey: string;
  workspaceKey: string;
}

export class WorkspaceScopeAccessError extends Error {
  readonly status = 404;
  readonly code = 'WORKSPACE_SCOPE_NOT_FOUND';
}

export interface ScopeHeaderReader {
  header(name: string): string | undefined;
}

const SCOPE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

function legacyDefaultScope(): SessionWorkspaceScope {
  return { tenantKey: 'default', workspaceKey: 'default', isDefault: true };
}

export function authorizedWorkspaceScopes(user: SessionUser): SessionWorkspaceScope[] {
  // Persisted sessions always carry workspace_scopes. The fallback keeps
  // internal/test callers created before migration 250 compatible without
  // ever granting more than the historical single-workspace boundary.
  const source = user.workspace_scopes === undefined ? [legacyDefaultScope()] : user.workspace_scopes;
  const unique = new Map<string, SessionWorkspaceScope>();
  for (const scope of source) {
    if (!SCOPE_KEY.test(scope.tenantKey) || !SCOPE_KEY.test(scope.workspaceKey)) continue;
    const key = `${scope.tenantKey}\u0000${scope.workspaceKey}`;
    unique.set(key, { ...scope, isDefault: Boolean(scope.isDefault) });
  }
  return [...unique.values()].sort((left, right) => Number(right.isDefault) - Number(left.isDefault)
    || left.tenantKey.localeCompare(right.tenantKey)
    || left.workspaceKey.localeCompare(right.workspaceKey));
}

function header(req: ScopeHeaderReader, name: string): string {
  return req.header(name)?.trim() ?? '';
}

/**
 * Resolve a client selector against the server-authenticated session scope.
 * Unknown, malformed and partially supplied selectors deliberately share the
 * same opaque error so callers cannot enumerate tenant or workspace names.
 */
export function resolveAuthorizedWorkspaceScope(
  req: ScopeHeaderReader,
  user: SessionUser,
): AuthorizedWorkspaceScope {
  const tenantKey = header(req, 'x-argus-tenant-key');
  const workspaceKey = header(req, 'x-argus-workspace-key');
  const scopes = authorizedWorkspaceScopes(user);
  if (!tenantKey && !workspaceKey) {
    const selected = scopes.find(scope => scope.isDefault) ?? scopes[0];
    if (selected) return { tenantKey: selected.tenantKey, workspaceKey: selected.workspaceKey };
    throw new WorkspaceScopeAccessError('Workspace scope was not found.');
  }
  if (!SCOPE_KEY.test(tenantKey) || !SCOPE_KEY.test(workspaceKey)) {
    throw new WorkspaceScopeAccessError('Workspace scope was not found.');
  }
  const selected = scopes.find(scope => scope.tenantKey === tenantKey && scope.workspaceKey === workspaceKey);
  if (!selected) throw new WorkspaceScopeAccessError('Workspace scope was not found.');
  return { tenantKey: selected.tenantKey, workspaceKey: selected.workspaceKey };
}

export function auditScopesForUser(user: SessionUser): AuthorizedWorkspaceScope[] {
  return authorizedWorkspaceScopes(user).map(({ tenantKey, workspaceKey }) => ({ tenantKey, workspaceKey }));
}
