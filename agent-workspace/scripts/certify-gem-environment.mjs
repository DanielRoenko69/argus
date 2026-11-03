// Operator smoke of the pinned original GEM tree, not acceptance of issue #6.
// Source archive must contain the reviewed baseline, no existing run workspace.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { qaSnapshot, runQaTests } from '/app/dist/routes/qaTests.js';
assert.equal(process.env.ARGUS_GEM_ENVIRONMENT_SMOKE, 'true');
const archive = process.argv[2];
assert.ok(archive?.startsWith('/') && archive.endsWith('/gem.tar'));
const root = await mkdtemp('/workspace/argus-gem-env-smoke-');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
try {
  execFileSync('tar', ['-xf', archive, '-C', root]);
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=EnvironmentSmoke', '-c', 'user.email=smoke@invalid', 'commit', '-qm', 'unchanged pinned GEM baseline']);
  const request = { action: 'inspect', threadId: randomUUID(), workspaceRoot: root,
    baseCommitSha: git(['rev-parse', 'HEAD']), basisSha256: 'e'.repeat(64), environmentPolicyVersion: 1 };
  const snapshot = await qaSnapshot(request);
  assert.equal(snapshot.environment?.status, 'ready', JSON.stringify(snapshot.environment));
  const receipt = await runQaTests({ ...request, action: 'run', sourceSha256: snapshot.sourceSha256,
    environmentPlanSha256: snapshot.environment.planSha256,
    files: [{ id: 'gem_environment_smoke', content: `import pathlib, socket, subprocess, pytest
import numpy as np
from packaging.version import Version
import gym_electric_motor as gem
def test_pinned_source_and_dependencies():
 assert pathlib.Path(gem.__file__).is_relative_to('/repo/src')
 assert Version(np.__version__) == Version('2.5.3')
 assert not pathlib.Path('/home/node/.codex').exists()
 with pytest.raises(OSError): socket.socket()
 with pytest.raises(OSError): subprocess.run(['/usr/bin/true'])
 with pytest.raises(OSError): pathlib.Path('/deps/injected.py').write_text('no')
 with pytest.raises(OSError): pathlib.Path('/repo/src/injected.py').write_text('no')
def test_scalar_pmsm_reset_and_step():
 env = gem.make('Finite-CC-PMSM-v0', visualization=())
 try:
  observation, info = env.reset(seed=20260928)
  assert env.observation_space.contains(observation)
  assert all(np.isfinite(x).all() for x in observation)
  observation, reward, terminated, truncated, info = env.step(0)
  assert env.observation_space.contains(observation)
  assert np.isfinite(reward)
  assert isinstance(terminated, (bool, np.bool_))
 finally:
  env.close()
` }] });
  if (!receipt.passed) {
    // Bounded local diagnostic for this explicit public-source smoke only.
    for (const phase of ['installation', 'preflight']) {
      try { console.log(await readFile(`/runtime/technical-experiments/qa-tests/${request.threadId}/${receipt.requestSha256}/environment-${phase}.json`, 'utf8')); } catch { /* phase not reached */ }
    }
    console.log(JSON.stringify({ status: receipt.status, environment: receipt.environment?.reason, stdout: receipt.stdout, stderr: receipt.stderr }));
  }
  assert.equal(receipt.passed, true);
  assert.equal(receipt.collected, 2);
  assert.equal((await qaSnapshot(request)).sourceSha256, snapshot.sourceSha256);
  console.log(JSON.stringify({ passed: true, providerCalls: 0, tests: receipt.collected,
    profile: receipt.environment.plan.profileId, runtime: receipt.environment.plan.runtime,
    manifestSha256: receipt.environment.plan.manifestSha256, packages: receipt.environment.packages.length,
    sourceSha256: receipt.sourceSha256, testSha256: receipt.testSha256, outputSha256: receipt.outputSha256,
    requestSha256: receipt.requestSha256, threadId: request.threadId,
    boundary: 'fresh dependencies + unchanged GEM imports/reset/step + sandbox controls; not issue acceptance or a Dev run' }));
} finally {
  await rm(root, { recursive: true, force: true }); // Only this freshly created fixture.
}
