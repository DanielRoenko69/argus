// Explicit operator setup. A dedicated secret, never the Workspace/SSO credential.
import { mkdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'secrets', 'project-environments');
await mkdir(directory, { recursive: true, mode: 0o700 });
if (await realpath(directory) !== directory || ((await lstat(directory)).mode & 0o077)) throw new Error('Secret directory must be private and symlink-free');
const file = path.join(directory, 'resolver.key');
try {
  // The private parent protects the host file. The file-only read-only bind is
  // readable by UID 1000 in Docker Desktop and Linux without UID remapping.
  await writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o644 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o022) throw new Error('Unsafe existing resolver secret');
}
console.log(`Dedicated resolver secret ready at ${file}. Value not displayed.`);
