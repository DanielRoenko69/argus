/**
 * Provider-neutral browser OIDC Authorization Code Flow.
 *
 * Security properties:
 * - authorization state is short-lived and HMAC authenticated;
 * - PKCE-S256 verifier is derived from that state and SESSION_SECRET, so a
 *   callback can land on any replica without sharing process memory;
 * - a fresh OIDC nonce is bound into the signed state and verified in the ID
 *   token;
 * - when Redis is enabled, state is consumed atomically to reject replay;
 * - the state carries a hash of a one-time browser-binding cookie, so a
 *   callback only completes in the browser that started the flow (login
 *   CSRF / session swap);
 * - post-login redirects are restricted to same-origin relative paths.
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getRedisClient, getRedisEnabled } from '../lib/redis.js';
import type { ArgusRole } from './roles.js';
import { resolveSsoRoleMapping, type SsoRoleMappingResult } from './ssoRoleMapping.js';

const AUTH_TIMEOUT_SECONDS = 10 * 60;
const STATE_VERSION = 1;
export const OIDC_BROWSER_BINDING_COOKIE = 'argus_oidc_binding';
const REDIRECT_BASE = 'https://argus.invalid';

interface OidcStatePayload {
  v: number;
  nonce: string;
  exp: number;
  redirectAfter: string;
  purpose?: 'login' | 'mfa_step_up' | 'link_identity';
  expectedUsername?: string;
  expectedUserId?: number;
  /** sha256 of the browser-binding cookie value. */
  bh?: string;
}

export interface OidcAuthorizationOptions {
  stepUp?: boolean;
  expectedUsername?: string;
  linkUserId?: number;
}

export type OidcCallbackPurpose = 'login' | 'mfa_step_up' | 'link_identity';

export interface OidcAuthAssurance {
  authMethod: 'oidc';
  mfaVerifiedAt: string | null;
  mfaMethod: string | null;
}

export interface OidcIdToken extends JWTPayload {
  [claim: string]: unknown;
}

export interface OidcUser {
  subject: string;
  email: string;
  displayName: string;
  groups: string[];
  issuer: string;
}

const jwksByUri = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(uri: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksByUri.get(uri);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(uri));
  jwksByUri.set(uri, jwks);
  return jwks;
}

function stateSecret(config: Config): Buffer {
  return createHmac('sha256', config.sessionSecret)
    .update('argus:interactive-oidc:state:v1')
    .digest();
}

function signStatePart(config: Config, encodedPayload: string): string {
  return createHmac('sha256', stateSecret(config)).update(encodedPayload).digest('base64url');
}

function encodeState(config: Config, payload: OidcStatePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signStatePart(config, encoded)}`;
}

function decodeState(config: Config, state: string): OidcStatePayload {
  const [encoded, signature, extra] = state.split('.');
  if (!encoded || !signature || extra) throw new Error('Invalid state parameter');
  const expected = Buffer.from(signStatePart(config, encoded), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Invalid state signature');
  }

  let payload: OidcStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OidcStatePayload;
  } catch {
    throw new Error('Invalid state payload');
  }
  if (payload.v !== STATE_VERSION || !payload.nonce || !Number.isFinite(payload.exp)) {
    throw new Error('Invalid state payload');
  }
  payload.purpose ??= 'login';
  if (payload.purpose !== 'login' && payload.purpose !== 'mfa_step_up' && payload.purpose !== 'link_identity') {
    throw new Error('Invalid state payload');
  }
  if (
    payload.purpose === 'mfa_step_up'
    && (!payload.expectedUsername || payload.expectedUsername.length > 512)
  ) {
    throw new Error('Invalid state payload');
  }
  if (
    payload.purpose === 'link_identity'
    && (!Number.isSafeInteger(payload.expectedUserId) || Number(payload.expectedUserId) < 1)
  ) {
    throw new Error('Invalid state payload');
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('Authentication request expired');
  }
  return payload;
}

/**
 * Same-origin relative path or the fallback. Rejects scheme-relative and
 * backslash forms (`//host`, `/\\host`) and control characters that browsers
 * normalise into an external Location.
 */
