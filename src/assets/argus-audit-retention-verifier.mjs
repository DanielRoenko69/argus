#!/usr/bin/env node

/**
 * Argus Audit Retention Archive Offline Verifier v1
 *
 * Dependency-free by design: copy this file, the WORM archive JSON, its signed
 * receipt and the provider's Ed25519 public key onto an isolated Node.js 20+
 * workstation. No Argus service or network connection is required.
 */
import {
  createHash,
  createPublicKey,
  verify,
} from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_JSON_BYTES = 65 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is invalid`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
  return value;
}

function strictBase64Url(value, label) {
  const encoded = text(value, label);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error(`${label} is not base64url`);
  const decoded = Buffer.from(encoded, 'base64url');
  if (!decoded.length || decoded.toString('base64url') !== encoded) throw new Error(`${label} is malformed`);
  return decoded;
}

function publicKeyFingerprint(publicKey) {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

function eventPayload(event) {
  const producer = object(event.producer, 'event producer');
  const actor = object(event.actor, 'event actor');
  const resource = object(event.resource, 'event resource');
  const policy = object(event.policy, 'event policy');
  const correlation = object(event.correlation, 'event correlation');
  return {
    schemaVersion: 1,
    sequence: String(event.sequence),
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    environment: event.environment,
    workspaceKey: event.workspaceKey,
    tenantKey: event.tenantKey,
    solution: event.solution ?? null,
    producer: { name: producer.name, eventId: producer.eventId },
    actor: {
      type: actor.type,
      id: actor.id,
      ssoSubject: actor.ssoSubject ?? null,
      authMethod: actor.authMethod,
      effectiveRoles: actor.effectiveRoles,
    },
    action: event.action,
    outcome: event.outcome,
    risk: event.risk,
    resource: { type: resource.type, id: resource.id, revision: resource.revision ?? null },
    policy: { id: policy.id ?? null, version: policy.version ?? null, decision: policy.decision ?? null },
    approvalId: event.approvalId ?? null,
    correlation: {
      rootRunId: correlation.rootRunId ?? null,
      traceId: correlation.traceId ?? null,
      spanId: correlation.spanId ?? null,
      requestId: correlation.requestId ?? null,
    },
    payloadSummary: event.payloadSummary,
    payloadDigest: event.payloadDigest,
    beforeDigest: event.beforeDigest ?? null,
    afterDigest: event.afterDigest ?? null,
    redactionProfile: event.redactionProfile,
    retentionClass: event.retentionClass,
    retentionUntil: event.retentionUntil ?? null,
    legalHold: event.legalHold,
    previousHash: event.previousHash,
    signingKeyId: event.signingKeyId ?? null,
  };
}

function checkpointPayload(checkpoint) {
  return {
    schemaVersion: 1,
    checkpointId: checkpoint.checkpointId,
    workspaceKey: checkpoint.workspaceKey,
    tenantKey: checkpoint.tenantKey,
    environment: checkpoint.environment,
    lastSequence: String(checkpoint.lastSequence),
    lastEventId: checkpoint.lastEventId,
    lastEventHash: checkpoint.lastEventHash,
    previousCheckpointId: checkpoint.previousCheckpointId ?? null,
    previousCheckpointDigest: checkpoint.previousCheckpointDigest,
    createdAt: checkpoint.createdAt,
    algorithm: checkpoint.algorithm,
    keyId: checkpoint.keyId,
    publicKeyFingerprint: checkpoint.publicKeyFingerprint,
  };
}

function normalizeArchive(raw) {
  const root = object(raw, 'archive JSON');
  if (root.kind === 'argus.external-retention-archive-object') {
    const content = object(root.content, 'retrieved archive content');
    if (root.mediaType !== 'application/vnd.argus.audit-retention-archive.v1+json') {
      throw new Error('retrieved archive media type is unsupported');
    }
    if (root.bytes !== Buffer.byteLength(stableJson(content), 'utf8')) throw new Error('retrieved archive byte count is invalid');
    return content;
  }
  return root;
}

export function verifyRetentionArchiveOffline({ archive: rawArchive, receipt: rawReceipt, providerPublicKeyPem, now = new Date(), expectedProvider, expectedKeyId }) {
  const archive = normalizeArchive(rawArchive);
  const receiptRoot = object(rawReceipt, 'provider receipt');
  const statement = object(receiptRoot.statement, 'provider receipt statement');
  const receiptSignature = object(receiptRoot.signature, 'provider receipt signature');
  const providerKey = createPublicKey(providerPublicKeyPem);
  if (providerKey.asymmetricKeyType !== 'ed25519') throw new Error('provider public key must be Ed25519');
  const providerFingerprint = publicKeyFingerprint(providerKey);

  if (statement.schemaVersion !== 1 || statement.kind !== 'argus.external-evidence-anchor-statement'
    || statement.anchorKind !== 'worm_object' || statement.artifact?.type !== 'audit_retention_archive') {
    throw new Error('provider receipt schema is unsupported');
  }
  if (receiptSignature.algorithm !== 'Ed25519') throw new Error('provider receipt signature algorithm is unsupported');
  if (expectedProvider && statement.provider !== expectedProvider) throw new Error('provider receipt identity does not match expectation');
  if (expectedKeyId && receiptSignature.keyId !== expectedKeyId) throw new Error('provider receipt key ID does not match expectation');
  if (receiptRoot.verificationKeyFingerprint && receiptRoot.verificationKeyFingerprint !== providerFingerprint) {
    throw new Error('provider public-key fingerprint does not match receipt');
  }
  const statementBytes = Buffer.from(stableJson(statement), 'utf8');
  if (!verify(null, statementBytes, providerKey, strictBase64Url(receiptSignature.value, 'provider receipt signature'))) {
    throw new Error('provider receipt signature is invalid');
  }
  const statementSha256 = createHash('sha256').update(statementBytes).digest('hex');
  const receiptSha256 = sha256({ statement, signature: receiptSignature });
  if (receiptRoot.statementSha256 && receiptRoot.statementSha256 !== statementSha256) throw new Error('provider statement digest is invalid');
  if (receiptRoot.receiptSha256 && receiptRoot.receiptSha256 !== receiptSha256) throw new Error('provider receipt digest is invalid');

  if (archive.schemaVersion !== 1 || archive.kind !== 'argus.audit-retention-archive') throw new Error('archive package schema is unsupported');
  const archiveId = text(archive.archiveId, 'archive ID');
  const scope = object(archive.scope, 'archive scope');
  const plan = object(archive.plan, 'archive plan');
  const chain = object(archive.chain, 'archive chain');
  const archiveVerification = object(archive.verification, 'archive verification');
  const packageSha256 = sha256(archive);
  if (!SHA256.test(packageSha256) || packageSha256 !== statement.artifact.sha256
    || archiveId !== statement.artifact.id
    || scope.workspaceKey !== statement.scope?.workspaceKey
    || scope.tenantKey !== statement.scope?.tenantKey
    || scope.environment !== statement.scope?.environment) {
    throw new Error('archive package does not match the signed provider receipt');
  }
  if (archiveVerification.state !== 'event_hashes_and_checkpoint_valid' || archiveVerification.purgeAuthorized !== false) {
    throw new Error('archive verification boundary is invalid');
  }

  const events = archive.events;
  if (!Array.isArray(events) || events.length < 1) throw new Error('archive events are missing');
  const firstSequence = integer(chain.firstSequence, 'first sequence');
  const lastSequence = integer(chain.lastSequence, 'last sequence');
  if (firstSequence !== 1 || chain.firstPreviousHash !== '' || chain.eventCount !== events.length
    || lastSequence !== events.length || lastSequence - firstSequence + 1 !== events.length) {
    throw new Error('archive chain summary is invalid');
  }
  let previousHash = '';
  for (let index = 0; index < events.length; index += 1) {
    const event = object(events[index], `archive event ${index + 1}`);
    if (event.schemaVersion !== 1 || event.sequence !== index + 1 || event.previousHash !== previousHash
      || event.workspaceKey !== scope.workspaceKey || event.tenantKey !== scope.tenantKey || event.environment !== scope.environment
      || event.redactionProfile !== 'argus.audit.redaction.v1' || event.replayed !== false) {
      throw new Error(`archive event-chain metadata is invalid at sequence ${index + 1}`);
    }
    const computedHash = sha256(eventPayload(event));
    if (!SHA256.test(event.eventHash) || computedHash !== event.eventHash) {
      throw new Error(`archive event hash is invalid at sequence ${index + 1}`);
    }
    previousHash = event.eventHash;
  }
  if (previousHash !== chain.lastEventHash) throw new Error('archive terminal event hash is invalid');

  const checkpointEnvelope = object(archive.checkpoint, 'checkpoint envelope');
  const checkpoint = object(checkpointEnvelope.value, 'checkpoint');
  const checkpointKey = createPublicKey(text(checkpointEnvelope.publicKeyPem, 'checkpoint public key'));
  if (checkpointKey.asymmetricKeyType !== 'ed25519') throw new Error('checkpoint public key must be Ed25519');
  const checkpointFingerprint = publicKeyFingerprint(checkpointKey);
  const computedCheckpointDigest = sha256(checkpointPayload(checkpoint));
  if (checkpoint.schemaVersion !== 1 || checkpoint.algorithm !== 'Ed25519' || checkpoint.replayed !== false
    || checkpoint.workspaceKey !== scope.workspaceKey || checkpoint.tenantKey !== scope.tenantKey || checkpoint.environment !== scope.environment
    || checkpoint.lastSequence < lastSequence || checkpoint.publicKeyFingerprint !== checkpointFingerprint
    || checkpoint.checkpointDigest !== computedCheckpointDigest || !SHA256.test(checkpoint.checkpointDigest)
    || !verify(null, Buffer.from(computedCheckpointDigest, 'hex'), checkpointKey, strictBase64Url(checkpoint.signature, 'checkpoint signature'))) {
    throw new Error('checkpoint signature or archive binding is invalid');
  }
  if (checkpoint.lastSequence === lastSequence && checkpoint.lastEventHash !== previousHash) {
    throw new Error('checkpoint terminal hash does not match archive chain');
  }

  const anchoredAt = Date.parse(statement.anchoredAt);
  const retentionUntil = Date.parse(statement.retentionUntil ?? '');
  const checkedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(anchoredAt) || !Number.isFinite(retentionUntil) || retentionUntil <= anchoredAt
    || !Number.isFinite(checkedAt.getTime())) {
    throw new Error('WORM retention timestamps are invalid');
  }
  if (plan.planId == null || plan.manifestSha256 == null) throw new Error('archive plan binding is incomplete');

  return {
    schemaVersion: 1,
    kind: 'argus.audit-retention-offline-verification',
    state: 'valid',
    verifiedAt: checkedAt.toISOString(),
    archiveId,
    planId: plan.planId,
    scope,
    provider: { name: statement.provider, keyId: receiptSignature.keyId, keyFingerprint: providerFingerprint, reference: statement.reference },
    archive: { packageSha256, eventCount: events.length, firstSequence, lastSequence, lastEventHash: previousHash },
    checkpoint: { checkpointId: checkpoint.checkpointId, checkpointDigest: computedCheckpointDigest, keyId: checkpoint.keyId, keyFingerprint: checkpointFingerprint },
    wormRetention: { anchoredAt: new Date(anchoredAt).toISOString(), retentionUntil: new Date(retentionUntil).toISOString(), state: retentionUntil > checkedAt.getTime() ? 'active' : 'expired' },
    checks: {
      providerReceiptSignature: 'valid',
      packageSha256: 'valid',
      checkpointSignature: 'valid',
      canonicalEventChain: 'complete_and_valid',
      purgeAuthorized: false,
    },
    statementSha256,
    receiptSha256,
  };
}

function readJson(filename, label) {
  const size = statSync(filename).size;
  if (size < 1 || size > MAX_JSON_BYTES) throw new Error(`${label} has an invalid size`);
  return JSON.parse(readFileSync(filename, 'utf8'));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return { help: true };
    if (!key?.startsWith('--') || index + 1 >= argv.length) throw new Error(`invalid argument: ${key ?? ''}`);
    args[key.slice(2)] = argv[++index];
  }
  return args;
}

function usage() {
  return [
    'Argus Audit Retention Archive Offline Verifier v1',
    '',
    'Usage:',
    '  node argus-audit-retention-verifier.mjs --archive <archive.json> --receipt <receipt.json> --provider-key <public.pem> [options]',
    '',
    'Options:',
    '  --expect-provider <name>  Require the configured provider identity',
    '  --expect-key-id <id>      Require the configured provider signing key ID',
    '  --now <ISO timestamp>     Evaluate whether the WORM retention window is active',
    '  --output <file>           Write the JSON result to a file instead of stdout',
  ].join('\n');
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { process.stdout.write(`${usage()}\n`); return; }
    if (!args.archive || !args.receipt || !args['provider-key']) throw new Error('archive, receipt and provider-key are required');
    const result = verifyRetentionArchiveOffline({
      archive: readJson(args.archive, 'archive'),
      receipt: readJson(args.receipt, 'receipt'),
      providerPublicKeyPem: readFileSync(args['provider-key'], 'utf8'),
      now: args.now ? new Date(args.now) : new Date(),
      expectedProvider: args['expect-provider'],
      expectedKeyId: args['expect-key-id'],
    });
    const rendered = `${JSON.stringify(result, null, 2)}\n`;
    if (args.output) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(args.output, rendered, { encoding: 'utf8', flag: 'wx' });
    } else process.stdout.write(rendered);
  } catch (error) {
    process.stderr.write(`VERIFICATION FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
