import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import { stableAuditJson, type AuditJsonValue } from '../canonicalAuditRedaction.js';
import {
  HttpSignedExternalAnchorProvider,
  type ExternalAnchorRequest,
  type ExternalAnchorStatement,
} from '../externalAnchorProvider.js';

const keys = generateKeyPairSync('ed25519');
const request: ExternalAnchorRequest = {
  anchorKind: 'worm_object',
  artifact: { type: 'audit_evidence_pack', id: '10000000-0000-4000-8000-000000000001', sha256: 'a'.repeat(64) },
  scope: { workspaceKey: 'default', tenantKey: 'tenant-a', environment: 'production' },
  idempotencyKey: 'anchor-request-1',
  requestedAt: '2026-09-10T10:00:00.000Z',
};

function signedReceipt(overrides: Partial<ExternalAnchorStatement> = {}) {
  const statement: ExternalAnchorStatement = {
    schemaVersion: 1,
    kind: 'argus.external-evidence-anchor-statement',
    anchorKind: request.anchorKind,
    provider: 'test-worm',
    reference: 's3://audit-lock/pack.json?versionId=immutable-1',
    idempotencyKey: request.idempotencyKey,
    anchoredAt: '2026-09-10T10:00:01.000Z',
    retentionUntil: '2036-09-10T10:00:01.000Z',
    artifact: request.artifact,
    scope: request.scope,
    ...overrides,
  };
  return {
    statement,
    signature: {
      algorithm: 'Ed25519' as const,
      keyId: 'anchor-key-1',
      value: sign(null, Buffer.from(stableAuditJson(statement as unknown as AuditJsonValue)), keys.privateKey).toString('base64url'),
    },
  };
}

function provider(receipt: unknown) {
  return new HttpSignedExternalAnchorProvider({
    endpoint: 'https://anchor.example.test/v1/receipts',
    providerName: 'test-worm',
    keyId: 'anchor-key-1',
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    bearerToken: 'test-bearer-token',
    now: () => new Date('2026-09-10T10:00:02.000Z'),
    fetchImpl: jest.fn(async () => new Response(JSON.stringify(receipt), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
}

describe('signed external Evidence Pack anchoring', () => {
  it('accepts an Ed25519 receipt bound to the exact artifact and tenant scope', async () => {
    const result = await provider(signedReceipt()).anchor(request);
    expect(result).toMatchObject({
      verification: 'verified',
      statement: { artifact: request.artifact, scope: request.scope, anchorKind: 'worm_object' },
    });
    expect(result.statementSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.verificationKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a correctly signed receipt from another tenant scope', async () => {
    await expect(provider(signedReceipt({ scope: { ...request.scope, tenantKey: 'tenant-b' } })).anchor(request))
      .rejects.toThrow('does not bind the requested artifact');
  });

  it('rejects WORM claims without an enforceable future retention timestamp', async () => {
    await expect(provider(signedReceipt({ retentionUntil: null })).anchor(request))
      .rejects.toThrow('WORM receipt requires a future retentionUntil timestamp');
  });

  it('rejects insecure remote HTTP endpoints', () => {
    expect(() => new HttpSignedExternalAnchorProvider({
      endpoint: 'http://anchor.example.test/v1/receipts', providerName: 'test-worm', keyId: 'anchor-key-1',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), bearerToken: 'secret',
    })).toThrow('must use HTTPS');
  });

  it('accepts only an explicitly named internal HTTP gateway', () => {
    expect(() => new HttpSignedExternalAnchorProvider({
      endpoint: 'http://worm-gateway:8787/v1/anchors', providerName: 'test-worm', keyId: 'anchor-key-1',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), bearerToken: 'secret',
      allowLocalHttp: true, allowHttpHosts: ['worm-gateway'],
    })).not.toThrow();
    expect(() => new HttpSignedExternalAnchorProvider({
      endpoint: 'http://worm-gateway.attacker.test:8787/v1/anchors', providerName: 'test-worm', keyId: 'anchor-key-1',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), bearerToken: 'secret',
      allowLocalHttp: true, allowHttpHosts: ['worm-gateway'],
    })).toThrow('must use HTTPS');
  });

  it('accepts a signed WORM receipt for a complete retention archive artifact', async () => {
    const archiveRequest: ExternalAnchorRequest = {
      ...request,
      artifact: { type: 'audit_retention_archive', id: '20000000-0000-4000-8000-000000000002', sha256: 'b'.repeat(64) },
      idempotencyKey: 'retention-archive-request-1',
      archive: {
        mediaType: 'application/vnd.argus.audit-retention-archive.v1+json', bytes: 128,
        content: { schemaVersion: 1, kind: 'argus.audit-retention-archive' },
      },
    };
    const statement: ExternalAnchorStatement = {
      schemaVersion: 1, kind: 'argus.external-evidence-anchor-statement', anchorKind: 'worm_object',
      provider: 'test-worm', reference: 's3://audit-lock/archive.json?versionId=immutable-2',
      idempotencyKey: archiveRequest.idempotencyKey, anchoredAt: '2026-09-10T10:00:01.000Z',
      retentionUntil: '2036-09-10T10:00:01.000Z', artifact: archiveRequest.artifact, scope: archiveRequest.scope,
    };
    const receipt = {
      statement,
      signature: { algorithm: 'Ed25519' as const, keyId: 'anchor-key-1', value: sign(null, Buffer.from(stableAuditJson(statement as unknown as AuditJsonValue)), keys.privateKey).toString('base64url') },
    };
    await expect(provider(receipt).anchor(archiveRequest)).resolves.toMatchObject({
      verification: 'verified', statement: { artifact: archiveRequest.artifact },
    });
  });

  it('retrieves a canonical archive object from the same authenticated provider contract', async () => {
    const content = { schemaVersion: 1, kind: 'argus.audit-retention-archive', archiveId: '20000000-0000-4000-8000-000000000002' };
    const body = {
      schemaVersion: 1, kind: 'argus.external-retention-archive-object',
      reference: 's3://audit-lock/archive.json?versionId=immutable-2',
      mediaType: 'application/vnd.argus.audit-retention-archive.v1+json',
      bytes: Buffer.byteLength(stableAuditJson(content as unknown as AuditJsonValue)),
      retrievedAt: '2026-09-10T10:00:02.000Z', content,
    };
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const active = new HttpSignedExternalAnchorProvider({
      endpoint: 'https://anchor.example.test/v1/receipts', providerName: 'test-worm', keyId: 'anchor-key-1',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), bearerToken: 'test-bearer-token', fetchImpl,
    });
    const result = await active.retrieveArchive({
      schemaVersion: 1, kind: 'argus.external-retention-archive-retrieve-request',
      artifact: { type: 'audit_retention_archive', id: content.archiveId, sha256: 'b'.repeat(64) },
      scope: request.scope, reference: body.reference, requestedAt: '2026-09-10T10:00:02.000Z',
    });
    expect(result).toMatchObject({ reference: body.reference, bytes: body.bytes, content });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      method: 'POST', body: expect.stringContaining('argus.external-retention-archive-retrieve-request'),
    }));
  });
});
