#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const reportPath = process.env.ARGUS_GOLDEN_PATH_CONTRACT_REPORT
  || 'test-results/golden-path-contract.json';
const startedAt = new Date();

function run(label, command, args) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  return {
    label,
    status: result.status === 0 && !result.error ? 'passed' : 'failed',
    duration_ms: Date.now() - started,
    output_sha256: createHash('sha256').update(combined).digest('hex'),
    error: result.error ? String(result.error.message).slice(0, 500) : result.status === 0 ? null : combined.slice(-1_000),
  };
}

function revision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8', shell: false, windowsHide: true });
  return result.status === 0 ? result.stdout.trim().slice(0, 128) : null;
}

const checks = [];
checks.push(run('typescript-build', process.execPath, ['node_modules/typescript/bin/tsc']));
if (checks[0].status === 'passed') {
  checks.push(run('golden-path-contracts', process.execPath, [
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--config', 'jest.config.cjs',
    '--runInBand',
    'src/goldenPath/__tests__/contracts.test.ts',
    'src/goldenPath/__tests__/preflight.test.ts',
    'src/goldenPath/__tests__/routes.test.ts',
  ]));
}

const report = {
  schema: 'argus.golden-path-contract-certification.v1',
  status: checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
  generated_at: new Date().toISOString(),
  started_at: startedAt.toISOString(),
  git_revision: revision(),
  guarantees: [
    'certification and live providers cannot be silently interchanged',
    'only append-only saved workflow revisions can become startable',
    'guarded writes require approval and separation of duties',
    'read-only mode grants no external write operations',
    'preflight requires authenticated named-permission access',
    'API fixtures contain no credential-shaped fields',
  ],
  checks,
  note: 'This gate certifies the Golden Path v1 contract and live preflight projection. Full provider side effects, restart/retry and evidence generation are certified by the later end-to-end gate.',
};

await mkdir(dirname(resolve(reportPath)), { recursive: true });
await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ status: report.status, report: reportPath, checks: checks.map(check => ({ label: check.label, status: check.status })) }, null, 2)}\n`);
if (report.status !== 'passed') process.exitCode = 2;
