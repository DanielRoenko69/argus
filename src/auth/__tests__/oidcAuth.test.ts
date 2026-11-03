import { describe, expect, it, jest } from '@jest/globals';
import type { Config } from '../../config/env.js';
import { jwtVerify } from 'jose';

// jose is ESM-only. The unit cases below exercise state/PKCE/role boundaries
// before JWT verification; the real Keycloak E2E journey covers remote JWKS.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
}));

import {
  buildAuthorizationUrl,
  evaluateOidcMfaAssurance,
  handleCallback,
  oidcUsername,
  resolveOidcRole,
  safeRedirectPath,
} from '../oidcAuth.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    sessionSecret: 'oidc-unit-test-session-secret-at-least-32-characters',
    oidcProvider: 'generic_oidc',
    oidcAuthorizationUrl: 'https://identity.example.test/authorize?audience=argus',
    oidcTokenUrl: 'https://identity.example.test/token',
    oidcIssuer: 'https://identity.example.test/realms/argus',
    oidcJwksUri: 'https://identity.example.test/realms/argus/certs',
    oidcClientId: 'argus-client',
    oidcClientSecret: 'test-secret',
    oidcRedirectUri: 'https://argus.example.test/auth/oidc/callback',
    oidcScopes: 'openid profile email',
    oidcSubjectClaim: 'sub',
    oidcEmailClaim: 'email',
    oidcDisplayNameClaim: 'name',
    oidcGroupsClaim: 'groups',
    oidcDefaultRole: 'viewer',
    oidcGroupMap: {},
    oidcMfaAmrValues: ['mfa', 'webauthn'],
    oidcMfaAcrValues: ['urn:example:loa:2'],
    oidcMfaMaxAgeSeconds: 600,
    ...overrides,
  } as Config;
}

