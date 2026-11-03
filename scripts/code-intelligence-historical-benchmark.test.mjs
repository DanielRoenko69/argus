import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(
  new URL('../demo/code-intelligence/pino-historical-benchmark.json', import.meta.url),
  'utf8',
));
const runner = await readFile(
  new URL('./code-intelligence-historical-benchmark.mjs', import.meta.url),
  'utf8',
);

test('historical benchmark uses immutable, source-linked Pino patches', () => {
  assert.equal(manifest.schema, 'argus.code-intelligence-historical-benchmark.v1');
  assert.equal(manifest.repository.key, 'pinojs/pino');
  assert.equal(manifest.repository.license, 'MIT');
  assert.deepEqual(manifest.lockCommand.slice(0, 3), ['npm', 'install', '--package-lock-only']);
  assert.equal(manifest.cases.length, 8);
  assert.equal(new Set(manifest.cases.map(item => item.id)).size, 8);
  for (const item of manifest.cases) {
    assert.match(item.baseCommit, /^[0-9a-f]{40}$/);
    assert.match(item.fixCommit, /^[0-9a-f]{40}$/);
    assert.notEqual(item.baseCommit, item.fixCommit);
    assert.match(item.sourceUrl, /^https:\/\/github\.com\/pinojs\/pino\/(?:issues|pull)\/\d+$/);
    assert.ok(item.ticket.length >= 80);
    assert.ok(item.retrievalExpectedFiles.length > 0);
    assert.ok(item.goldChangedFiles.length > 0);
    assert.ok(item.oraclePaths.length > 0);
    assert.ok(item.oraclePaths.every(file => item.goldChangedFiles.includes(file)));
    assert.deepEqual(item.testCommand.slice(0, 4), ['npm', 'exec', '--offline', '--']);
  }
});

test('calibration runner is history-free and enforces fail-then-pass semantics', () => {
  assert.match(runner, /'archive', '--format=tar'/);
  assert.match(runner, /safe\.directory=\$\{upstream\}/);
  assert.match(runner, /const passed = !baseline\.passed && gold\.passed/);
  assert.match(runner, /dependencyLockSha256: dependencyLock\.sha256/);
  assert.match(runner, /env: safeChildEnvironment\(options\.env\)/);
  assert.match(runner, /npm_config_userconfig: npmrc/);
  assert.match(runner, /fix must be a direct, non-merge child of its base commit/);
  assert.match(runner, /oracle path escapes benchmark root/);
  assert.match(runner, /npm_execpath is required/);
  assert.match(runner, /option\('--work-root', process\.env\.ARGUS_CODE_BENCHMARK_WORK_ROOT \?\? RESULT_ROOT\)/);
  assert.match(runner, /const root = await mkdtemp\(path\.join\(workRoot, `\$\{benchmarkCase\.id\}-`\)\)/);
  assert.doesNotMatch(runner, /git\s+clone/u);
  assert.doesNotMatch(runner, /config', '--global'/u);
  assert.doesNotMatch(runner, /shell:\s*true/u);
  assert.doesNotMatch(runner, /env:\s*\{\s*\.\.\.process\.env/u);
});

test('prepared Agent repositories contain one synthetic commit and no future refs', () => {
  assert.match(runner, /prepared repository output must stay below test-results\/benchmarks\/prepared/);
  assert.match(runner, /\['rev-list', '--count', 'HEAD'\]/);
  assert.match(runner, /prepared repository must contain exactly one synthetic commit/);
  assert.match(runner, /await materializeTree\(upstream, benchmarkCase\.baseCommit, repository\)/);
  assert.doesNotMatch(runner, /materializeTree\(upstream, benchmarkCase\.fixCommit, repository\)/);
});
