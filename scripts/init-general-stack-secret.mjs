import { mkdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'secrets', 'project-environments');
await mkdir(directory, { recursive: true, mode: 0o700 });
if (await realpath(directory) !== directory || ((await lstat(directory)).mode & 0o077)) throw new Error('Secret directory must be private and symlink-free');
const file = path.join(directory, 'stack-runner.key');
try { await writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o644 }); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o022) throw new Error('Unsafe existing runner secret');
}
console.log('Dedicated stack-runner secret ready; value not displayed.');
