/**
 * Gate for legacy run-inspector data that can only be selected by time window.
 *
 * `mcp_agent_memory` and `mcp_immutable_audit_log` rows predate run/tenant
 * attribution, so a "rows during this run" query returns everything that
 * happened platform-wide in that window — other users' memories and tool
 * parameters included. Only principals who may already read the platform
 * audit trail (`audit.read`) get that uncorrelated slice, and only in the
 * historical default/default workspace. Everyone else gets an explicit
 * "unavailable" marker instead of foreign data.
 */

import { evaluatePermission } from '../auth/effectiveAccess.js';
import type { AuthorizedWorkspaceScope } from '../auth/workspaceScope.js';

export function canReadLegacyTimeWindowEvidence(
  user: { role?: string | null } | undefined,
  scope: Pick<AuthorizedWorkspaceScope, 'tenantKey' | 'workspaceKey'>,
): boolean {
  if (scope.tenantKey !== 'default' || scope.workspaceKey !== 'default') return false;
  if (!user?.role) return false;
  return evaluatePermission({ role: user.role }, 'audit.read').allowed;
}
