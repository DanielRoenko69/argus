/**
 * Webhook-Signature-Verification — HMAC-SHA256 over raw request body.
 *
 * Verteidigt gegen Spoofing: nur wer das shared secret kennt kann gültige
 * Webhooks an Argus senden. Critical für Auto-Trigger-Endpoints wie
 * /api/coding/webhook/jira-comment die Workflows auslösen.
 *
 * Pattern (industry-standard):
 *   Sender:  signature = HMAC_SHA256(secret, rawBody)
 *            Header:  X-Argus-Signature: sha256=<hex>
 *   Receiver: vergleicht timing-safe gegen erwarteten Wert
 *
 * Failure-Modes:
 *   - Secret nicht konfiguriert → in production fail-CLOSED (503),
 *     in development standardmäßig fail-OPEN (warn + next); sicherheitskritische
 *     Endpunkte können dies mit `allowMissingInDevelopment: false` abschalten
 *   - Header fehlt           → 401
 *   - Signature mismatch     → 403
 *   - Rohbody fehlt          → 500 (Wiring-Bug; sollte nie passieren wenn
 *     express.json({verify}) korrekt eingerichtet ist)
 *
 * Default Header: "x-argus-signature" mit Prefix "sha256=" (kompatibel
 * zu GitHub/Stripe/n8n Conventions).
 */

import type { RequestHandler } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from './logger.js';

export interface VerifyWebhookOptions {
  /** Name of the env-var holding the shared HMAC secret (e.g. "JIRA_WEBHOOK_SECRET") */
  secretEnvVar: string;
  /** Header to read signature from (default: x-argus-signature) */
  headerName?: string;
  /** "sha256" oder "sha512" (default: sha256) */
  algorithm?: 'sha256' | 'sha512';
  /** Strip leading prefix (default: "sha256=") to allow GitHub-style headers */
  stripPrefix?: string | null;
  /**
   * Missing secrets normally fail open outside production for legacy local
   * webhook flows. Set this to false for endpoints that must stay fail-closed
   * in every environment.
   */
  allowMissingInDevelopment?: boolean;
}

export interface VerifyWebhookTokenOptions {
  /** Env-var containing a provider token (for example GitLab's Secret Token). */
  secretEnvVar: string;
  /** Header to read the token from (default: x-argus-webhook-token). */
  headerName?: string;
}

