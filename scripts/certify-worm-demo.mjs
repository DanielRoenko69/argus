import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson, createS3Client } from '../demo/worm-gateway/server.mjs';

const root = resolve(import.meta.dirname, '..');
const token = readFileSync(resolve(root, 'secrets/argus-worm-demo-token'), 'utf8').trim();
const publicKey = createPublicKey(readFileSync(resolve(root, 'secrets/argus-worm-demo-public-key.pem')));
const port = process.env.WORM_GATEWAY_PORT ?? '8787';
const endpoint = `http://127.0.0.1:${port}`;
const demoEnv = Object.fromEntries(readFileSync(resolve(root, '.env.worm-demo.local'), 'utf8').split(/\r?\n/)
  .map(line => line.trim()).filter(line => line && !line.startsWith('#') && line.includes('='))
  .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${endpoint}${path}`, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const health = await jsonRequest('/health');
if (!health.response.ok || health.body.storage !== 'minio-object-lock' || health.body.lockMode !== 'COMPLIANCE') {
  throw new Error(`WORM gateway is not healthy (${health.response.status})`);
}

const archiveId = randomUUID();
const scope = { workspaceKey: 'worm-demo', tenantKey: 'local-certification', environment: 'test' };
const content = {
  schemaVersion: 1, kind: 'argus.audit-retention-archive', archiveId, scope,
  generatedAt: new Date().toISOString(),
  verification: { state: 'demo_contract_probe', purgeAuthorized: false },
};
const canonical = canonicalJson(content);
const artifact = { type: 'audit_retention_archive', id: archiveId, sha256: createHash('sha256').update(canonical).digest('hex') };
const request = {
  schemaVersion: 1, kind: 'argus.external-evidence-anchor-request', anchorKind: 'worm_object', artifact, scope,
  idempotencyKey: `worm-demo-${archiveId}`, requestedAt: new Date().toISOString(),
  payload: { mediaType: 'application/vnd.argus.audit-retention-archive.v1+json', bytes: Buffer.byteLength(canonical), content },
};
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const archived = await jsonRequest('/v1/anchors', { method: 'POST', headers, body: JSON.stringify(request) });
if (!archived.response.ok) throw new Error(`WORM archive probe failed (${archived.response.status}): ${archived.body.error ?? 'unknown error'}`);
const receipt = archived.body;
if (receipt.statement?.artifact?.sha256 !== artifact.sha256 || receipt.statement?.scope?.tenantKey !== scope.tenantKey
  || receipt.statement?.anchorKind !== 'worm_object' || !String(receipt.statement?.reference ?? '').includes('versionId=')) {
  throw new Error('WORM receipt is not bound to the test artifact');
}
if (!verify(null, Buffer.from(canonicalJson(receipt.statement)), publicKey, Buffer.from(receipt.signature?.value ?? '', 'base64url'))) {
  throw new Error('WORM receipt signature verification failed');
}
const retainedUntil = Date.parse(receipt.statement.retentionUntil ?? '');
if (!Number.isFinite(retainedUntil) || retainedUntil <= Date.now()) throw new Error('WORM receipt has no active retention deadline');

const replay = await jsonRequest('/v1/anchors', { method: 'POST', headers, body: JSON.stringify(request) });
if (!replay.response.ok || replay.body.statement?.reference !== receipt.statement.reference
  || replay.body.statement?.anchoredAt !== receipt.statement.anchoredAt) throw new Error('WORM idempotency probe failed');

const retrieved = await jsonRequest('/v1/anchors', { method: 'POST', headers, body: JSON.stringify({
  schemaVersion: 1, kind: 'argus.external-retention-archive-retrieve-request', artifact, scope,
  reference: receipt.statement.reference, requestedAt: new Date().toISOString(),
}) });
if (!retrieved.response.ok || canonicalJson(retrieved.body.content) !== canonical || retrieved.body.bytes !== Buffer.byteLength(canonical)) {
  throw new Error(`WORM restore probe failed (${retrieved.response.status})`);
}

const immutableReference = new URL(receipt.statement.reference);
const immutableKey = immutableReference.pathname.replace(/^\//, '');
const immutableVersionId = immutableReference.searchParams.get('versionId');
if (!immutableVersionId) throw new Error('immutable receipt did not include a MinIO version ID');
const directMinio = createS3Client({
  endpoint: `http://127.0.0.1:${demoEnv.WORM_MINIO_PORT ?? '9900'}`,
  accessKey: demoEnv.WORM_MINIO_ROOT_USER, secretKey: demoEnv.WORM_MINIO_ROOT_PASSWORD,
  region: demoEnv.WORM_MINIO_REGION ?? 'us-east-1', bucket: demoEnv.WORM_BUCKET ?? 'argus-audit-worm',
});
const deleteAttempt = await directMinio.request('DELETE', immutableKey, { versionId: immutableVersionId });
if (deleteAttempt.status >= 200 && deleteAttempt.status < 300) throw new Error('MinIO allowed deletion of a COMPLIANCE-locked version');
const retainedAfterDeleteAttempt = await jsonRequest('/v1/anchors', { method: 'POST', headers, body: JSON.stringify({
  schemaVersion: 1, kind: 'argus.external-retention-archive-retrieve-request', artifact, scope,
  reference: receipt.statement.reference, requestedAt: new Date().toISOString(),
}) });
if (!retainedAfterDeleteAttempt.response.ok || canonicalJson(retainedAfterDeleteAttempt.body.content) !== canonical) {
  throw new Error('locked object was not retrievable after the rejected delete probe');
}

