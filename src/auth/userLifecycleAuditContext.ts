import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { SessionUser } from './userAuth.js';
import { UserLifecycleError, type UserLifecycleAuditContext } from './userLifecycle.js';

const CANONICAL_AUDIT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface UserLifecycleAuditContextOptions {
  environment?: string;
  eventId?: () => string;
}

function requestHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || !text.trim()) return null;
  const normalized = text.trim();
  if (!CANONICAL_AUDIT_REQUEST_ID.test(normalized)) {
    throw new UserLifecycleError(`${name} header is invalid`, 400, 'AUDIT_REQUEST_ID_INVALID');
  }
  return normalized;
}

export function buildUserLifecycleAuditContext(
  req: Request,
  user: Pick<SessionUser, 'id' | 'username' | 'role'>,
  options: UserLifecycleAuditContextOptions = {},
): UserLifecycleAuditContext {
  const idempotencyKey = requestHeader(req, 'idempotency-key');
  const requestId = requestHeader(req, 'x-request-id');
  const usesSso = /^(?:entra|oidc):/.test(user.username);
  return {
    producerEventId: idempotencyKey ?? requestId ?? (options.eventId ?? randomUUID)(),
    environment: options.environment ?? process.env['NODE_ENV'] ?? 'development',
    actor: {
      type: 'human',
      id: String(user.id),
      ssoSubject: usesSso ? user.username : null,
      authMethod: usesSso ? 'oidc' : 'session',
      effectiveRoles: [user.role],
    },
    requestId,
  };
}

export function buildFirstUserBootstrapAuditContext(
  req: Request,
  options: UserLifecycleAuditContextOptions = {},
): UserLifecycleAuditContext {
  const idempotencyKey = requestHeader(req, 'idempotency-key');
  const requestId = requestHeader(req, 'x-request-id');
  return {
    producerEventId: idempotencyKey ?? requestId ?? (options.eventId ?? randomUUID)(),
    environment: options.environment ?? process.env['NODE_ENV'] ?? 'development',
    actor: {
      type: 'system',
      id: 'argus.first-user-bootstrap',
      ssoSubject: null,
      authMethod: 'unauthenticated-bootstrap',
      effectiveRoles: [],
    },
    requestId,
  };
}
