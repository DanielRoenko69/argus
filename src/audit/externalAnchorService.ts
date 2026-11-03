import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { executeCanonicalAuditedMutation } from './canonicalAuditStore.js';
import { stableAuditJson, type AuditJsonValue } from './canonicalAuditRedaction.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary, CanonicalAuditScope } from './canonicalAuditTypes.js';
import type {
  ExternalAnchorKind,
  ExternalAnchorRequest,
  ExternalEvidenceAnchorProvider,
  VerifiedExternalAnchorReceipt,
} from './externalAnchorProvider.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@|/-]{0,255}$/;

export interface ExternalEvidenceAnchorRecord {
  schemaVersion: 1;
  kind: 'argus.external-evidence-anchor';
  anchorId: string;
  reportRunId: string;
  scope: { workspaceKey: string; tenantKey: string; environment: string };
  packId: string;
  packSha256: string;
  anchorKind: ExternalAnchorKind;
  provider: string;
  reference: string;
  anchoredAt: string;
  retentionUntil: string | null;
  statementSha256: string;
  receiptSha256: string;
  verificationKeyId: string;
  verificationKeyFingerprint: string;
  verification: 'verified';
  receipt: VerifiedExternalAnchorReceipt;
  createdAt: string;
}

export interface ExternalAnchorContext {
  scope: CanonicalAuditScope;
  actor: CanonicalAuditActor;
  producerEventId: string;
  requestId?: string | null;
  mfaVerifiedAt: string;
  mfaMethod: string;
  mfaMaxAgeSeconds: number;
  now?: () => Date;
  uuid?: () => string;
}

export interface ExternalAnchorMutationResult {
  anchor: ExternalEvidenceAnchorRecord;
  replayed: boolean;
  auditEvent: CanonicalAuditEventSummary;
}

type Row = Record<string, unknown>;
type ReportRow = { id: string; workspace_key: string; tenant_key: string; environment: string; status: string; verification_state: string | null; pack_id: string | null; pack_digest: string | null; evidence_pack: AuditJsonValue | null };

const canonical = (value: unknown): string => stableAuditJson(JSON.parse(JSON.stringify(value)) as AuditJsonValue);
const digest = (value: unknown): string => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const iso = (value: unknown): string => new Date(value as string | number | Date).toISOString();

