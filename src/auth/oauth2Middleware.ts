/**
 * OAuth 2.0 JWT Validation Middleware
 * Validates Bearer tokens against a JWKS endpoint (e.g., Microsoft Entra ID).
 * Works alongside API key auth — if a valid JWT is found, API key check is skipped.
 *
 * SECURITY: a valid signature alone never grants access. Issuer and audience
 * are mandatory, and the token subject must map to an enabled Argus user. The
 * request then carries that user's identity, role and Bundle scope so MCP
 * tool filtering and user-policy hooks apply exactly as for API keys bound to
 * a user. Unmapped subjects fail closed instead of receiving an unrestricted
 * context.
 */

import type { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import type { Config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { withRequestContext } from '../lib/requestContext.js';
import { oidcUsername } from './oidcAuth.js';

let jwks: JWTVerifyGetKey | null = null;

export interface OAuth2User {
  sub: string;
  email?: string;
  name?: string;
  roles?: string[];
  groups?: string[];
  raw: JWTPayload;
}

/** Argus account an OAuth2 subject is bound to. */
export interface OAuth2BoundUser {
  id: number;
  username: string;
  role: string;
  allowed_bundles: number[] | null;
  enabled: boolean;
  entra_groups: string[] | null;
}

export type OAuth2UserResolver = (username: string) => Promise<OAuth2BoundUser | null>;

type OAuth2Config = Pick<Config,
  'oauth2Enabled' | 'oauth2Issuer' | 'oauth2Audience' | 'oauth2JwksUri' | 'oidcProvider' | 'oidcSubjectClaim'>;

/** Fail startup when OAuth2 is enabled without the claims it must verify. */
export function assertOAuth2Config(config: OAuth2Config): void {
  if (!config.oauth2Enabled) return;
  const missing = [
    !config.oauth2Issuer.trim() && 'OAUTH2_ISSUER',
    !config.oauth2Audience.trim() && 'OAUTH2_AUDIENCE',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`OAUTH2_ENABLED=true requires ${missing.join(' and ')} so bearer tokens are bound to this Argus API`);
  }
}

/**
 * Initialize the JWKS key set (called once at startup).
 */
export function initOAuth2(config: Config): void {
  if (!config.oauth2Enabled) return;
  assertOAuth2Config(config);

  const jwksUrl = config.oauth2JwksUri || `${config.oauth2Issuer.replace(/\/$/, '')}/discovery/v2.0/keys`;
  jwks = createRemoteJWKSet(new URL(jwksUrl));
  logger.info({ jwksUri: jwksUrl, audience: config.oauth2Audience, issuer: config.oauth2Issuer }, 'OAuth2 JWT validation initialized');
}

/** Test-only hook to inject a local key set. */
export function setOAuth2KeySetForTests(keySet: JWTVerifyGetKey | null): void {
  jwks = keySet;
}

/** Same account naming as interactive OIDC login, so both paths bind to one user. */
export function oauth2Username(config: OAuth2Config, payload: JWTPayload): string | null {
  const configured = payload[config.oidcSubjectClaim];
  const subject = typeof configured === 'string' && configured.trim()
    ? configured.trim()
    : typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (!subject) return null;
  return oidcUsername(config, {
    subject,
    email: '',
    displayName: '',
    groups: [],
    issuer: config.oauth2Issuer,
  });
}

/**
 * Middleware that validates OAuth 2.0 JWT tokens.
 * If a valid JWT is present, attaches user info to req and calls next().
 * If no JWT is present (or OAuth2 is disabled), calls next() — fallback to API key auth.
 * Rejects if a JWT IS present but invalid or not mapped to an enabled Argus user.
 */
export function createOAuth2Middleware(config: OAuth2Config, resolveUser?: OAuth2UserResolver) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.oauth2Enabled || !jwks) {
      next();
      return;
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      // No Bearer token — let API key middleware handle it
      next();
      return;
    }

    const token = authHeader.slice(7);

    // Skip if it looks like an API key (short, no dots = not a JWT)
    if (!token.includes('.')) {
      next();
      return;
    }

    if (!config.oauth2Issuer || !config.oauth2Audience) {
      res.status(401).json({ error: 'OAuth2 bearer tokens are not accepted: issuer/audience not configured' });
      return;
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: config.oauth2Issuer,
        audience: config.oauth2Audience,
        requiredClaims: ['sub', 'exp'],
      }));
    } catch (err) {
      logger.warn({ err }, 'OAuth2 JWT validation failed');
      res.status(401).json({ error: 'Invalid or expired JWT token' });
      return;
    }

    const username = oauth2Username(config, payload);
    let bound: OAuth2BoundUser | null = null;
    if (username && resolveUser) {
      try {
        bound = await resolveUser(username);
      } catch (err) {
        logger.error({ err }, 'OAuth2 user binding lookup failed');
        res.status(503).json({ error: 'OAuth2 identity binding is temporarily unavailable' });
        return;
      }
    }
    if (!bound || !bound.enabled) {
      logger.warn({ sub: payload.sub }, 'OAuth2 JWT rejected — subject is not mapped to an enabled Argus user');
      res.status(403).json({ error: 'OAuth2 identity is not mapped to an enabled Argus user' });
      return;
    }

    const user: OAuth2User = {
      sub: String(payload.sub),
      email: (payload.email as string) || (payload.preferred_username as string) || undefined,
      name: (payload.name as string) || undefined,
      roles: Array.isArray(payload.roles) ? payload.roles as string[] : [],
      groups: Array.isArray(payload.groups) ? payload.groups as string[] : [],
      raw: payload,
    };
    const groups = bound.entra_groups ?? [];
    const r = req as unknown as Record<string, unknown>;
    r.oauth2User = user;
    r.apiKeyPrefix = `oauth2:${bound.id}`;
    r.authenticated = true;
    // Scope comes from the bound Argus account, never from token claims.
    r.allowedBundles = bound.allowed_bundles ?? null;
    r.allowedTools = null;
    r.deniedTools = null;
    r.tenantKey = 'default';
    r.workspaceKey = 'default';
    r.callingUser = { id: bound.id, username: bound.username, role: bound.role, entra_groups: groups };

    logger.debug({ sub: user.sub, userId: bound.id }, 'OAuth2 JWT validated and bound');
    withRequestContext(
      { callingUser: { id: bound.id, username: bound.username, role: bound.role, entra_groups: groups } },
      () => { next(); },
    );
  };
}
