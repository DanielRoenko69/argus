import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { stableAuditJson, type AuditJsonValue } from './canonicalAuditRedaction.js';

export const EXTERNAL_ANCHOR_KINDS = ['worm_object', 'qualified_timestamp', 'transparency_log'] as const;
export type ExternalAnchorKind = typeof EXTERNAL_ANCHOR_KINDS[number];

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_ARCHIVE_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_RESPONSE_BYTES = MAX_ARCHIVE_CONTENT_BYTES + 1024 * 1024;
const bounded = (maximum: number) => z.string().trim().min(1).max(maximum).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const statementSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('argus.external-evidence-anchor-statement'),
  anchorKind: z.enum(EXTERNAL_ANCHOR_KINDS),
  provider: bounded(240),
  reference: bounded(1_000),
  idempotencyKey: bounded(256),
  anchoredAt: z.string().datetime({ offset: true }),
  retentionUntil: z.string().datetime({ offset: true }).nullable(),
  artifact: z.object({
    type: z.enum(['audit_evidence_pack', 'audit_retention_archive']),
    id: z.string().uuid(),
    sha256,
  }).strict(),
  scope: z.object({
    workspaceKey: bounded(128),
    tenantKey: bounded(128),
    environment: bounded(64),
  }).strict(),
}).strict();
const signedReceiptSchema = z.object({
  statement: statementSchema,
  signature: z.object({
    algorithm: z.literal('Ed25519'),
    keyId: bounded(240),
    value: bounded(16_384),
  }).strict(),
}).strict();

export type ExternalAnchorStatement = z.infer<typeof statementSchema>;
export interface ExternalAnchorRequest {
  anchorKind: ExternalAnchorKind;
  artifact: ExternalAnchorStatement['artifact'];
  scope: { workspaceKey: string; tenantKey: string; environment: string };
  idempotencyKey: string;
  requestedAt: string;
  payload?: {
    mediaType: 'application/vnd.argus.audit-evidence-pack.v1+json' | 'application/vnd.argus.audit-retention-archive.v1+json';
    bytes: number;
    content: AuditJsonValue;
  };
  /** @deprecated v1 compatibility alias for retention archive callers. */
  archive?: {
    mediaType: 'application/vnd.argus.audit-retention-archive.v1+json';
    bytes: number;
    content: AuditJsonValue;
  };
}
export interface ExternalArchiveRetrieveRequest {
  schemaVersion: 1;
  kind: 'argus.external-retention-archive-retrieve-request';
  artifact: { type: 'audit_retention_archive'; id: string; sha256: string };
  scope: { workspaceKey: string; tenantKey: string; environment: string };
  reference: string;
  requestedAt: string;
}
export interface RetrievedExternalArchiveObject {
  schemaVersion: 1;
  kind: 'argus.external-retention-archive-object';
  reference: string;
  mediaType: 'application/vnd.argus.audit-retention-archive.v1+json';
  bytes: number;
  retrievedAt: string;
  content: AuditJsonValue;
}
export interface VerifiedExternalAnchorReceipt {
  schemaVersion: 1;
  kind: 'argus.external-evidence-anchor-receipt';
  statement: ExternalAnchorStatement;
  signature: { algorithm: 'Ed25519'; keyId: string; value: string };
  statementSha256: string;
  receiptSha256: string;
  verificationKeyFingerprint: string;
  verification: 'verified';
}
export interface ExternalEvidenceAnchorProvider {
  readonly name: string;
  readonly supportedKinds: readonly ExternalAnchorKind[];
  anchor(request: ExternalAnchorRequest): Promise<VerifiedExternalAnchorReceipt>;
  retrieveArchive?(request: ExternalArchiveRetrieveRequest): Promise<RetrievedExternalArchiveObject>;
  verifyStoredReceipt?(receipt: VerifiedExternalAnchorReceipt, request: ExternalAnchorRequest): VerifiedExternalAnchorReceipt;
}

export interface HttpSignedExternalAnchorProviderOptions {
  endpoint: string;
  providerName: string;
  keyId: string;
  publicKey: string | Buffer;
  bearerToken: string;
  supportedKinds?: readonly ExternalAnchorKind[];
  timeoutMs?: number;
  allowLocalHttp?: boolean;
  allowHttpHosts?: readonly string[];
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

const canonical = (value: unknown): string => stableAuditJson(JSON.parse(JSON.stringify(value)) as AuditJsonValue);
const digest = (value: unknown): string => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const keyFingerprint = (key: KeyObject): string => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');

function strictBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('external anchor receipt signature is not base64url');
  const decoded = Buffer.from(value, 'base64url');
  if (!decoded.length || decoded.toString('base64url') !== value.replace(/=+$/, '')) throw new Error('external anchor receipt signature is malformed');
  return decoded;
}

