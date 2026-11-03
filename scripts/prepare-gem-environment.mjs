// Operator-only, explicit local GEM profile preparation. Never called by an agent/run.
// Downloads pinned public wheels in a disposable container, not into the live Workspace.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestLanguage, projectIdentity, parseCatalog } from '../agent-workspace/dist/environments/catalog.js';
import { snapshotPathAllowed } from '../agent-workspace/dist/routes/technicalExperiment.js';

assert.equal(process.env.ARGUS_PREPARE_GEM_ENVIRONMENT, 'true', 'explicit operator opt-in required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test-results', 'gem-environment-20260928');
const container = 'argus-core-agent-workspace-1';
const checkout = '/workspace/DEMO-GEM-182-QA-20260928-03';
const commit = 'd64d0ecb0c96cbcef619f22870df1b3bd3862378';
const hash = b => createHash('sha256').update(b).digest('hex');
const docker = args => execFileSync('docker', args, { maxBuffer: 256 * 1024 * 1024 });
const git = args => docker(['exec', container, 'git', '-C', checkout, ...args]);
assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), commit);
// Exact versions already used by the local GEM test environment, plus its missing
// packaging import. Do not install GEM itself: tests must import copied /repo/src.
const pins = [
  'cloudpickle==3.1.2', 'contourpy==1.4.0', 'coverage==7.16.2', 'cycler==0.12.1',
  'farama-notifications==0.0.6', 'fonttools==4.66.0', 'gymnasium==1.3.0',
  'iniconfig==2.3.0', 'kiwisolver==1.5.1', 'matplotlib==3.11.2', 'numpy==2.5.3',
  'packaging==25.0', 'pathspec==1.1.1', 'pillow==12.3.0', 'pluggy==1.6.0',
  'pygments==2.21.0', 'pyparsing==3.2.5', 'pytest==9.1.1', 'pytest-cov==7.1.0',
  'python-dateutil==2.9.0.post0', 'scipy==1.18.1', 'six==1.17.0', 'typing-extensions==4.16.0',
];
if (process.argv.includes('--record')) {
  const catalog = JSON.parse(readFileSync(path.join(out, 'catalog.json')));
  parseCatalog(catalog);
  for (const [source, target] of [['catalog.json', 'gem-python312.catalog.json'], ['requirements.lock', 'gem-python312.requirements.lock'], ['profile-input.json', 'gem-python312.provenance.json']]) {
    writeFileSync(path.join(root, 'demo/project-environments', target), readFileSync(path.join(out, source)), { flag: 'wx' });
  }
  console.log('Recorded generated non-secret GEM profile, provenance and hash lock.');
} else if (!process.argv.includes('--finish')) {
  mkdirSync(out); // Deliberately refuse an existing preparation; never overwrite evidence.
  const names = git(['ls-tree', '-rz', '--name-only', commit]).toString().split('\0').filter(Boolean);
  const manifest = names.filter(n => snapshotPathAllowed(n, '100644') && manifestLanguage(n)).sort()
    .map(n => [n, hash(git(['show', `${commit}:${n}`]))]);
  const identity = projectIdentity(manifest);
  assert.deepEqual(identity.languages, ['python']);
  writeFileSync(path.join(out, 'gem.tar'), git(['archive', '--format=tar', commit]));
  writeFileSync(path.join(out, 'profile-input.json'), JSON.stringify({
    version: 1, sourceCommit: commit, manifests: manifest, ...identity,
    id: 'demo-gem-python312-v1', pythonVersion: '3.12',
    imports: ['pytest', 'packaging', 'numpy', 'scipy', 'matplotlib', 'gymnasium', 'gym_electric_motor'],
  }, null, 2) + '\n');
  writeFileSync(path.join(out, 'requirements.in'), pins.join('\n') + '\n');
  console.log(JSON.stringify({ out, commit, ...identity, manifests: manifest.map(([n]) => n), pins: pins.length }));
} else {
  const input = JSON.parse(readFileSync(path.join(out, 'profile-input.json')));
  const wheels = readdirSync(path.join(out, 'wheels')).sort().map(file => {
    assert.match(file, /^[A-Za-z0-9][A-Za-z0-9_.+-]+\.whl$/);
    const [rawName, version] = file.split('-'), name = rawName.toLowerCase().replaceAll('_', '-');
    assert.ok(pins.includes(`${name}==${version}`), `unapproved distribution: ${name}`);
    return { file, name, version, sha256: hash(readFileSync(path.join(out, 'wheels', file))) };
  });
  assert.equal(wheels.length, pins.length);
  const catalog = { version: 1, profiles: [{ id: input.id, adapter: 'python-wheels-v1',
    manifestSha256: input.manifestSha256, pythonVersion: input.pythonVersion, wheels, imports: input.imports }] };
  parseCatalog(catalog);
  writeFileSync(path.join(out, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(path.join(out, 'requirements.lock'), wheels.map(w => `${w.name}==${w.version} --hash=sha256:${w.sha256}`).join('\n') + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ out, profile: input.id, manifestSha256: input.manifestSha256, wheels: wheels.length }));
}
