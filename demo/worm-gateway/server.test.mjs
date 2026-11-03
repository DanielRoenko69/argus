import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { canonicalJson, createGateway } from './server.mjs';

test('canonical JSON sorts nested object keys', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
});

test('gateway stores a complete artifact, verifies COMPLIANCE lock and returns a signed receipt', async t => {
  const keys = generateKeyPairSync('ed25519');
  const content = { archiveId: '10000000-0000-8000-8000-000000000001', kind: 'argus.audit-retention-archive', schemaVersion: 1, scope: { environment: 'test', tenantKey: 'tenant', workspaceKey: 'workspace' } };
  const canonical = canonicalJson(content);
  const digest = (await import('node:crypto')).createHash('sha256').update(canonical).digest('hex');
  let stored = false;
  const calls = [];
  const s3 = {
    bucket: 'argus-audit-worm',
    request: async (method, key, query, headers, body) => {
      calls.push({ method, key, query, headers, body });
      if (method === 'HEAD' && !stored) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      if (method === 'PUT') { stored = true; return { status: 200, headers: { 'x-amz-version-id': 'version-1' }, body: Buffer.alloc(0) }; }
      if (method === 'HEAD') return { status: 200, headers: {
        'content-length': String(Buffer.byteLength(canonical)), 'x-amz-version-id': 'version-1',
        'x-amz-meta-argus-sha256': digest, 'x-amz-meta-argus-idempotency-key': 'request-1',
        'x-amz-meta-argus-anchored-at': '2026-09-10T12:00:00.000Z', 'x-amz-object-lock-mode': 'COMPLIANCE',
        'x-amz-object-lock-retain-until-date': '2099-09-17T12:00:00.000Z',
      }, body: Buffer.alloc(0) };
      throw new Error(`Unexpected ${method}`);
    },
  };
  const server = createGateway({ providerName: 'Test WORM', keyId: 'test-key', bearerToken: 'test-token', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), retentionDays: 7, s3 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  const result = await fetch(`http://127.0.0.1:${address.port}/v1/anchors`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({
    schemaVersion: 1, kind: 'argus.external-evidence-anchor-request', anchorKind: 'worm_object',
    artifact: { type: 'audit_retention_archive', id: content.archiveId, sha256: digest }, scope: content.scope,
    idempotencyKey: 'request-1', requestedAt: '2026-09-10T12:00:00.000Z',
    payload: { mediaType: 'application/vnd.argus.audit-retention-archive.v1+json', bytes: Buffer.byteLength(canonical), content },
  }) });
  assert.equal(result.status, 200);
  const receipt = await result.json();
  assert.equal(receipt.statement.reference, 's3://argus-audit-worm/retention-archives/b72399190c8f4cab46d51296/10000000-0000-8000-8000-000000000001.json?versionId=version-1');
  assert.equal(receipt.statement.retentionUntil, '2099-09-17T12:00:00.000Z');
  assert.equal(verify(null, Buffer.from(canonicalJson(receipt.statement)), keys.publicKey, Buffer.from(receipt.signature.value, 'base64url')), true);
  assert.deepEqual(calls.map(call => call.method), ['HEAD', 'PUT', 'HEAD']);
});
