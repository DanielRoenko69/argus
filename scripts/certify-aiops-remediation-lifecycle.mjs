#!/usr/bin/env node

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const node = process.execPath;
const live = process.argv.slice(2).includes('--live');
const confirmation = 'scale-and-restore-argus-demo';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
  }
}

const lifecycleTests = [
  'src/auth/__tests__/permissions.test.ts',
  'src/solutionPacks/__tests__/routes.test.ts',
  'src/observability/__tests__/incidentRemediations.test.ts',
  'src/observability/__tests__/incidentRemediationAudit.test.ts',
  'src/observability/__tests__/incidentRemediationExecutor.test.ts',
  'src/observability/__tests__/incidentRemediationReconciliation.test.ts',
];

try {
  process.stdout.write('AIOps remediation certification: build backend\n');
  run(node, ['node_modules/typescript/bin/tsc']);

  process.stdout.write('AIOps remediation certification: RBAC and immutable lifecycle contracts\n');
  run(node, [
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--config', 'jest.config.cjs',
    '--runInBand',
    ...lifecycleTests,
  ]);

  process.stdout.write('AIOps remediation certification: bounded connector and recovery contracts\n');
  run(node, [
    '--test', '--test-concurrency=1',
    'scripts/aiops-remediation-connector.test.mjs',
    'scripts/aiops-deployment-regression-demo.test.mjs',
  ]);

  if (live) {
    if (process.env.ARGUS_AIOPS_REMEDIATION_E2E_CONFIRM !== confirmation) {
      throw new Error(`--live requires ARGUS_AIOPS_REMEDIATION_E2E_CONFIRM=${confirmation}`);
    }
    process.stdout.write('AIOps remediation certification: live scale, revision, verification and restore\n');
    run(node, ['dist/scripts/verifyAiopsRemediationConnector.js']);
  } else {
    process.stdout.write('AIOps remediation certification: live provider mutation skipped (pass --live with the exact confirmation value)\n');
  }

  process.stdout.write(`AIOps remediation certification passed (${live ? 'contracts + live provider' : 'mutation-free contracts'}).\n`);
} catch (error) {
  process.stderr.write(`AIOps remediation certification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
