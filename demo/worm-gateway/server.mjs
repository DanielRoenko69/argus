import { createHash, createHmac, createPrivateKey, sign, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_OBJECT_BYTES + 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_NAME = /^[a-z0-9][a-z0-9.-]{1,62}$/;

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('canonical JSON rejects unsupported values');
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);
const cleanHeader = value => String(value).trim().replace(/\s+/g, ' ');
const awsEncode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const canonicalPath = value => `/${value.split('/').map(awsEncode).join('/')}`;

function requiredString(value, name, maximum = 1_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

function parsePositiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} is invalid`);
  return parsed;
}

function safeCompare(actual, expected) {
  const left = Buffer.from(actual ?? '', 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function responseJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(body.length),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readJson(req) {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw Object.assign(new Error('request exceeds the bounded archive envelope'), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('request exceeds the bounded archive envelope'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('request body is not valid JSON'), { status: 400 }); }
}

function validateScope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('scope is invalid');
  return {
    workspaceKey: requiredString(raw.workspaceKey, 'scope.workspaceKey', 128),
    tenantKey: requiredString(raw.tenantKey, 'scope.tenantKey', 128),
    environment: requiredString(raw.environment, 'scope.environment', 64),
  };
}

function validateAnchorRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || raw.schemaVersion !== 1 || raw.kind !== 'argus.external-evidence-anchor-request'
    || raw.anchorKind !== 'worm_object') throw new Error('unsupported external anchor request');
  const type = raw.artifact?.type;
  if (!['audit_evidence_pack', 'audit_retention_archive'].includes(type)
    || !UUID.test(String(raw.artifact?.id ?? '')) || !SHA256.test(String(raw.artifact?.sha256 ?? ''))) {
    throw new Error('artifact identity is invalid');
  }
  const payload = raw.payload ?? raw.archive;
  const expectedMediaType = type === 'audit_retention_archive'
    ? 'application/vnd.argus.audit-retention-archive.v1+json'
    : 'application/vnd.argus.audit-evidence-pack.v1+json';
  if (!payload || payload.mediaType !== expectedMediaType || !payload.content || typeof payload.content !== 'object') {
    throw new Error('complete canonical artifact payload is required');
  }
  const canonical = canonicalJson(payload.content);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  if (bytes !== parsePositiveInteger(payload.bytes, 'payload.bytes', MAX_OBJECT_BYTES)) throw new Error('payload byte count is invalid');
  const scope = validateScope(raw.scope);
  if (type === 'audit_retention_archive') {
    if (sha256(canonical) !== raw.artifact.sha256) throw new Error('payload digest does not match the artifact');
    if (payload.content.archiveId !== raw.artifact.id) throw new Error('archive payload identity does not match the artifact');
    if (canonicalJson(payload.content.scope) !== canonicalJson(scope)) throw new Error('payload scope does not match the request');
  } else {
    const { packDigest, ...unsignedPack } = payload.content;
    if (payload.content.kind !== 'argus.audit.evidence-pack' || payload.content.manifest?.packId !== raw.artifact.id
      || packDigest !== raw.artifact.sha256 || sha256(canonicalJson(unsignedPack)) !== raw.artifact.sha256) {
      throw new Error('Evidence Pack digest or identity does not match the artifact');
    }
    if (canonicalJson(payload.content.manifest?.scope) !== canonicalJson(scope)) throw new Error('payload scope does not match the request');
  }
  const requestedAt = new Date(requiredString(raw.requestedAt, 'requestedAt', 64));
  if (!Number.isFinite(requestedAt.getTime())) throw new Error('requestedAt is invalid');
  return {
    anchorKind: 'worm_object', artifact: { type, id: raw.artifact.id, sha256: raw.artifact.sha256 }, scope,
    idempotencyKey: requiredString(raw.idempotencyKey, 'idempotencyKey', 256),
    requestedAt: requestedAt.toISOString(), mediaType: expectedMediaType, bytes, content: payload.content,
    canonical: Buffer.from(canonical, 'utf8'),
  };
}

function validateRetrieveRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== 1
    || raw.kind !== 'argus.external-retention-archive-retrieve-request'
    || raw.artifact?.type !== 'audit_retention_archive' || !UUID.test(String(raw.artifact?.id ?? ''))
    || !SHA256.test(String(raw.artifact?.sha256 ?? ''))) throw new Error('invalid archive retrieval request');
  return {
    artifact: { type: 'audit_retention_archive', id: raw.artifact.id, sha256: raw.artifact.sha256 },
    scope: validateScope(raw.scope), reference: requiredString(raw.reference, 'reference', 1_000),
  };
}

export function createS3Client(options) {
  const endpoint = new URL(options.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/') {
    throw new Error('S3 endpoint must be an HTTP(S) origin');
  }
  const accessKey = requiredString(options.accessKey, 'S3 access key', 256);
  const secretKey = requiredString(options.secretKey, 'S3 secret key', 512);
  const region = requiredString(options.region, 'S3 region', 128);
  const bucket = requiredString(options.bucket, 'S3 bucket', 63);
  if (!SAFE_NAME.test(bucket)) throw new Error('S3 bucket is invalid');

  async function request(method, objectKey = '', query = {}, extraHeaders = {}, body = Buffer.alloc(0), maximum = MAX_REQUEST_BYTES) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const resourcePath = objectKey ? `${bucket}/${objectKey}` : bucket;
    const path = canonicalPath(resourcePath);
    const canonicalQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${awsEncode(key)}=${awsEncode(String(value))}`).join('&');
    const payloadHash = sha256(body);
    const headers = {
      host: endpoint.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([key, value]) => [key.toLowerCase(), cleanHeader(value)])),
    };
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = `${signedHeaderNames.map(name => `${name}:${cleanHeader(headers[name])}`).join('\n')}\n`;
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const dateKey = hmac(Buffer.from(`AWS4${secretKey}`, 'utf8'), date);
    const regionKey = hmac(dateKey, region);
    const serviceKey = hmac(regionKey, 's3');
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = hmac(signingKey, stringToSign, 'hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    if (body.length) headers['content-length'] = String(body.length);
    const transport = endpoint.protocol === 'https:' ? https : http;
    return await new Promise((resolve, reject) => {
      const outgoing = transport.request({ protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port, method, path: `${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`, headers }, incoming => {
        const chunks = [];
        let size = 0;
        incoming.on('data', chunk => {
          size += chunk.length;
          if (size > maximum) incoming.destroy(new Error('S3 response exceeds the bounded envelope'));
          else chunks.push(chunk);
        });
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }));
        incoming.on('error', reject);
      });
      outgoing.setTimeout(15_000, () => outgoing.destroy(new Error('S3 request timed out')));
      outgoing.on('error', reject);
      if (body.length) outgoing.write(body);
      outgoing.end();
    });
  }

  return { bucket, request };
}

