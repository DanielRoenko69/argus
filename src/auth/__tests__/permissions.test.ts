import { ARGUS_PERMISSIONS, type PermissionAssignment } from '../permissions.js';
import { PERMISSION_CATALOG, ROLE_PERMISSION_PRESETS } from '../permissionCatalog.js';
import { canReviewFourEyes, effectivePermissions, evaluatePermission } from '../effectiveAccess.js';
import { ARGUS_ROLES } from '../roles.js';

describe('named Argus permissions', () => {
  it('catalogues every permission exactly once', () => {
    expect(Object.keys(PERMISSION_CATALOG).sort()).toEqual([...ARGUS_PERMISSIONS].sort());
  });

  it('keeps role presets monotonic across the legacy hierarchy', () => {
    const ascending = [...ARGUS_ROLES].reverse();
    for (let index = 1; index < ascending.length; index += 1) {
      const lower = ROLE_PERMISSION_PRESETS[ascending[index - 1]!];
      const higher = ROLE_PERMISSION_PRESETS[ascending[index]!];
      expect(lower.every(permission => higher.includes(permission))).toBe(true);
    }
  });

  it('normalizes legacy roles before resolving permissions', () => {
    expect(evaluatePermission({ role: 'admin' }, 'platform.admin').allowed).toBe(true);
    expect(evaluatePermission({ role: 'editor' }, 'workflows.manage').allowed).toBe(true);
  });

  it('separates AIOps reading, investigation, authoring and activation', () => {
    expect(evaluatePermission({ role: 'viewer' }, 'aiops.service_profile.read').allowed).toBe(true);
    expect(evaluatePermission({ role: 'viewer' }, 'aiops.investigation.run').allowed).toBe(false);
    expect(evaluatePermission({ role: 'viewer' }, 'aiops.investigation.review').allowed).toBe(false);
    expect(evaluatePermission({ role: 'agent_operator' }, 'aiops.investigation.run').allowed).toBe(true);
    expect(evaluatePermission({ role: 'agent_operator' }, 'aiops.investigation.review').allowed).toBe(true);
    expect(evaluatePermission({ role: 'developer' }, 'aiops.service_profile.write').allowed).toBe(true);
    expect(evaluatePermission({ role: 'developer' }, 'aiops.service_profile.activate').allowed).toBe(false);
    expect(evaluatePermission({ role: 'operations_admin' }, 'aiops.service_profile.activate').allowed).toBe(true);
  });

  it('separates AIOps remediation proposal from approval and execution', () => {
    expect(evaluatePermission({ role: 'developer' }, 'aiops.remediation.propose').allowed).toBe(true);
    expect(evaluatePermission({ role: 'developer' }, 'aiops.remediation.approve').allowed).toBe(false);
    expect(evaluatePermission({ role: 'developer' }, 'aiops.remediation.execute').allowed).toBe(false);
    expect(evaluatePermission({ role: 'operations_admin' }, 'aiops.remediation.propose').allowed).toBe(true);
    expect(evaluatePermission({ role: 'operations_admin' }, 'aiops.remediation.approve').allowed).toBe(true);
    expect(evaluatePermission({ role: 'operations_admin' }, 'aiops.remediation.execute').allowed).toBe(true);
  });

  it('separates AI-system authoring from classification and production release', () => {
    expect(evaluatePermission({ role: 'viewer' }, 'ai_system.read').allowed).toBe(true);
    expect(evaluatePermission({ role: 'developer' }, 'ai_system.create').allowed).toBe(false);
    expect(evaluatePermission({ role: 'operations_admin' }, 'ai_system.create').allowed).toBe(true);
    expect(evaluatePermission({ role: 'operations_admin' }, 'ai_system.manage').allowed).toBe(true);
    expect(evaluatePermission({ role: 'operations_admin' }, 'ai_system.classify').allowed).toBe(false);
    expect(evaluatePermission({ role: 'operations_admin' }, 'ai_system.release').allowed).toBe(false);
    expect(evaluatePermission({ role: 'platform_admin' }, 'ai_system.classify').allowed).toBe(true);
    expect(evaluatePermission({ role: 'platform_admin' }, 'ai_system.release').allowed).toBe(true);
    expect(evaluatePermission({ role: 'platform_admin' }, 'ai_system.suspend').allowed).toBe(true);
  });

  it('reserves exceptional AI compliance actions for explicit delegation or platform admins', () => {
    expect(evaluatePermission({ role: 'operations_admin' }, 'compliance.review').allowed).toBe(true);
    expect(evaluatePermission({ role: 'operations_admin' }, 'compliance.dossier_generate').allowed).toBe(true);
    expect(evaluatePermission({ role: 'operations_admin' }, 'compliance.external_anchor').allowed).toBe(false);
    expect(evaluatePermission({ role: 'operations_admin' }, 'incident.regulatory_report').allowed).toBe(false);
    expect(evaluatePermission({ role: 'platform_admin' }, 'compliance.external_anchor').allowed).toBe(true);
    expect(evaluatePermission({ role: 'platform_admin' }, 'incident.regulatory_report').allowed).toBe(true);
  });

  it('evaluates explicit deny before direct and role allows', () => {
    const assignments: PermissionAssignment[] = [
      { permission: 'workflows.manage', effect: 'allow', source: 'direct' },
      { permission: 'workflows.manage', effect: 'deny', source: 'sso_group', sourceId: 'contractors' },
    ];
    expect(evaluatePermission({ role: 'platform_admin', assignments }, 'workflows.manage')).toMatchObject({
      allowed: false,
      reason: 'explicit_deny',
      source: 'sso_group',
      sourceId: 'contractors',
    });
    expect(effectivePermissions({ role: 'platform_admin', assignments })).not.toContain('workflows.manage');
  });

  it('does not apply a scoped assignment to a different target', () => {
    const assignments: PermissionAssignment[] = [{
      permission: 'audit.read',
      effect: 'allow',
      source: 'sso_group',
      scope: { kind: 'project', id: 'payments' },
    }];
    expect(evaluatePermission({ role: 'viewer', assignments }, 'audit.read', { kind: 'project', id: 'payments' }).allowed).toBe(true);
    expect(evaluatePermission({ role: 'viewer', assignments }, 'audit.read', { kind: 'project', id: 'search' }).allowed).toBe(false);
  });

  it('enforces four-eyes unless the explicit override permission exists', () => {
    expect(canReviewFourEyes({
      requesterUserId: 7,
      reviewerUserId: 7,
      reviewerAccess: { role: 'agent_operator' },
    }).allowed).toBe(false);
    expect(canReviewFourEyes({
      requesterUserId: 7,
      reviewerUserId: 7,
      reviewerAccess: { role: 'platform_admin' },
    }).allowed).toBe(true);
  });
});