const tamperedContent = { ...content, verification: { state: 'tampered', purgeAuthorized: true } };
const tamperedCanonical = canonicalJson(tamperedContent);
const tampered = await jsonRequest('/v1/anchors', { method: 'POST', headers, body: JSON.stringify({
  ...request,
  artifact: { ...artifact, sha256: createHash('sha256').update(tamperedCanonical).digest('hex') },
  payload: { ...request.payload, bytes: Buffer.byteLength(tamperedCanonical), content: tamperedContent },
}) });
if (tampered.response.status !== 409) throw new Error(`immutable overwrite probe did not fail closed (${tampered.response.status})`);

const packId = randomUUID();
const unsignedPack = { schemaVersion: 1, kind: 'argus.audit.evidence-pack', manifest: { packId, scope } };
const packDigest = createHash('sha256').update(canonicalJson(unsignedPack)).digest('hex');
const evidencePack = { ...unsignedPack, packDigest };
const packCanonical = canonicalJson(evidencePack);
const packUpload = await jsonRequest('/v1/anchors', { method: 'POST', headers, body: JSON.stringify({
  schemaVersion: 1, kind: 'argus.external-evidence-anchor-request', anchorKind: 'worm_object',
  artifact: { type: 'audit_evidence_pack', id: packId, sha256: packDigest }, scope,
  idempotencyKey: `worm-demo-pack-${packId}`, requestedAt: new Date().toISOString(),
  payload: { mediaType: 'application/vnd.argus.audit-evidence-pack.v1+json', bytes: Buffer.byteLength(packCanonical), content: evidencePack },
}) });
if (!packUpload.response.ok || !String(packUpload.body.statement?.reference ?? '').includes('/evidence-packs/')) {
  throw new Error(`complete Evidence Pack WORM probe failed (${packUpload.response.status})`);
}

process.stdout.write(`${JSON.stringify({
  status: 'passed', provider: receipt.statement.provider, storage: health.body.storage, lockMode: health.body.lockMode,
  artifactId: archiveId, versionReference: receipt.statement.reference, retentionUntil: receipt.statement.retentionUntil,
  checks: ['provider-health', 'complete-retention-upload', 'complete-evidence-pack-upload', 'compliance-lock', 'signed-receipt', 'idempotent-replay', 'full-restore', 'locked-version-delete-rejected', 'overwrite-rejected'],
  purgeAuthorized: false,
}, null, 2)}\n`);