interface RawBodyReq {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/** Outcome of a signature check. `ok:true` means proceed (incl. dev fail-open). */
export interface SignatureCheckResult {
  ok: boolean;
  /** HTTP status to return when `ok` is false. */
  status?: number;
  /** Error message body when `ok` is false. */
  error?: string;
  /** True when the secret was missing and we allowed in dev (not secure). */
  failOpen?: boolean;
}

interface CheckParams {
  /** The resolved secret value, or undefined when the env-var is unset. */
  secret: string | undefined;
  /** Raw request body (Buffer) captured by express.json({verify}). */
  rawBody: Buffer | undefined;
  /** The raw signature header value, if present. */
  signatureHeader: string | string[] | undefined;
  /** True in production — controls fail-closed vs fail-open on a missing secret. */
  isProduction: boolean;
  algorithm?: 'sha256' | 'sha512';
  stripPrefix?: string | null;
  /** For log context only. */
  secretEnvVar?: string;
  path?: string;
}

/**
 * Pure-ish HMAC signature check shared by the middleware and by callers that
 * must resolve the secret dynamically (e.g. the webhook trigger route picks a
 * PER-WORKFLOW secret env-var before it can verify). Reads no env itself — the
 * caller resolves `secret` so the same primitive serves the global and the
 * per-workflow secret cases.
 */
export function checkWebhookSignature(params: CheckParams): SignatureCheckResult {
  const algorithm = params.algorithm ?? 'sha256';
  const prefix    = params.stripPrefix === null ? null : (params.stripPrefix ?? `${algorithm}=`);

  if (!params.secret) {
    if (params.isProduction) {
      logger.error({ envVar: params.secretEnvVar, path: params.path }, 'webhook-signature: secret not configured in production — refusing');
      return { ok: false, status: 503, error: `Webhook secret ${params.secretEnvVar ?? ''} not configured`.trim() };
    }
    logger.warn({ envVar: params.secretEnvVar, path: params.path }, 'webhook-signature: secret missing in dev → fail-open, NOT secure');
    return { ok: true, failOpen: true };
  }

  if (!params.rawBody) {
    logger.error({ path: params.path }, 'webhook-signature: rawBody missing — body-parser misconfig?');
    return { ok: false, status: 500, error: 'Server cannot verify signature (raw body unavailable)' };
  }

  const headerVal = Array.isArray(params.signatureHeader) ? params.signatureHeader[0] : params.signatureHeader;
  if (!headerVal || typeof headerVal !== 'string') {
    return { ok: false, status: 401, error: 'Missing signature header' };
  }

  const provided = prefix && headerVal.startsWith(prefix)
    ? headerVal.slice(prefix.length)
    : headerVal;

  const expected = createHmac(algorithm, params.secret).update(params.rawBody).digest('hex');

  try {
    const providedBuf = Buffer.from(provided, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      logger.warn({ path: params.path, providedLen: provided.length }, 'webhook-signature: invalid signature');
      return { ok: false, status: 403, error: 'Invalid signature' };
    }
  } catch (err) {
    logger.warn({ err, path: params.path }, 'webhook-signature: malformed signature');
    return { ok: false, status: 403, error: 'Malformed signature' };
  }

  return { ok: true };
}

export function verifyWebhookSignature(opts: VerifyWebhookOptions): RequestHandler {
  const headerName = (opts.headerName ?? 'x-argus-signature').toLowerCase();

  return (req, res, next) => {
    const rawReq = req as unknown as RawBodyReq;
    const result = checkWebhookSignature({
      secret: process.env[opts.secretEnvVar],
      rawBody: rawReq.rawBody,
      signatureHeader: rawReq.headers[headerName],
      isProduction:
        process.env['NODE_ENV'] === 'production'
        || opts.allowMissingInDevelopment === false,
      algorithm: opts.algorithm,
      stripPrefix: opts.stripPrefix,
      secretEnvVar: opts.secretEnvVar,
      path: req.path,
    });

    if (!result.ok) {
      res.status(result.status ?? 403).json({ error: result.error ?? 'Invalid signature' });
      return;
    }
    next();
  };
}

/**
 * Verify provider webhook tokens that are not HMAC signatures.
 *
 * GitLab and many Jenkins webhook plugins send a shared token in a header
 * instead of signing the raw body. Keep the same fail-closed production
 * semantics as HMAC verification and compare in constant time.
 */
export function verifyWebhookToken(opts: VerifyWebhookTokenOptions): RequestHandler {
  const headerName = (opts.headerName ?? 'x-argus-webhook-token').toLowerCase();

  return (req, res, next) => {
    const secret = process.env[opts.secretEnvVar];
    if (!secret) {
      if (process.env['NODE_ENV'] === 'production') {
        logger.error({ envVar: opts.secretEnvVar, path: req.path }, 'webhook-token: secret not configured in production — refusing');
        res.status(503).json({ error: `Webhook secret ${opts.secretEnvVar} not configured` });
        return;
      }
      logger.warn({ envVar: opts.secretEnvVar, path: req.path }, 'webhook-token: secret missing in dev → fail-open, NOT secure');
      next();
      return;
    }

    const rawReq = req as unknown as RawBodyReq;
    const headerValue = rawReq.headers[headerName];
    const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!provided || typeof provided !== 'string') {
      res.status(401).json({ error: 'Missing webhook token' });
      return;
    }

    const expectedBuffer = Buffer.from(secret, 'utf8');
    const providedBuffer = Buffer.from(provided, 'utf8');
    if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
      logger.warn({ path: req.path }, 'webhook-token: invalid token');
      res.status(403).json({ error: 'Invalid webhook token' });
      return;
    }
    next();
  };
}
