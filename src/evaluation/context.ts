import type { Request } from 'express';
import type { SessionUser } from '../auth/userAuth.js';
import { resolveAuthorizedWorkspaceScope, type AuthorizedWorkspaceScope } from '../auth/workspaceScope.js';
import { hasRole } from '../auth/roles.js';
import { EvaluationError } from './contracts.js';

export interface EvaluationContext extends AuthorizedWorkspaceScope {
  user: SessionUser;
  environment: string;
  requestId: string;
}
export function evaluationContext(req: Request): EvaluationContext {
  const user = (req as Request & { user?: SessionUser }).user;
  if (!user) throw new EvaluationError('AUTH_REQUIRED', 'Authentication required', 401);
  if (!hasRole(user.role, 'platform_admin')) throw new EvaluationError('FORBIDDEN', 'Platform admin access required', 403);
  const requestId = req.header('Idempotency-Key');
  if (requestId && !/^[\x21-\x7e]{8,200}$/.test(requestId)) {
    throw new EvaluationError('EVALUATION_INVALID', 'Idempotency-Key must contain 8–200 visible ASCII characters');
  }
  return { user, ...resolveAuthorizedWorkspaceScope(req, user),
    environment: process.env['ARGUS_ENVIRONMENT'] || process.env['NODE_ENV'] || 'development',
    requestId: requestId ?? '' };
}
export function assertGlobalCatalogScope(context: AuthorizedWorkspaceScope): void {
  if (context.tenantKey !== 'default' || context.workspaceKey !== 'default') {
    throw new EvaluationError('EVALUATION_REFERENCE_NOT_FOUND', 'Referenced resource was not found in this workspace', 404);
  }
}
export function missingReference(): never {
  throw new EvaluationError('EVALUATION_REFERENCE_NOT_FOUND', 'Referenced resource was not found in this workspace', 404);
}
