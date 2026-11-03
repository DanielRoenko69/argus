import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { requireFreshMfa, type AuthenticatedRequest } from '../sessionMiddleware.js';

function response() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    redirect: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}

describe('requireFreshMfa', () => {
  it('returns a machine-readable step-up challenge for API calls', () => {
    const req = {
      method: 'POST', path: '/api/ui/compliance/release', originalUrl: '/api/ui/compliance/release',
      user: { id: 17, username: 'oidc:issuer:subject', display_name: 'Alex', role: 'platform_admin',
        allowed_bundles: null, entra_groups: [], auth_method: 'oidc', mfa_verified_at: null, mfa_method: null },
    } as unknown as AuthenticatedRequest;
    const res = response();
    const next = jest.fn() as NextFunction;
    requireFreshMfa(600)(req as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(428);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'MFA_STEP_UP_REQUIRED',
      stepUpUrl: '/auth/oidc/step-up?returnTo=%2Fgovernance%2Fcompliance',
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('continues only for fresh provider-backed MFA sessions', () => {
    const now = new Date();
    const req = {
      method: 'POST', path: '/api/release', originalUrl: '/api/release',
      user: { id: 17, username: 'oidc:issuer:subject', display_name: 'Alex', role: 'platform_admin',
        allowed_bundles: null, entra_groups: [], auth_method: 'oidc',
        mfa_verified_at: now.toISOString(), mfa_method: 'amr:mfa' },
    } as unknown as AuthenticatedRequest;
    const next = jest.fn() as NextFunction;
    requireFreshMfa(600)(req as Request, response(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