function scopeHash(scope) { return sha256(canonicalJson(scope)).slice(0, 24); }
function objectKeyFor(value) {
  const collection = value.artifact.type === 'audit_retention_archive' ? 'retention-archives' : 'evidence-packs';
  return `${collection}/${scopeHash(value.scope)}/${value.artifact.id}.json`;
}

function header(response, name) {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function assertLockedObject(head, request, retentionDays, checkedAt) {
  if (head.status !== 200) throw new Error(`MinIO did not expose the archived object (${head.status})`);
  if (header(head, 'x-amz-meta-argus-sha256') !== request.artifact.sha256
    || header(head, 'x-amz-meta-argus-idempotency-key') !== request.idempotencyKey
    || Number(header(head, 'content-length')) !== request.bytes) throw new Error('existing immutable object does not match the requested artifact');
  if (header(head, 'x-amz-object-lock-mode') !== 'COMPLIANCE') throw new Error('MinIO did not confirm COMPLIANCE object lock');
  const retentionUntil = new Date(String(header(head, 'x-amz-object-lock-retain-until-date') ?? ''));
  const versionId = requiredString(header(head, 'x-amz-version-id'), 'MinIO version id', 512);
  const anchoredAt = new Date(String(header(head, 'x-amz-meta-argus-anchored-at') ?? ''));
  if (!Number.isFinite(anchoredAt.getTime())) throw new Error('immutable object creation timestamp is missing');
  if (!Number.isFinite(retentionUntil.getTime()) || retentionUntil.getTime() <= checkedAt.getTime()
    || retentionUntil.getTime() < anchoredAt.getTime() + retentionDays * 86_400_000) {
    throw new Error('MinIO did not confirm the requested active retention deadline');
  }
  return { versionId, anchoredAt: anchoredAt.toISOString(), retentionUntil: retentionUntil.toISOString() };
}

export function createGateway(options) {
  const providerName = requiredString(options.providerName, 'provider name', 240);
  const keyId = requiredString(options.keyId, 'key id', 240);
  const bearerToken = requiredString(options.bearerToken, 'bearer token', 16_384);
  const retentionDays = parsePositiveInteger(options.retentionDays, 'retention days', 3_650);
  const privateKey = createPrivateKey(options.privateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('gateway signing key must be Ed25519');
  const s3 = options.s3;

  async function archive(request) {
    const key = objectKeyFor(request);
    const now = new Date();
    const minimumRetention = new Date(now.getTime() + retentionDays * 86_400_000);
    let head = await s3.request('HEAD', key);
    let locked;
    if (head.status === 200) {
      locked = assertLockedObject(head, request, retentionDays, now);
    } else if (head.status === 404) {
      const anchoredAt = now.toISOString();
      const retentionUntil = minimumRetention.toISOString();
      const upload = await s3.request('PUT', key, {}, {
        'content-type': request.mediaType,
        'if-none-match': '*',
        'x-amz-meta-argus-anchored-at': anchoredAt,
        'x-amz-meta-argus-artifact-id': request.artifact.id,
        'x-amz-meta-argus-idempotency-key': request.idempotencyKey,
        'x-amz-meta-argus-sha256': request.artifact.sha256,
        'x-amz-object-lock-mode': 'COMPLIANCE',
        'x-amz-object-lock-retain-until-date': retentionUntil,
      }, request.canonical, 128 * 1024);
      if (![200, 201].includes(upload.status) && upload.status !== 412) throw new Error(`MinIO rejected immutable upload (${upload.status})`);
      const versionId = header(upload, 'x-amz-version-id');
      head = await s3.request('HEAD', key, versionId ? { versionId } : {});
      locked = assertLockedObject(head, request, retentionDays, now);
    } else {
      throw new Error(`MinIO archive lookup failed (${head.status})`);
    }
    const reference = `s3://${s3.bucket}/${key}?versionId=${encodeURIComponent(locked.versionId)}`;
    const statement = {
      schemaVersion: 1, kind: 'argus.external-evidence-anchor-statement', anchorKind: 'worm_object', provider: providerName,
      reference, idempotencyKey: request.idempotencyKey, anchoredAt: locked.anchoredAt, retentionUntil: locked.retentionUntil,
      artifact: request.artifact, scope: request.scope,
    };
    return {
      statement,
      signature: { algorithm: 'Ed25519', keyId, value: sign(null, Buffer.from(canonicalJson(statement), 'utf8'), privateKey).toString('base64url') },
    };
  }

  async function retrieve(request) {
    const reference = new URL(request.reference);
    const expectedKey = objectKeyFor(request);
    const key = reference.pathname.replace(/^\//, '');
    const versionId = requiredString(reference.searchParams.get('versionId'), 'reference version id', 512);
    if (reference.protocol !== 's3:' || reference.hostname !== s3.bucket || key !== expectedKey) throw new Error('archive reference is outside the configured immutable bucket');
    const stored = await s3.request('GET', key, { versionId }, {}, Buffer.alloc(0), MAX_REQUEST_BYTES);
    if (stored.status !== 200) throw new Error(`MinIO rejected immutable retrieval (${stored.status})`);
    if (sha256(stored.body) !== request.artifact.sha256) throw new Error('retrieved archive digest does not match the immutable receipt');
    let content;
    try { content = JSON.parse(stored.body.toString('utf8')); } catch { throw new Error('retrieved archive is not valid JSON'); }
    if (canonicalJson(content) !== stored.body.toString('utf8')) throw new Error('retrieved archive is not canonical JSON');
    return {
      schemaVersion: 1, kind: 'argus.external-retention-archive-object', reference: request.reference,
      mediaType: 'application/vnd.argus.audit-retention-archive.v1+json', bytes: stored.body.length,
      retrievedAt: new Date().toISOString(), content,
    };
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        const bucket = await s3.request('HEAD');
        return responseJson(res, bucket.status === 200 ? 200 : 503, { status: bucket.status === 200 ? 'ok' : 'blocked', provider: providerName, storage: 'minio-object-lock', lockMode: 'COMPLIANCE' });
      }
      if (req.method !== 'POST' || req.url !== '/v1/anchors') return responseJson(res, 404, { error: 'not found' });
      if (!safeCompare(req.headers.authorization, `Bearer ${bearerToken}`)) return responseJson(res, 401, { error: 'unauthorized' });
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return responseJson(res, 415, { error: 'application/json required' });
      const raw = await readJson(req);
      if (raw.kind === 'argus.external-retention-archive-retrieve-request') return responseJson(res, 200, await retrieve(validateRetrieveRequest(raw)));
      return responseJson(res, 200, await archive(validateAnchorRequest(raw)));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'gateway request failed';
      const conflict = /existing immutable object does not match/.test(message);
      responseJson(res, Number(error?.status) || (conflict ? 409 : 422), { error: message, code: conflict ? 'IMMUTABLE_OBJECT_CONFLICT' : 'WORM_GATEWAY_REJECTED' });
    }
  });
}

