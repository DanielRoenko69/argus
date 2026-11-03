// Explicit cross-repository integration gate. Standalone image unit tests must
// not require a host-only sibling directory. Missing/mismatched contracts fail;
// this check never silently skips and needs no installed npm dependencies.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dev = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [resolve(dev, '../..'), resolve(dev, '../argus-core')];
const core = process.env.ARGUS_CORE_ROOT
  ? resolve(process.env.ARGUS_CORE_ROOT)
  : candidates.find(candidate => existsSync(resolve(candidate, 'src/solutionPacks/codeGenerationContract.ts')));
assert.ok(core, 'Set ARGUS_CORE_ROOT to the matching Core checkout; contract verification is required.');
const pairs = [
  ['codeGenerationContract.ts', 'src/solutionPacks/codeGenerationContract.ts'],
  ['codeGenerationContract.ts', 'agent-workspace/src/routes/codeGenerationContract.ts'],
  ['stackEnvironment.ts', 'src/solutionPacks/stackEnvironment.ts'],
];
for (const [local, remote] of pairs) {
  assert.equal(readFileSync(resolve(core, remote), 'utf8'), readFileSync(resolve(dev, 'src', local), 'utf8'),
    `Core/Dev contract mismatch: ${remote}`);
}
console.log(`PASS: ${pairs.length} Core/Dev/Workspace wire contracts are byte-identical.`);
