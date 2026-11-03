import { describe, expect, it } from '@jest/globals';
import type { Request } from 'express';
import type { SessionUser } from '../userAuth.js';
import { buildFirstUserBootstrapAuditContext, buildUserLifecycleAuditContext } from '../userLifecycleAuditContext.js';

function user(username = 'alex'): SessionUser {
  return {
    id: 17,
    username,
    display_name: 'Alex',
    role: 'platform_admin',
    allowed_bundles: null,
    entra_groups: [],
  };
}

function request(headers: Record<string, string | string[]> = {}): Request {
  return { headers } as unknown as Request;
}

describe('user lifecycle canonical audit HTTP context', () => {
  it('prefers a bounded idempotency key and retains a separate request correlation id', () => {
    expect(buildUserLifecycleAuditContext(request({
      'idempotency-key': 'user-update-17-v2',
      'x-request-id': 'request-42',
    }), user(), { environment: 'test', eventId: () => 'unused' })).toEqual({
      producerEventId: 'user-update-17-v2',
      environment: 'test',
      actor: {
        type: 'human', id: '17', ssoSubject: null, authMethod: 'session', effectiveRoles: ['platform_admin'],
      },
      requestId: 'request-42',
    });
  });

  it('preserves the verified stable OIDC subject as audit identity', () => {
    const context = buildUserLifecycleAuditContext(
      request(), user('oidc:issuer-hash:subject-7'), { eventId: () => 'generated-event' },
    );
    expect(context.producerEventId).toBe('generated-event');
    expect(context.actor).toMatchObject({
      ssoSubject: 'oidc:issuer-hash:subject-7',
      authMethod: 'oidc',
    });
  });

  it('rejects malformed client-controlled audit identifiers', () => {
    expect(() => buildUserLifecycleAuditContext(
      request({ 'idempotency-key': 'bad key with spaces' }), user(),
    )).toThrow(expect.objectContaining({ code: 'AUDIT_REQUEST_ID_INVALID' }));
  });

  it('models an unauthenticated first-user registration as a system bootstrap actor', () => {
    expect(buildFirstUserBootstrapAuditContext(request({
      'idempotency-key': 'first-user-bootstrap-1',
      'x-request-id': 'request-bootstrap-1',
    }), { environment: 'test' })).toEqual({
      producerEventId: 'first-user-bootstrap-1',
      environment: 'test',
      actor: {
        type: 'system',
        id: 'argus.first-user-bootstrap',
        ssoSubject: null,
        authMethod: 'unauthenticated-bootstrap',
        effectiveRoles: [],
      },
      requestId: 'request-bootstrap-1',
    });
  });
});
