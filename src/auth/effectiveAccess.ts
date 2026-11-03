import { permissionsForRole } from './permissionCatalog.js';
import type { ArgusPermission, PermissionAssignment, ResourceScope } from './permissions.js';
import { normalizeRole, type ArgusRole } from './roles.js';

export interface EffectiveAccessInput {
  role: string | null | undefined;
  assignments?: readonly PermissionAssignment[];
}

export interface PermissionDecision {
  allowed: boolean;
  permission: ArgusPermission;
  reason: 'explicit_deny' | 'explicit_allow' | 'role_preset' | 'not_granted';
  role: ArgusRole;
  source?: PermissionAssignment['source'];
  sourceId?: string;
}

function scopeMatches(assignment: PermissionAssignment, target: ResourceScope | undefined): boolean {
  if (!assignment.scope) return true;
  return Boolean(target && assignment.scope.kind === target.kind && assignment.scope.id === target.id);
}

export function evaluatePermission(
  input: EffectiveAccessInput,
  permission: ArgusPermission,
  targetScope?: ResourceScope,
): PermissionDecision {
  const role = normalizeRole(input.role ?? 'viewer');
  const matching = (input.assignments ?? []).filter(assignment => (
    assignment.permission === permission && scopeMatches(assignment, targetScope)
  ));
  const deny = matching.find(assignment => assignment.effect === 'deny');
  if (deny) {
    return {
      allowed: false,
      permission,
      reason: 'explicit_deny',
      role,
      source: deny.source,
      ...(deny.sourceId ? { sourceId: deny.sourceId } : {}),
    };
  }
  const allow = matching.find(assignment => assignment.effect === 'allow');
  if (allow) {
    return {
      allowed: true,
      permission,
      reason: 'explicit_allow',
      role,
      source: allow.source,
      ...(allow.sourceId ? { sourceId: allow.sourceId } : {}),
    };
  }
  if (permissionsForRole(role).includes(permission)) {
    return { allowed: true, permission, reason: 'role_preset', role, source: 'role_preset' };
  }
  return { allowed: false, permission, reason: 'not_granted', role };
}

export function effectivePermissions(input: EffectiveAccessInput): ArgusPermission[] {
  const role = normalizeRole(input.role ?? 'viewer');
  const candidates = new Set<ArgusPermission>(permissionsForRole(role));
  for (const assignment of input.assignments ?? []) {
    if (!assignment.scope && assignment.effect === 'allow') candidates.add(assignment.permission);
  }
  return [...candidates]
    .filter(permission => evaluatePermission(input, permission).allowed)
    .sort();
}

export interface FourEyesDecisionInput {
  requesterUserId: number | string | null | undefined;
  reviewerUserId: number | string | null | undefined;
  reviewerAccess: EffectiveAccessInput;
}

export function canReviewFourEyes(input: FourEyesDecisionInput): PermissionDecision {
  const review = evaluatePermission(input.reviewerAccess, 'approvals.review');
  if (!review.allowed) return review;
  if (
    input.requesterUserId != null
    && input.reviewerUserId != null
    && String(input.requesterUserId) === String(input.reviewerUserId)
  ) {
    return evaluatePermission(input.reviewerAccess, 'approvals.override_four_eyes');
  }
  return review;
}