function endpointUrl(value: string, allowLocalHttp: boolean, allowHttpHosts: readonly string[] = []): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error('external anchor endpoint must not contain credentials or a fragment');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const allowedHttpHosts = new Set(allowHttpHosts.map(host => host.trim().toLowerCase()).filter(Boolean));
  const explicitlyAllowed = allowedHttpHosts.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(allowLocalHttp && (local || explicitlyAllowed) && url.protocol === 'http:')) {
    throw new Error('external anchor endpoint must use HTTPS (explicit local HTTP host opt-in required)');
  }
  return url;
}

export function verifyExternalAnchorReceipt(
  raw: unknown,
  request: ExternalAnchorRequest,
  trust: { providerName: string; keyId: string; publicKey: KeyObject; now: Date },
): VerifiedExternalAnchorReceipt {
  const receipt = signedReceiptSchema.parse(raw);
  const statement = receipt.statement;
  if (statement.provider !== trust.providerName || receipt.signature.keyId !== trust.keyId) throw new Error('external anchor receipt trust identity does not match configuration');
  if (statement.anchorKind !== request.anchorKind
    || statement.artifact.type !== request.artifact.type
    || statement.artifact.id !== request.artifact.id
    || statement.artifact.sha256 !== request.artifact.sha256
    || statement.idempotencyKey !== request.idempotencyKey
    || statement.scope.workspaceKey !== request.scope.workspaceKey
    || statement.scope.tenantKey !== request.scope.tenantKey
    || statement.scope.environment !== request.scope.environment) {
    throw new Error('external anchor receipt does not bind the requested artifact');
  }
  const anchoredAt = Date.parse(statement.anchoredAt);
  const requestedAt = Date.parse(request.requestedAt);
  if (!Number.isFinite(anchoredAt) || !Number.isFinite(requestedAt)
    || anchoredAt < requestedAt - 300_000 || anchoredAt > trust.now.getTime() + 300_000) {
    throw new Error('external anchor receipt timestamp is outside the accepted clock window');
  }
  if (statement.anchorKind === 'worm_object') {
    const retentionUntil = statement.retentionUntil ? Date.parse(statement.retentionUntil) : Number.NaN;
    if (!Number.isFinite(retentionUntil) || retentionUntil <= anchoredAt) throw new Error('WORM receipt requires a future retentionUntil timestamp');
  }
  const payload = Buffer.from(canonical(statement), 'utf8');
  if (!verify(null, payload, trust.publicKey, strictBase64Url(receipt.signature.value))) {
    throw new Error('external anchor receipt signature is invalid');
  }
  const statementSha256 = createHash('sha256').update(payload).digest('hex');
  return {
    schemaVersion: 1,
    kind: 'argus.external-evidence-anchor-receipt',
    statement,
    signature: receipt.signature,
    statementSha256,
    receiptSha256: digest(receipt),
    verificationKeyFingerprint: keyFingerprint(trust.publicKey),
    verification: 'verified',
  };
}