export function safeRedirectPath(value: unknown, fallback = '/status'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) return fallback;
  try {
    const parsed = new URL(value, REDIRECT_BASE);
    if (parsed.origin !== REDIRECT_BASE) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

function browserBindingHash(value: string): string {
  return createHash('sha256').update(`argus:oidc-browser-binding:${value}`).digest('base64url');
}

function assertBrowserBinding(payload: OidcStatePayload, browserBinding: string | undefined): void {
  if (!payload.bh || !browserBinding) throw new Error('OIDC callback is not bound to this browser');
  const expected = Buffer.from(payload.bh, 'utf8');
  const actual = Buffer.from(browserBindingHash(browserBinding), 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('OIDC callback is not bound to this browser');
  }
}

/** Set-Cookie value for the one-time browser binding (sent only to /auth callbacks). */
export function oidcBrowserBindingCookie(value: string, secure: boolean): string {
  const parts = [
    `${OIDC_BROWSER_BINDING_COOKIE}=${value}`,
    'Path=/auth',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${AUTH_TIMEOUT_SECONDS}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearOidcBrowserBindingCookie(): string {
  return `${OIDC_BROWSER_BINDING_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function deriveCodeVerifier(config: Config, nonce: string): string {
  return createHmac('sha256', stateSecret(config))
    .update(`argus:interactive-oidc:pkce:${nonce}`)
    .digest('base64url');
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function claimString(payload: OidcIdToken, name: string): string {
  const value = payload[name];
  return typeof value === 'string' ? value : '';
}

function claimStrings(payload: OidcIdToken, name: string): string[] {
  const value = payload[name];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

function configuredMfaAmrValues(config: Config): string[] {
  return config.oidcMfaAmrValues ?? ['mfa', 'otp', 'hwk', 'webauthn', 'fido'];
}

function configuredMfaAcrValues(config: Config): string[] {
  return config.oidcMfaAcrValues ?? [];
}

/**
 * Accept MFA only from signed ID-token claims and a recent auth_time. The
 * operator controls the accepted amr/acr vocabulary for their IdP.
 */
export function evaluateOidcMfaAssurance(
  config: Config,
  token: OidcIdToken,
  now = new Date(),
): OidcAuthAssurance {
  const authTime = typeof token.auth_time === 'number' ? token.auth_time : Number.NaN;
  const currentSeconds = Math.floor(now.getTime() / 1000);
  const maxAgeSeconds = config.oidcMfaMaxAgeSeconds ?? 600;
  const ageSeconds = currentSeconds - authTime;
  if (
    !Number.isInteger(authTime)
    || !Number.isFinite(currentSeconds)
    || ageSeconds < -60
    || ageSeconds > maxAgeSeconds
  ) {
    return { authMethod: 'oidc', mfaVerifiedAt: null, mfaMethod: null };
  }

  const acceptedAmr = new Set(configuredMfaAmrValues(config));
  const amr = claimStrings(token, 'amr').find(value => acceptedAmr.has(value));
  const acr = claimString(token, 'acr');
  const acceptedAcr = new Set(configuredMfaAcrValues(config));
  const method = amr ? `amr:${amr}` : (acr && acceptedAcr.has(acr) ? `acr:${acr}` : null);
  if (!method) return { authMethod: 'oidc', mfaVerifiedAt: null, mfaMethod: null };
  return {
    authMethod: 'oidc',
    mfaVerifiedAt: new Date(authTime * 1_000).toISOString(),
    mfaMethod: method,
  };
}

async function consumeState(config: Config, state: string, expiresAt: number): Promise<void> {
  if (!getRedisEnabled()) return;
  const redis = getRedisClient();
  if (!redis) throw new Error('OIDC replay store unavailable');
  const key = `argus:oidc:state:${createHash('sha256').update(state).digest('hex')}`;
  const ttl = Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
  const result = await redis.set(key, 'consumed', 'EX', ttl, 'NX');
  if (result !== 'OK') throw new Error('Authorization state already consumed');
}

export function buildAuthorizationUrl(
  config: Config,
  redirectAfter = '/status',
  options: OidcAuthorizationOptions = {},
): { url: string; state: string; browserBinding: string } {
  if (options.stepUp && !options.expectedUsername?.trim()) {
    throw new Error('OIDC MFA step-up requires the active SSO identity');
  }
  if (options.stepUp && options.linkUserId != null) {
    throw new Error('OIDC request cannot be both step-up and account linking');
  }
  if (options.linkUserId != null && (!Number.isSafeInteger(options.linkUserId) || options.linkUserId < 1)) {
    throw new Error('OIDC account linking requires the active local user');
  }
  const nonce = randomBytes(32).toString('base64url');
  const browserBinding = randomBytes(32).toString('base64url');
  const payload: OidcStatePayload = {
    v: STATE_VERSION,
    nonce,
    exp: Math.floor(Date.now() / 1000) + AUTH_TIMEOUT_SECONDS,
    redirectAfter: safeRedirectPath(redirectAfter),
    bh: browserBindingHash(browserBinding),
    purpose: options.stepUp ? 'mfa_step_up' : (options.linkUserId != null ? 'link_identity' : 'login'),
    expectedUsername: options.stepUp && options.expectedUsername
      ? options.expectedUsername.slice(0, 512)
      : undefined,
    expectedUserId: options.linkUserId,
  };
  const state = encodeState(config, payload);
  const verifier = deriveCodeVerifier(config, nonce);
  const params = new URLSearchParams({
    client_id: config.oidcClientId,
    response_type: 'code',
    redirect_uri: config.oidcRedirectUri,
    scope: config.oidcScopes,
    state,
    nonce,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  if (options.stepUp || options.linkUserId != null) {
    params.set('prompt', 'login');
    params.set('max_age', '0');
    const acrValues = configuredMfaAcrValues(config);
    if (acrValues.length > 0) params.set('acr_values', acrValues.join(' '));
  } else if (config.oidcProvider === 'entra') {
    params.set('prompt', 'select_account');
  }
  const authorizationUrl = new URL(config.oidcAuthorizationUrl);
  for (const [key, value] of params) authorizationUrl.searchParams.set(key, value);
  return { url: authorizationUrl.toString(), state, browserBinding };
}

export async function handleCallback(
  config: Config,
  code: string,
  state: string,
  browserBinding: string | undefined,
): Promise<{
  user: OidcUser;
  redirectAfter: string;
  assurance: OidcAuthAssurance;
  purpose: OidcCallbackPurpose;
  linkTargetUserId: number | null;
}> {
  const statePayload = decodeState(config, state);
  // Before any token exchange: the callback must arrive in the initiating browser.
  assertBrowserBinding(statePayload, browserBinding);
  await consumeState(config, state, statePayload.exp);

  const body = new URLSearchParams({
    client_id: config.oidcClientId,
    code,
    redirect_uri: config.oidcRedirectUri,
    grant_type: 'authorization_code',
    code_verifier: deriveCodeVerifier(config, statePayload.nonce),
  });
  if (config.oidcClientSecret) body.set('client_secret', config.oidcClientSecret);

  const response = await fetch(config.oidcTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    logger.error({ status: response.status, body: errorBody }, 'OIDC token exchange failed');
    throw new Error(`Token exchange failed: ${response.status}`);
  }
  const tokens = await response.json() as { id_token?: string; error?: string };
  if (tokens.error || !tokens.id_token) {
    throw new Error(`Token response error: ${tokens.error ?? 'no id_token'}`);
  }

  const { payload } = await jwtVerify(tokens.id_token, getJwks(config.oidcJwksUri), {
    issuer: config.oidcIssuer,
    audience: config.oidcClientId,
    requiredClaims: ['sub', 'nonce'],
  });
  const token = payload as OidcIdToken;
  if (token.nonce !== statePayload.nonce) throw new Error('ID token nonce mismatch');

  const subject = claimString(token, config.oidcSubjectClaim) || claimString(token, 'sub');
  if (!subject) throw new Error(`ID token missing ${config.oidcSubjectClaim}/sub claim`);
  const email = claimString(token, config.oidcEmailClaim)
    || claimString(token, 'email')
    || claimString(token, 'preferred_username');
  const displayName = claimString(token, config.oidcDisplayNameClaim)
    || email.split('@')[0]
    || 'OIDC User';
  const groups = claimStrings(token, config.oidcGroupsClaim);
  const user = { subject, email, displayName, groups, issuer: config.oidcIssuer };
  const assurance = evaluateOidcMfaAssurance(config, token);
  if (statePayload.purpose === 'mfa_step_up') {
    if (!statePayload.expectedUsername || oidcUsername(config, user) !== statePayload.expectedUsername) {
      throw new Error('OIDC MFA step-up identity does not match the active session');
    }
    if (!assurance.mfaVerifiedAt || !assurance.mfaMethod) {
      throw new Error('OIDC MFA step-up requirements were not satisfied');
    }
  }
  if (statePayload.purpose === 'link_identity' && (!assurance.mfaVerifiedAt || !assurance.mfaMethod)) {
    throw new Error('OIDC account linking requires fresh MFA assurance');
  }

  logger.info({ subject, email, displayName, groupCount: groups.length }, 'OIDC user authenticated');
  return {
    user,
    redirectAfter: safeRedirectPath(statePayload.redirectAfter),
    assurance,
    purpose: statePayload.purpose ?? 'login',
    linkTargetUserId: statePayload.purpose === 'link_identity'
      ? Number(statePayload.expectedUserId)
      : null,
  };
}

export function resolveOidcRoleMapping(config: Config, groups: string[]): SsoRoleMappingResult {
  const result = resolveSsoRoleMapping(config.oidcDefaultRole, groups, config.oidcGroupMap);
  logger.debug({ groups: groups.length, matchedGroups: result.matched.length, resolved: result.effectiveRole }, 'OIDC role resolved');
  return result;
}

export function resolveOidcRole(config: Config, groups: string[]): ArgusRole {
  return resolveOidcRoleMapping(config, groups).effectiveRole;
}

export function oidcUsername(config: Pick<Config, 'oidcProvider'>, user: OidcUser): string {
  if (config.oidcProvider === 'entra') return `entra:${user.subject}`;
  const issuerKey = createHash('sha256').update(user.issuer).digest('hex').slice(0, 12);
  return `oidc:${issuerKey}:${user.subject}`;
}

/** Test-only hook to avoid sharing remote JWKS instances between cases. */
export function clearOidcJwksCache(): void {
  jwksByUri.clear();
}
