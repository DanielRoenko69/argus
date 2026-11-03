import { describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';
import { clearSessionCookie, setSessionCookie } from '../sessionMiddleware.js';

function response() {
  return { setHeader: jest.fn() } as unknown as Response;
}

describe('OIDC-compatible session cookie', () => {
  it('uses SameSite=Lax so the IdP callback landing redirect receives the session', () => {
    const res = response();
    setSessionCookie(res, 'session-id', 8, false);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      'argus_session=session-id; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800',
    );
  });

  it('keeps Secure in production and clears with matching cookie attributes', () => {
    const res = response();
    setSessionCookie(res, 'session-id', 1, true);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      'argus_session=session-id; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure',
    );
    clearSessionCookie(res);
    expect(res.setHeader).toHaveBeenLastCalledWith(
      'Set-Cookie',
      'argus_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );
  });
});