export class HttpSignedExternalAnchorProvider implements ExternalEvidenceAnchorProvider {
  readonly name: string;
  readonly supportedKinds: readonly ExternalAnchorKind[];
  private readonly endpoint: URL;
  private readonly keyId: string;
  private readonly publicKey: KeyObject;
  private readonly bearerToken: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpSignedExternalAnchorProviderOptions) {
    this.name = bounded(240).parse(options.providerName);
    this.keyId = bounded(240).parse(options.keyId);
    this.endpoint = endpointUrl(options.endpoint, options.allowLocalHttp === true, options.allowHttpHosts);
    this.publicKey = createPublicKey(options.publicKey);
    if (this.publicKey.asymmetricKeyType !== 'ed25519') throw new Error('external anchor verification key must be Ed25519');
    this.bearerToken = bounded(16_384).parse(options.bearerToken);
    this.supportedKinds = [...new Set((options.supportedKinds ?? EXTERNAL_ANCHOR_KINDS)
      .map(kind => z.enum(EXTERNAL_ANCHOR_KINDS).parse(kind)))];
    if (!this.supportedKinds.length) throw new Error('external anchor provider must support at least one anchor kind');
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs)) throw new Error('external anchor timeout must be an integer');
    this.timeoutMs = Math.min(Math.max(timeoutMs, 1_000), 30_000);
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async anchor(request: ExternalAnchorRequest): Promise<VerifiedExternalAnchorReceipt> {
    if (!this.supportedKinds.includes(request.anchorKind)) throw new Error(`external anchor kind '${request.anchorKind}' is not supported by ${this.name}`);
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: `Bearer ${this.bearerToken}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, kind: 'argus.external-evidence-anchor-request', ...request }),
    });
    if (!response.ok) throw new Error(`external anchor provider rejected the request (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 128 * 1024) throw new Error('external anchor provider returned an invalid receipt size');
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('external anchor provider returned invalid JSON'); }
    return verifyExternalAnchorReceipt(raw, request, { providerName: this.name, keyId: this.keyId, publicKey: this.publicKey, now: this.now() });
  }

  verifyStoredReceipt(receipt: VerifiedExternalAnchorReceipt, request: ExternalAnchorRequest): VerifiedExternalAnchorReceipt {
    return verifyExternalAnchorReceipt(
      { statement: receipt.statement, signature: receipt.signature },
      request,
      { providerName: this.name, keyId: this.keyId, publicKey: this.publicKey, now: this.now() },
    );
  }

  async retrieveArchive(request: ExternalArchiveRetrieveRequest): Promise<RetrievedExternalArchiveObject> {
    if (request.artifact.type !== 'audit_retention_archive') throw new Error('only retention archives can be retrieved');
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: `Bearer ${this.bearerToken}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`external archive provider rejected retrieval (${response.status})`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_RESPONSE_BYTES) {
      throw new Error('external archive provider response exceeds the bounded restore envelope size');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_ARCHIVE_RESPONSE_BYTES) throw new Error('external archive provider returned an invalid archive size');
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('external archive provider returned invalid JSON'); }
    const parsed = z.object({
      schemaVersion: z.literal(1),
      kind: z.literal('argus.external-retention-archive-object'),
      reference: bounded(1_000),
      mediaType: z.literal('application/vnd.argus.audit-retention-archive.v1+json'),
      bytes: z.number().int().positive().max(MAX_ARCHIVE_CONTENT_BYTES),
      retrievedAt: z.string().datetime({ offset: true }),
      content: z.unknown(),
    }).strict().parse(raw);
    if (parsed.reference !== request.reference) throw new Error('retrieved archive reference does not match the immutable receipt');
    const canonicalBytes = Buffer.byteLength(canonical(parsed.content), 'utf8');
    if (canonicalBytes !== parsed.bytes) throw new Error('retrieved archive byte count is invalid');
    return parsed as RetrievedExternalArchiveObject;
  }
}

function readBoundedFile(filename: string, maximum: number, label: string): Buffer {
  const bytes = readFileSync(filename);
  if (!bytes.length || bytes.length > maximum) throw new Error(`${label} has an invalid size`);
  return bytes;
}

export function loadExternalEvidenceAnchorProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ExternalEvidenceAnchorProvider | null {
  if (env['ARGUS_EXTERNAL_ANCHOR_ENABLED'] !== 'true') return null;
  const endpoint = env['ARGUS_EXTERNAL_ANCHOR_URL']?.trim() ?? '';
  const providerName = env['ARGUS_EXTERNAL_ANCHOR_PROVIDER']?.trim() ?? '';
  const keyId = env['ARGUS_EXTERNAL_ANCHOR_KEY_ID']?.trim() ?? '';
  const publicKeyFile = env['ARGUS_EXTERNAL_ANCHOR_PUBLIC_KEY_FILE']?.trim() ?? '';
  const tokenFile = env['ARGUS_EXTERNAL_ANCHOR_TOKEN_FILE']?.trim() ?? '';
  if (!endpoint || !providerName || !keyId || !publicKeyFile || !tokenFile) {
    throw new Error('External anchoring requires URL, provider, key ID, public-key file and token file');
  }
  const kinds = (env['ARGUS_EXTERNAL_ANCHOR_KINDS'] ?? EXTERNAL_ANCHOR_KINDS.join(','))
    .split(',').map(value => value.trim()).filter(Boolean).map(value => z.enum(EXTERNAL_ANCHOR_KINDS).parse(value));
  const token = readBoundedFile(tokenFile, 16 * 1024, 'external anchor token').toString('utf8').trim();
  return new HttpSignedExternalAnchorProvider({
    endpoint, providerName, keyId, bearerToken: token,
    publicKey: readBoundedFile(publicKeyFile, 16 * 1024, 'external anchor public key'),
    supportedKinds: kinds,
    timeoutMs: Number(env['ARGUS_EXTERNAL_ANCHOR_TIMEOUT_MS'] ?? 10_000),
    allowLocalHttp: env['ARGUS_EXTERNAL_ANCHOR_ALLOW_LOCAL_HTTP'] === 'true',
    allowHttpHosts: (env['ARGUS_EXTERNAL_ANCHOR_HTTP_HOSTS'] ?? '').split(',').map(value => value.trim()).filter(Boolean),
  });
}
