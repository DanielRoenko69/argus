import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const privateKeyPath = resolve(root, 'secrets/argus-worm-demo-signing-key.pem');
const publicKeyPath = resolve(root, 'secrets/argus-worm-demo-public-key.pem');
const tokenPath = resolve(root, 'secrets/argus-worm-demo-token');
const envPath = resolve(root, '.env.worm-demo.local');

function writeExclusive(path, content, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const handle = openSync(path, 'wx', mode);
  try { writeFileSync(handle, content); } finally { try { chmodSync(path, mode); } catch { /* Windows ACLs apply. */ } }
}

if (!existsSync(privateKeyPath)) {
  const { privateKey } = generateKeyPairSync('ed25519');
  writeExclusive(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
}
const privateKey = readFileSync(privateKeyPath);
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
if (!existsSync(publicKeyPath)) writeExclusive(publicKeyPath, publicKey);
else if (readFileSync(publicKeyPath, 'utf8') !== String(publicKey)) throw new Error('Existing WORM demo public key does not match the private key');

if (!existsSync(tokenPath)) writeExclusive(tokenPath, `${randomBytes(32).toString('base64url')}\n`);
if (!existsSync(envPath)) {
  writeExclusive(envPath, [
    '# Generated local-only MinIO WORM demo credentials. Never commit this file.',
    `WORM_MINIO_ROOT_USER=argus-${randomBytes(6).toString('hex')}`,
    `WORM_MINIO_ROOT_PASSWORD=${randomBytes(32).toString('base64url')}`,
    'WORM_MINIO_REGION=us-east-1',
    'WORM_BUCKET=argus-audit-worm',
    'WORM_RETENTION_DAYS=7',
    'WORM_PROVIDER_NAME=Argus MinIO WORM Demo',
    'WORM_SIGNING_KEY_ID=argus-minio-worm-demo-v1',
    'WORM_MINIO_PORT=9900',
    'WORM_MINIO_CONSOLE_PORT=9901',
    'WORM_GATEWAY_PORT=8787',
    '',
  ].join('\n'));
}

process.stdout.write('Local WORM demo identity is ready (private values remain in ignored files).\n');
