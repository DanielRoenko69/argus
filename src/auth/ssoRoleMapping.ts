import { normalizeRole, parseArgusRole, ROLE_WEIGHTS, type ArgusRole } from './roles.js';

export interface SsoRoleMappingResult {
  effectiveRole: ArgusRole;
  matched: Array<{ group: string; role: ArgusRole }>;
  usedDefault: boolean;
}

/**
 * Resolves already verified IdP group claims into Argus role presets.
 * Token signature, issuer and audience validation must happen before calling it.
 */
export function resolveSsoRoleMapping(
  defaultRole: string | null | undefined,
  groups: readonly string[],
  groupMap: Readonly<Record<string, string>>,
): SsoRoleMappingResult {
  const matched: Array<{ group: string; role: ArgusRole }> = [];
  for (const group of groups) {
    const role = parseArgusRole(groupMap[group]);
    if (role) matched.push({ group, role });
  }
  if (matched.length === 0) {
    return { effectiveRole: normalizeRole(defaultRole ?? 'viewer'), matched, usedDefault: true };
  }
  const effectiveRole = matched.reduce((best, candidate) => (
    ROLE_WEIGHTS[candidate.role] > ROLE_WEIGHTS[best] ? candidate.role : best
  ), matched[0]!.role);
  return { effectiveRole, matched, usedDefault: false };
}
