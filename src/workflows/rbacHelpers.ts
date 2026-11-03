/**
 * RBAC helpers shared between flowRoutes + executeRoutes.
 *
 * Pattern: bundle-overlap. A user sees an entity if either
 *  (a) the user is admin (allowed_bundles === null), or
 *  (b) the entity has no bundle bindings (= "visible to all"), or
 *  (c) at least one of the entity's bundles is in the user's allowed_bundles.
 */

import type { Request } from 'express';

export interface RbacUser {
  id?: number;
  username?: string;
  role?: string;
  allowed_bundles: number[] | null;
  /** Entra group object-ids from SSO login — used to thread per-user/group
   *  policy context into agent steps run from workflows (audit #11). */
  entra_groups?: string[];
}

/** Extract the SessionUser (Browser cookie) from req, with safe fallback. */
export function getRbacUser(req: Request): RbacUser {
  const u = (req as unknown as { user?: RbacUser }).user;
  if (u) return u;
  // Browser-session strict — but be tolerant for API-key paths (rare in builder).
  return { allowed_bundles: null }; // null = treat as unrestricted (admin)
}

/** True when the user is effectively unrestricted (admin / no bundle limits). */
export function isAdmin(user: RbacUser): boolean {
  return user.allowed_bundles === null || user.role === 'admin' || user.role === 'platform_admin';
}

/** Bundle-overlap SQL fragment using array `&&` (Postgres array overlap). */
export function bundlesOverlapSql(arrayCol: string, bundlesParamIdx: number): string {
  return `(${arrayCol} IS NULL OR ${arrayCol} = '{}' OR ${arrayCol} && $${bundlesParamIdx}::int[])`;
}

/** "Visible-to-all-or-overlap" pattern via NOT EXISTS / EXISTS on a junction table. */
export function junctionOverlapSql(
  junctionTable: string,
  fkCol: string,
  fkValueExpr: string,
  bundlesParamIdx: number,
): string {
  return `(
    NOT EXISTS (SELECT 1 FROM ${junctionTable} jx WHERE jx.${fkCol} = ${fkValueExpr})
    OR EXISTS (SELECT 1 FROM ${junctionTable} jx WHERE jx.${fkCol} = ${fkValueExpr} AND jx.bundle_id = ANY($${bundlesParamIdx}::int[]))
  )`;
}
