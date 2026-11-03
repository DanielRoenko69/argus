#!/usr/bin/env node
/**
 * Run the complete Jest suite in bounded, disposable Node processes.
 *
 * The repository contains a large TypeScript/Jest graph. Running every file
 * in one process eventually retains enough transformed modules to exhaust
 * the V8 heap. Each shard keeps the same Jest semantics (`--runInBand`) while
 * giving Node a fresh heap and module cache.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const requestedHeap = Number.parseInt(process.env.JEST_MAX_OLD_SPACE_SIZE || '4096', 10);
const maxOldSpaceSize = Number.isFinite(requestedHeap)
  ? Math.min(16384, Math.max(1024, requestedHeap))
  : 4096;
const jest = [
  `--max-old-space-size=${maxOldSpaceSize}`,
  '--experimental-vm-modules',
  'node_modules/jest/bin/jest.js',
  '--config',
  'jest.config.cjs',
];
const requestedSize = Number.parseInt(process.env.JEST_SHARD_SIZE || '1', 10);
const shardSize = Number.isFinite(requestedSize) ? Math.min(40, Math.max(1, requestedSize)) : 1;
const requestedTimeout = Number.parseInt(process.env.JEST_SHARD_TIMEOUT_MS || '300000', 10);
const shardTimeoutMs = Number.isFinite(requestedTimeout) ? Math.max(30000, requestedTimeout) : 300000;

function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

const listed = run([...jest, '--listTests', '--json'], { stdio: 'pipe', encoding: 'utf8' });
if (listed.status !== 0) {
  process.stderr.write('Jest could not enumerate test files.\n');
  process.exit(listed.status ?? 1);
}

let files;
try {
  files = JSON.parse(listed.stdout || '[]');
} catch (error) {
  process.stderr.write(`Jest returned invalid test-file JSON: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) {
  process.stderr.write('Jest returned an invalid test-file list.\n');
  process.exit(1);
}
files = files.map(file => resolve(root, file)).sort();

const shards = [];
for (let index = 0; index < files.length; index += shardSize) {
  shards.push(files.slice(index, index + shardSize));
}
process.stdout.write(
  `Jest shard runner: ${files.length} files, ${shards.length} shards, `
  + `${shardSize} files/shard, ${maxOldSpaceSize} MB heap/shard\n`,
);

for (let index = 0; index < shards.length; index += 1) {
  const shard = shards[index];
  process.stdout.write(`\n-> shard ${index + 1}/${shards.length} (${shard.length} files)\n`);
  // Copilot route tests use Node's global fetch, whose undici keep-alive pool
  // can outlive the test server. Detect and close those handles for that
  // shard; other shards retain normal Jest exit semantics.
  const handleDetection = shard.some(file => /copilot.*\.test\.ts$/.test(file))
    ? ['--detectOpenHandles']
    : [];
  const result = run([...jest, '--runInBand', ...handleDetection, ...shard], { timeout: shardTimeoutMs });
  if (result.status !== 0) {
    if (result.error?.code === 'ETIMEDOUT') {
      process.stderr.write(`\nJest shard ${index + 1}/${shards.length} exceeded ${shardTimeoutMs} ms.\n`);
    }
    process.stderr.write(`\nJest shard ${index + 1}/${shards.length} failed.\n`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write(`\nJest shard runner passed: ${files.length} files across ${shards.length} fresh processes.\n`);