describe('provider-neutral interactive OIDC', () => {
  it('builds Authorization Code + PKCE-S256 with signed state and a distinct nonce', () => {
    const first = buildAuthorizationUrl(config(), '/home');
    const second = buildAuthorizationUrl(config(), '/home');
    const url = new URL(first.url);

    expect(url.searchParams.get('audience')).toBe('argus');
    expect(url.searchParams.get('client_id')).toBe('argus-client');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBe(first.state);
    expect(first.state).not.toBe(second.state);
    expect(new URL(second.url).searchParams.get('nonce')).not.toBe(url.searchParams.get('nonce'));
    expect(url.searchParams.has('code_verifier')).toBe(false);
  });

  it('falls back to a safe local redirect and rejects tampered state before token exchange', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const { state } = buildAuthorizationUrl(config(), 'https://evil.example.test');
    const last = state.at(-1);
    const tampered = `${state.slice(0, -1)}${last === 'a' ? 'b' : 'a'}`;

    await expect(handleCallback(config(), 'unused-code', tampered, 'unused-binding')).rejects.toThrow('Invalid state signature');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('requests a fresh IdP login and configured assurance level for MFA step-up', () => {
    const result = buildAuthorizationUrl(config(), '/governance/compliance', {
      stepUp: true,
      expectedUsername: 'oidc:issuer-key:stable-subject',
    });
    const url = new URL(result.url);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    expect(url.searchParams.get('acr_values')).toBe('urn:example:loa:2');
  });

  it('refuses to create a step-up request without an active SSO identity', () => {
    expect(() => buildAuthorizationUrl(config(), '/home', { stepUp: true }))
      .toThrow('active SSO identity');
  });

  it('binds account linking to a local user and demands fresh provider MFA', async () => {
    const cfg = config();
    const request = buildAuthorizationUrl(cfg, '/settings/identity', { linkUserId: 42 });
    const url = new URL(request.url);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    const nonce = url.searchParams.get('nonce')!;
    const authTime = Math.floor(Date.now() / 1000);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ id_token: 'signed-link-token' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    jest.mocked(jwtVerify).mockResolvedValue({
      payload: {
        sub: 'stable-subject', nonce, email: 'user@example.test', name: 'User',
        auth_time: authTime, amr: ['pwd', 'mfa'],
      },
      protectedHeader: { alg: 'RS256' },
    } as never);

    const result = await handleCallback(cfg, 'authorization-code', request.state, request.browserBinding);
    expect(result).toMatchObject({
      purpose: 'link_identity',
      linkTargetUserId: 42,
      redirectAfter: '/settings/identity',
      assurance: { authMethod: 'oidc', mfaMethod: 'amr:mfa' },
    });
    fetchSpy.mockRestore();
  });

  it('rejects account linking when the provider did not prove MFA', async () => {
    const cfg = config();
    const request = buildAuthorizationUrl(cfg, '/settings/identity', { linkUserId: 42 });
    const nonce = new URL(request.url).searchParams.get('nonce')!;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ id_token: 'signed-link-token-without-mfa' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    jest.mocked(jwtVerify).mockResolvedValue({
      payload: {
        sub: 'stable-subject', nonce, email: 'user@example.test', name: 'User',
        auth_time: Math.floor(Date.now() / 1000), amr: ['pwd'],
      },
      protectedHeader: { alg: 'RS256' },
    } as never);

    await expect(handleCallback(cfg, 'authorization-code', request.state, request.browserBinding))
      .rejects.toThrow('fresh MFA');
    fetchSpy.mockRestore();
  });

  it('accepts only fresh signed amr/acr evidence as MFA assurance', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const authTime = Math.floor(now.getTime() / 1000) - 30;
    expect(evaluateOidcMfaAssurance(config(), { auth_time: authTime, amr: ['pwd', 'webauthn'] }, now))
      .toEqual({
        authMethod: 'oidc',
        mfaVerifiedAt: new Date(authTime * 1_000).toISOString(),
        mfaMethod: 'amr:webauthn',
      });
    expect(evaluateOidcMfaAssurance(config(), { auth_time: authTime, acr: 'urn:example:loa:2' }, now).mfaMethod)
      .toBe('acr:urn:example:loa:2');
    expect(evaluateOidcMfaAssurance(config(), { auth_time: authTime, amr: ['pwd'] }, now).mfaVerifiedAt)
      .toBeNull();
    expect(evaluateOidcMfaAssurance(config(), { auth_time: authTime - 601, amr: ['mfa'] }, now).mfaVerifiedAt)
      .toBeNull();
    expect(evaluateOidcMfaAssurance(config(), { amr: ['mfa'] }, now).mfaVerifiedAt)
      .toBeNull();
  });

  it('persists assurance only after callback identity and MFA evidence match signed step-up state', async () => {
    const cfg = config();
    const expectedUsername = oidcUsername(cfg, {
      subject: 'stable-subject', email: 'user@example.test', displayName: 'User', groups: [], issuer: cfg.oidcIssuer,
    });
    const request = buildAuthorizationUrl(cfg, '/governance/compliance', {
      stepUp: true,
      expectedUsername,
    });
    const nonce = new URL(request.url).searchParams.get('nonce')!;
    const authTime = Math.floor(Date.now() / 1000);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ id_token: 'signed-id-token' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    jest.mocked(jwtVerify).mockResolvedValue({
      payload: {
        sub: 'stable-subject', nonce, email: 'user@example.test', name: 'User',
        auth_time: authTime, amr: ['pwd', 'mfa'],
      },
      protectedHeader: { alg: 'RS256' },
    } as never);

    const result = await handleCallback(cfg, 'authorization-code', request.state, request.browserBinding);
    expect(result.assurance).toEqual({
      authMethod: 'oidc',
      mfaVerifiedAt: new Date(authTime * 1_000).toISOString(),
      mfaMethod: 'amr:mfa',
    });
    expect(result.redirectAfter).toBe('/governance/compliance');
    fetchSpy.mockRestore();
  });

  it('uses deny-safe role precedence from mapped IdP groups', () => {
    const cfg = config({
      oidcDefaultRole: 'chat_user',
      oidcGroupMap: {
        developers: 'developer',
        operations: 'operations_admin',
        unknown: 'not-a-real-role',
      },
    });
    expect(resolveOidcRole(cfg, ['developers', 'operations'])).toBe('operations_admin');
    expect(resolveOidcRole(cfg, [])).toBe('chat_user');
    expect(resolveOidcRole(cfg, ['unknown'])).toBe('chat_user');
  });

  it('allows an explicit group mapping to resolve below the default role', () => {
    const cfg = config({
      oidcDefaultRole: 'viewer',
      oidcGroupMap: { staff: 'chat_user' },
    });
    expect(resolveOidcRole(cfg, ['staff'])).toBe('chat_user');
  });

  it('namespaces generic identities by issuer while preserving the Entra identity format', () => {
    const user = {
      subject: 'stable-subject',
      email: 'user@example.test',
      displayName: 'User',
      groups: [],
      issuer: 'https://identity.example.test/realms/argus',
    };
    expect(oidcUsername(config(), user)).toMatch(/^oidc:[a-f0-9]{12}:stable-subject$/);
    expect(oidcUsername(config({ oidcProvider: 'entra' }), user)).toBe('entra:stable-subject');
  });
});

describe('OIDC browser binding and redirect safety', () => {
  it('rejects a callback relayed into a browser that did not start the flow, before token exchange', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const attacker = buildAuthorizationUrl(config(), '/home');
    await expect(handleCallback(config(), 'attacker-code', attacker.state, undefined))
      .rejects.toThrow('not bound to this browser');
    await expect(handleCallback(config(), 'attacker-code', attacker.state, 'victim-browser-value'))
      .rejects.toThrow('not bound to this browser');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('only keeps same-origin relative redirect targets', () => {
    expect(safeRedirectPath('/governance/compliance?tab=a#x')).toBe('/governance/compliance?tab=a#x');
    for (const value of [
      '/\\collector.example.test/path', '/\\\\collector.example.test', '//collector.example.test',
      'https://collector.example.test', '/\tcollector', '/%0d%0aSet-Cookie:x', 'javascript:alert(1)', '', undefined,
    ]) {
      const result = safeRedirectPath(value);
      expect(new URL(result, 'https://argus.example.test').origin).toBe('https://argus.example.test');
      expect(result.startsWith('//')).toBe(false);
      expect(result).not.toContain('\\');
    }
    expect(safeRedirectPath('/\\collector.example.test/path')).toBe('/status');
  });

  it('never signs an external redirect into state', async () => {
    const request = buildAuthorizationUrl(config(), '/\\collector.example.test/path');
    const payload = JSON.parse(Buffer.from(request.state.split('.')[0]!, 'base64url').toString('utf8')) as {
      redirectAfter: string; bh: string;
    };
    expect(payload.redirectAfter).toBe('/status');
    expect(payload.bh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.state).not.toContain(request.browserBinding);
  });
});
