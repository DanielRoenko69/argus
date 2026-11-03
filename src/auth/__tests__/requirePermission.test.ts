import { jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { requirePermission, type AuthenticatedRequest } from '../sessionMiddleware.js';

function response() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { response: { status } as unknown as Response, status, json };
}

describe('requirePermission', () => {
  it('allows a role preset with the named permission', () => {
    const req = { user: { role: 'developer' } } as unknown as AuthenticatedRequest;
    const { response: res } = response();
    const next = jest.fn() as unknown as NextFunction;
    requirePermission('workflows.manage')(req as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns a non-secret decision for insufficient access', () => {
    const req = { user: { role: 'viewer' } } as unknown as AuthenticatedRequest;
    const { response: res, status, json } = response();
    const next = jest.fn() as unknown as NextFunction;
    requirePermission('tags.manage')(req as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      error: 'Unzureichende Berechtigungen',
      requiredPermission: 'tags.manage',
      decision: 'not_granted',
    });
  });

  it('does not treat a missing session as a viewer', () => {
    const { response: res, status } = response();
    requirePermission('tags.read')({} as Request, res, jest.fn());
    expect(status).toHaveBeenCalledWith(401);
  });
});