function required(value: unknown, name: string, maximum = 256): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function identifier(value: unknown, name: string, maximum = 256): string {
  const normalized = required(value, name, maximum);
  if (!IDENTIFIER.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function normalizedScope(context: ExternalAnchorContext): Required<CanonicalAuditScope> {
  return {
    workspaceKey: identifier(context.scope.workspaceKey ?? 'default', 'workspaceKey', 128),
    tenantKey: identifier(context.scope.tenantKey ?? 'default', 'tenantKey', 128),
    environment: identifier(context.scope.environment, 'environment', 64),
  };
}

function assertAssurance(context: ExternalAnchorContext, now: Date): { actorId: string; ssoSubject: string } {
  if (context.actor.type !== 'human' || context.actor.authMethod !== 'oidc' || !context.actor.ssoSubject) {
    throw new Error('External anchoring requires a verified OIDC/Entra identity');
  }
  const verifiedAt = Date.parse(context.mfaVerifiedAt);
  if (!Number.isFinite(verifiedAt) || !context.mfaMethod.trim() || verifiedAt > now.getTime() + 30_000
    || now.getTime() - verifiedAt > context.mfaMaxAgeSeconds * 1_000) {
    throw new Error('External anchoring requires fresh MFA verification');
  }
  return { actorId: required(context.actor.id, 'actor.id', 200), ssoSubject: required(context.actor.ssoSubject, 'actor.ssoSubject', 512) };
}

function nextUuid(context: ExternalAnchorContext): string {
  const value = (context.uuid ?? randomUUID)();
  if (!UUID.test(value)) throw new Error('anchorId must be a UUID');
  return value;
}

function assertReceipt(receipt: VerifiedExternalAnchorReceipt, request: ExternalAnchorRequest, provider: ExternalEvidenceAnchorProvider): void {
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'argus.external-evidence-anchor-receipt' || receipt.verification !== 'verified') throw new Error('external anchor adapter returned an unverified receipt');
  if (receipt.statement.provider !== provider.name || receipt.statement.anchorKind !== request.anchorKind
    || receipt.statement.artifact.type !== request.artifact.type || receipt.statement.artifact.id !== request.artifact.id
    || receipt.statement.artifact.sha256 !== request.artifact.sha256
    || receipt.statement.idempotencyKey !== request.idempotencyKey
    || receipt.statement.scope.workspaceKey !== request.scope.workspaceKey
    || receipt.statement.scope.tenantKey !== request.scope.tenantKey
    || receipt.statement.scope.environment !== request.scope.environment) throw new Error('external anchor adapter receipt does not match the requested Evidence Pack');
  if (!SHA256.test(receipt.statementSha256) || !SHA256.test(receipt.receiptSha256) || !SHA256.test(receipt.verificationKeyFingerprint)) throw new Error('external anchor adapter returned malformed digests');
  if (digest(receipt.statement) !== receipt.statementSha256
    || digest({ statement: receipt.statement, signature: receipt.signature }) !== receipt.receiptSha256) throw new Error('external anchor receipt digest verification failed');
}

function mapRow(row: Row): ExternalEvidenceAnchorRecord {
  const receipt = row['receipt_json'] as VerifiedExternalAnchorReceipt;
  return {
    schemaVersion: 1, kind: 'argus.external-evidence-anchor', anchorId: String(row['anchor_id']),
    reportRunId: String(row['report_run_id']), packId: String(row['pack_id']), packSha256: String(row['pack_sha256']),
    scope: { workspaceKey: String(row['workspace_key']), tenantKey: String(row['tenant_key']), environment: String(row['environment']) },
    anchorKind: row['anchor_kind'] as ExternalAnchorKind, provider: String(row['provider']), reference: String(row['reference']),
    anchoredAt: iso(row['anchored_at']), retentionUntil: row['retention_until'] == null ? null : iso(row['retention_until']),
    statementSha256: String(row['statement_sha256']), receiptSha256: String(row['receipt_sha256']),
    verificationKeyId: String(row['verification_key_id']), verificationKeyFingerprint: String(row['verification_key_fingerprint']),
    verification: 'verified', receipt, createdAt: iso(row['created_at']),
  };
}

export async function listExternalEvidenceAnchors(pool: Pick<pg.Pool, 'query'>, reportRunIds: string[]): Promise<ExternalEvidenceAnchorRecord[]> {
  if (!reportRunIds.length) return [];
  const result = await pool.query(
    `SELECT * FROM mcp_external_evidence_anchors WHERE report_run_id=ANY($1::uuid[]) ORDER BY anchored_at DESC, anchor_id`,
    [reportRunIds],
  );
  return (result.rows as Row[]).map(mapRow);
}

export async function anchorAuditEvidencePack(
  pool: pg.Pool,
  context: ExternalAnchorContext,
  reportRunId: string,
  anchorKind: ExternalAnchorKind,
  provider: ExternalEvidenceAnchorProvider,
): Promise<ExternalAnchorMutationResult> {
  if (!UUID.test(reportRunId)) throw new Error('reportRunId must be a UUID');
  if (!provider.supportedKinds.includes(anchorKind)) throw new Error(`Configured provider does not support '${anchorKind}'`);
  const authorized = normalizedScope(context);
  const now = (context.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('now is invalid');
  const assurance = assertAssurance(context, now);
  const producerEventId = identifier(context.producerEventId, 'producerEventId');
  const outcome = await executeCanonicalAuditedMutation<ExternalEvidenceAnchorRecord>(
    pool,
    { name: 'audit.external-anchor', eventId: producerEventId },
    authorized,
    async client => {
      const result = await client.query<ReportRow>(
        `SELECT id,workspace_key,tenant_key,environment,status,verification_state,pack_id,pack_digest,evidence_pack
           FROM mcp_audit_report_runs
          WHERE id=$1 AND workspace_key=$2 AND tenant_key=$3 AND environment=$4
          FOR SHARE`,
        [reportRunId, authorized.workspaceKey, authorized.tenantKey, authorized.environment],
      );
      const report = result.rows[0];
      if (!report) throw new Error('audit report was not found in the authorized scope');
      if (report.status !== 'completed' || report.verification_state !== 'valid' || !report.pack_id || !report.pack_digest || !report.evidence_pack) throw new Error('only a completed and verified Evidence Pack can be externally anchored');
      const storedPack = report.evidence_pack as Record<string, AuditJsonValue>;
      const { packDigest: embeddedPackDigest, ...unsignedPack } = storedPack;
      const packJson = canonical(storedPack);
      const manifest = storedPack['manifest'] as Record<string, AuditJsonValue> | undefined;
      const manifestScope = manifest?.['scope'];
      if (embeddedPackDigest !== report.pack_digest
        || createHash('sha256').update(canonical(unsignedPack), 'utf8').digest('hex') !== report.pack_digest
        || manifest?.['packId'] !== report.pack_id || !manifestScope || canonical(manifestScope) !== canonical(authorized)) {
        throw new Error('stored Evidence Pack no longer matches its verified digest');
      }
      const request: ExternalAnchorRequest = {
        anchorKind,
        artifact: { type: 'audit_evidence_pack', id: report.pack_id, sha256: report.pack_digest },
        scope: authorized,
        idempotencyKey: producerEventId,
        requestedAt: now.toISOString(),
        payload: {
          mediaType: 'application/vnd.argus.audit-evidence-pack.v1+json',
          bytes: Buffer.byteLength(packJson, 'utf8'),
          content: JSON.parse(packJson) as AuditJsonValue,
        },
      };
      const receipt = await provider.anchor(request);
      assertReceipt(receipt, request, provider);
      const anchorId = nextUuid(context);
      const inserted = await client.query(
        `INSERT INTO mcp_external_evidence_anchors
          (anchor_id,report_run_id,workspace_key,tenant_key,environment,pack_id,pack_sha256,anchor_kind,provider,reference,anchored_at,retention_until,statement_sha256,receipt_sha256,verification_key_id,verification_key_fingerprint,receipt_json,requested_by_id,actor_sso_subject,mfa_verified_at,mfa_method,producer_event_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23)
         RETURNING *`,
        [anchorId, reportRunId, authorized.workspaceKey, authorized.tenantKey, authorized.environment,
          report.pack_id, report.pack_digest, anchorKind, provider.name, receipt.statement.reference,
          receipt.statement.anchoredAt, receipt.statement.retentionUntil, receipt.statementSha256, receipt.receiptSha256,
          receipt.signature.keyId, receipt.verificationKeyFingerprint, JSON.stringify(receipt), assurance.actorId,
          assurance.ssoSubject, context.mfaVerifiedAt, context.mfaMethod.trim(), producerEventId, now.toISOString()],
      );
      return mapRow(inserted.rows[0] as Row);
    },
    anchor => ({
      occurredAt: now, ...authorized, solution: 'argus.core', actor: context.actor,
      action: 'audit.evidence_pack.externally_anchored', outcome: 'success', risk: 'critical',
      resource: { type: 'audit_evidence_pack', id: anchor.packId, revision: anchor.packSha256 },
      policy: { id: 'argus.audit.external-anchor', version: '1', decision: 'verified' },
      correlation: { requestId: context.requestId ?? producerEventId },
      payload: { after: { anchorId: anchor.anchorId, anchorKind: anchor.anchorKind, provider: anchor.provider, receiptSha256: anchor.receiptSha256, verificationKeyFingerprint: anchor.verificationKeyFingerprint } },
      retentionClass: 'business-audit-ai-system', legalHold: true,
    }),
    { now: () => now },
  );
  let anchor = outcome.result;
  if (!anchor) {
    const existing = await pool.query(
      `SELECT * FROM mcp_external_evidence_anchors
        WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND producer_event_id=$4 AND provider=$5
          AND report_run_id=$6 AND anchor_kind=$7`,
      [authorized.workspaceKey, authorized.tenantKey, authorized.environment, producerEventId, provider.name, reportRunId, anchorKind],
    );
    anchor = existing.rows[0] ? mapRow(existing.rows[0] as Row) : null;
  }
  if (!anchor) throw new Error('external anchor replay could not resolve its immutable receipt');
  return { anchor, replayed: outcome.replayed, auditEvent: outcome.event };
}

export function externalAnchorForDossier(anchor: ExternalEvidenceAnchorRecord): {
  kind: ExternalAnchorKind; provider: string; reference: string; anchoredAt: string; verification: 'verified';
} {
  return { kind: anchor.anchorKind, provider: anchor.provider, reference: anchor.reference, anchoredAt: anchor.anchoredAt, verification: 'verified' };
}
