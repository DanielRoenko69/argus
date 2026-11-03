import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const target = resolve(process.argv[2] ?? 'secrets/argus-audit-signing-key.pem');
if (existsSync(target)) {
  if (statSync(target).size === 0) throw new Error(`Refusing to use empty audit signing key: ${target}`);
  process.stdout.write(`Audit signing key already exists: ${target}\n`);
  process.exit(0);
}
mkdirSync(dirname(target), { recursive: true });
const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const fd = openSync(target, 'wx', 0o600);
try { writeFileSync(fd, pem); } finally { closeSync(fd); }
process.stdout.write(`Generated machine-local Ed25519 audit signing key: ${target}\n`);
