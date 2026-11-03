import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentHash, manifestLanguage, parseCatalog, planEnvironment, projectIdentity, type EnvironmentProfile } from './catalog.js';
import { installationProbe, preflightProbe } from './prepare.js';
import { sandboxArgs } from '../routes/technicalExperiment.js';
const manifest: Array<[string, string]> = [['requirements.txt', 'a'.repeat(64)]];
const runtime = 'cpython-3.12.13-linux-aarch64';
export const profile = (): EnvironmentProfile => ({ id: 'fixture-python', adapter: 'python-wheels-v1',
  manifestSha256: projectIdentity(manifest).manifestSha256, pythonVersion: '3.12', imports: ['pytest', 'packaging'],
  wheels: ['pytest', 'packaging'].map(name => ({ name, version: '1.0', file: `${name}-1.0-py3-none-any.whl`, sha256: 'b'.repeat(64) })) });
const catalog = () => ({ version: 1, profiles: [profile()] });
test('language-independent detection includes nested manifests and exact complete manifest binding', () => {
  for (const [name, language] of [['backend/pyproject.toml', 'python'], ['frontend/bun.lock', 'node'], ['pom.xml', 'java'],
    ['app/app.csproj', 'dotnet'], ['go.mod', 'go'], ['Cargo.lock', 'rust']]) assert.equal(manifestLanguage(name!), language);
  const a = projectIdentity(manifest);
  assert.deepEqual(projectIdentity([...manifest, ['src/motor.py', 'c'.repeat(64)]]), a);
  assert.notEqual(projectIdentity([['requirements.txt', 'd'.repeat(64)]]).manifestSha256, a.manifestSha256);
  assert.notEqual(projectIdentity([...manifest, ['uv.lock', 'a'.repeat(64)]]).manifestSha256, a.manifestSha256);
});
test('policy rejects URLs, scripts, path traversal, missing closure tools and ambiguous profiles', () => {
  assert.deepEqual(parseCatalog(catalog()), [profile()]);
  const p = profile();
  for (const delta of [{ id: null }, { command: 'pip install anything' }, { adapter: 'node-unreviewed' }, { imports: ['x; os.system("x")'] },
    { wheels: [{ ...p.wheels[0], file: '../outside.whl' }, p.wheels[1]] },
    { wheels: [{ ...p.wheels[0], version: 'https://other' }, p.wheels[1]] },
    { pythonVersion: 3.12 }, { wheels: [{ ...p.wheels[0], version: 1 }, p.wheels[1]] },
    { wheels: [p.wheels[0]] }, { wheels: [...p.wheels, p.wheels[0]] }]) {
    assert.throws(() => parseCatalog({ version: 1, profiles: [{ ...p, ...delta }] }));
  }
  assert.throws(() => parseCatalog({ version: 1, profiles: [p, { ...p, id: 'duplicate-binding' }] }));
});
test('readiness never grants a fallback runtime, unsupported adapter or undeclared package set', () => {
  const p = profile(), ready = planEnvironment(manifest, runtime, [p]);
  assert.equal(ready.status, 'ready'); assert.equal(ready.profileSha256, environmentHash(p));
  assert.equal(planEnvironment(manifest, 'cpython-3.14.0-linux-aarch64', [p]).status, 'blocked');
  assert.equal(planEnvironment(manifest, runtime, []).status, 'blocked');
  assert.equal(planEnvironment(manifest, runtime, [p], false).status, 'blocked');
  for (const files of [[['package.json', 'a']], [...manifest, ['frontend/package.json', 'b']]]) {
    assert.ok(planEnvironment(files as Array<[string, string]>, runtime, [p]).reasons.includes('environment_adapter_not_available'));
  }
});
test('offline installer has exact pinned hashes, no repository installer/build hook or network', () => {
  const script = installationProbe(profile(), ['py3-none-any']);
  for (const protection of ['validate_record(validate_contents=True)', 'bytecode_optimization_levels=()', 'environment_artifact_hash_mismatch', 'environment_wheel_incompatible']) assert.ok(script.includes(protection));
  assert.ok(!script.includes('setup.py')); assert.ok(!script.includes('--extra-index-url'));
  assert.match(preflightProbe(profile()), /distributions\(path=\['\/deps'\]\)/);
  const args = sandboxArgs('/private-job', '/private-job/deps', true);
  assert.ok(args.includes('--unshare-all')); assert.ok(args.includes('--clearenv'));
  assert.deepEqual(args.slice(args.indexOf('--bind'), args.indexOf('--bind') + 3), ['--bind', '/private-job/deps', '/deps']);
  assert.match(args.at(-1)!, /socket socketpair connect/); assert.match(args.at(-1)!, /fork vfork execve/);
  assert.ok(!args.includes('--share-net')); assert.ok(!args.join(' ').includes('/home/node'));
  assert.ok(!sandboxArgs('/private-job', '/private-job/deps').includes('--bind'), 'tests retain read-only deps');
});
