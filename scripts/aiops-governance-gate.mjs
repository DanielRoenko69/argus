#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const node = process.execPath;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
  }
}

const backendTests = [
  'src/auth/__tests__/permissions.test.ts',
  'src/observability/__tests__/incidentAiopsTasks.test.ts',
  'src/observability/__tests__/nativeAlertAiopsAutomation.test.ts',
  'src/observability/__tests__/incidentRemediations.test.ts',
  'src/observability/__tests__/incidentRemediationAudit.test.ts',
  'src/observability/__tests__/incidentRemediationExecutor.test.ts',
  'src/observability/__tests__/incidentRemediationReconciliation.test.ts',
  'src/observability/__tests__/nativeAlerts.test.ts',
  'src/solutionPacks/__tests__/routes.test.ts',
];

try {
  process.stdout.write('AIOps governance gate: build backend\n');
  run(node, ['node_modules/typescript/bin/tsc']);

  process.stdout.write('AIOps governance gate: deterministic incident and remediation lifecycle\n');
  run(node, [
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--config', 'jest.config.cjs',
    '--runInBand',
    ...backendTests,
  ]);

  process.stdout.write('AIOps governance gate: connector and controlled-regression contracts\n');
  run(node, [
    '--test', '--test-concurrency=1',
    'scripts/aiops-remediation-connector.test.mjs',
    'scripts/aiops-deployment-regression-demo.test.mjs',
  ]);

  process.stdout.write('AIOps governance gate passed.\n');
} catch (error) {
  process.stderr.write(`AIOps governance gate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
