import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';
import type { Config } from '../../config/env.js';

// jose is ESM-only; the middleware's own boundary is the verify options it
// passes and what it does with a verified payload.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
}));

import { jwtVerify } from 'jose';
import {
  assertOAuth2Config,
  createOAuth2Middleware,
  oauth2Username,
  setOAuth2KeySetForTests,
  type OAuth2BoundUser,
} from '../oauth2Middleware.js';

const verify = jwtVerify as unknown as jest.Mock<(...args: unknown[]) => Promise<{ payload: Record<string, unknown> }>>;

function config(overrides: Partial<Config> = {}): Config {
  return {
    oauth2Enabled: true,
    oauth2Issuer: 'https://identity.example.test/realms/argus',
    oauth2Audience: 'argus-api',
    oauth2JwksUri: 'https://identity.example.test/realms/argus/certs',
    oidcProvider: 'generic_oidc',
    oidcSubjectClaim: 'sub',
    ...overrides,
  } as Config;
}

function run(cfg: Config, resolver?: (username: string) => Promise<OAuth2BoundUser | null>) {
  const req = { headers: { authorization: 'Bearer aaa.bbb.ccc' } } as unknown as Request;
  const status = jest.fn<(code: number) => Response>();
  const json = jest.fn();
  const res = { status, json } as unknown as Response;
  status.mockReturnValue(res);
  const next = jest.fn();
  return createOAuth2Middleware(cfg, resolver)(req, res, next).then(() => ({ req, status, json, next }));
}

const viewer: OAuth2BoundUser = {
  id: 7, username: 'pending', role: 'viewer', allowed_bundles: [3], enabled: true, entra_groups: ['dev'],
};

describe('OAuth2 bearer JWT middleware', () => {
  beforeEach(() => {
    verify.mockReset();
    setOAuth2KeySetForTests(jest.fn() as never);
  });

  it('refuses to start without issuer and audience', () => {
    expect(() => assertOAuth2Config(config({ oauth2Audience: '' }))).toThrow(/OAUTH2_AUDIENCE/);
    expect(() => assertOAuth2Config(config({ oauth2Issuer: '' }))).toThrow(/OAUTH2_ISSUER/);
    expect(() => assertOAuth2Config(config({ oauth2Enabled: false, oauth2Audience: '' }))).not.toThrow();
  });

  it('always verifies issuer, audience, sub and exp', async () => {
    verify.mockResolvedValue({ payload: { sub: 'abc', exp: 9999999999 } });
    await run(config(), async () => viewer);
    expect(verify.mock.calls[0]?.[2]).toEqual({
      issuer: 'https://identity.example.test/realms/argus',
      audience: 'argus-api',
      requiredClaims: ['sub', 'exp'],
    });
  });

  it('rejects a JWT when audience is missing at runtime instead of skipping the check', async () => {
    const { status, next } = await run(config({ oauth2Audience: '' }), async () => viewer);
    expect(verify).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed for a valid token whose subject is not an Argus user', async () => {
    verify.mockResolvedValue({ payload: { sub: 'unknown', exp: 9999999999 } });
    const { req, status, next } = await run(config(), async () => null);
    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect((req as unknown as Record<string, unknown>).authenticated).toBeUndefined();
  });

  it('fails closed without a user resolver and for disabled users', async () => {
    verify.mockResolvedValue({ payload: { sub: 'abc', exp: 9999999999 } });
    expect((await run(config())).status).toHaveBeenCalledWith(403);
    expect((await run(config(), async () => ({ ...viewer, enabled: false }))).status).toHaveBeenCalledWith(403);
  });

  it('binds a mapped subject to the Argus user scope instead of an unrestricted context', async () => {
    verify.mockResolvedValue({ payload: { sub: 'abc', exp: 9999999999, roles: ['platform_admin'] } });
    const seen: string[] = [];
    const { req, next } = await run(config(), async (username) => { seen.push(username); return viewer; });
    expect(seen).toEqual([oauth2Username(config(), { sub: 'abc' })]);
    expect(seen[0]).toMatch(/^oidc:[0-9a-f]{12}:abc$/);
    const r = req as unknown as Record<string, unknown>;
    expect(next).toHaveBeenCalled();
    expect(r.allowedBundles).toEqual([3]);
    expect(r.callingUser).toEqual({ id: 7, username: 'pending', role: 'viewer', entra_groups: ['dev'] });
    expect(r.apiKeyPrefix).toBe('oauth2:7');
  });
});