function loadConfig(env = process.env) {
  const privateKeyFile = requiredString(env.WORM_SIGNING_PRIVATE_KEY_FILE, 'WORM_SIGNING_PRIVATE_KEY_FILE');
  const tokenFile = requiredString(env.WORM_BEARER_TOKEN_FILE, 'WORM_BEARER_TOKEN_FILE');
  return {
    providerName: env.WORM_PROVIDER_NAME ?? 'Argus MinIO WORM Demo', keyId: env.WORM_SIGNING_KEY_ID ?? 'argus-minio-worm-demo-v1',
    bearerToken: readFileSync(tokenFile, 'utf8').trim(), privateKey: readFileSync(privateKeyFile),
    retentionDays: env.WORM_RETENTION_DAYS ?? '7',
    s3: createS3Client({ endpoint: env.MINIO_ENDPOINT ?? 'http://worm-minio:9000', accessKey: env.MINIO_ROOT_USER,
      secretKey: env.MINIO_ROOT_PASSWORD, region: env.MINIO_REGION ?? 'us-east-1', bucket: env.WORM_BUCKET ?? 'argus-audit-worm' }),
  };
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) {
  try {
    const port = parsePositiveInteger(process.env.PORT ?? '8787', 'PORT', 65_535);
    createGateway(loadConfig()).listen(port, '0.0.0.0', () => process.stdout.write(`Argus WORM demo gateway listening on ${port}\n`));
  } catch (error) {
    process.stderr.write(`Argus WORM demo gateway failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exit(1);
  }
}
