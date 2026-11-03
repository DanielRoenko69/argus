import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const KIND = 'argus.pilot-recovery-bundle';
const SCHEMA_VERSION = 1;

export function recoverySha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireKey(value) {
  if (typeof value !== 'string' || value.length < 32) {
    throw new Error('ARGUS_PILOT_BACKUP_KEY must contain at least 32 characters');
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createEncryptedRecoveryBundle(payload, passphrase, now = new Date()) {
  requireKey(passphrase);
  if (!Buffer.isBuffer(payload.databaseArchive) || payload.databaseArchive.length === 0) {
    throw new Error('databaseArchive must be a non-empty Buffer');
  }
  const workspaceFiles = (payload.workspaceFiles ?? []).map(file => ({
    path: String(file.path),
    sha256: recoverySha256(file.content),
    content: Buffer.from(file.content).toString('base64'),
  }));
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: `${KIND}.manifest`,
    createdAt: now.toISOString(),
    gitRevision: payload.gitRevision ?? null,
    database: {
      format: 'postgres-custom',
      bytes: payload.databaseArchive.length,
      sha256: recoverySha256(payload.databaseArchive),
    },
    workspace: {
      fileCount: workspaceFiles.length,
      files: workspaceFiles.map(({ path, sha256, content }) => ({
        path, sha256, bytes: Buffer.from(content, 'base64').length,
      })),
    },
    configuration: [...(payload.configuration ?? [])].sort((left, right) => left.path.localeCompare(right.path)),
    wormReceipts: payload.wormReceipts ?? [],
    secretPolicy: 'references-only; no plaintext credentials or encryption key',
  };
  const plaintext = Buffer.from(canonical({
    manifest,
    databaseArchive: payload.databaseArchive.toString('base64'),
    workspaceFiles,
  }), 'utf8');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    createdAt: manifest.createdAt,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    manifestSha256: recoverySha256(Buffer.from(canonical(manifest), 'utf8')),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function openEncryptedRecoveryBundle(bundle, passphrase) {
  requireKey(passphrase);
  if (bundle?.schemaVersion !== SCHEMA_VERSION || bundle?.kind !== KIND
    || bundle?.cipher !== 'aes-256-gcm' || bundle?.kdf !== 'scrypt') {
    throw new Error('unsupported Argus recovery bundle');
  }
  const salt = Buffer.from(bundle.salt, 'base64');
  const iv = Buffer.from(bundle.iv, 'base64');
  const authTag = Buffer.from(bundle.authTag, 'base64');
  const ciphertext = Buffer.from(bundle.ciphertext, 'base64');
  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed = JSON.parse(plaintext.toString('utf8'));
  const manifestDigest = recoverySha256(Buffer.from(canonical(parsed.manifest), 'utf8'));
  if (manifestDigest !== bundle.manifestSha256) throw new Error('recovery manifest digest mismatch');
  const databaseArchive = Buffer.from(parsed.databaseArchive, 'base64');
  if (recoverySha256(databaseArchive) !== parsed.manifest.database.sha256) {
    throw new Error('database archive digest mismatch');
  }
  const workspaceFiles = parsed.workspaceFiles.map(file => {
    const content = Buffer.from(file.content, 'base64');
    if (recoverySha256(content) !== file.sha256) throw new Error(`workspace artifact digest mismatch: ${file.path}`);
    return { path: file.path, content, sha256: file.sha256 };
  });
  return { manifest: parsed.manifest, databaseArchive, workspaceFiles };
}
