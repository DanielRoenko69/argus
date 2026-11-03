import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync, linkSync, chmodSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { codegenBytesHash, codegenHash, parseCodegenDecision } from './codeGenerationContract.js';
import { importCodegenFiles } from './codeGenerationImport.js';
import { codegenPublicError, parseWorkspaceCodegen, runCodeGeneration, sourceNow } from './codeGeneration.js';
import { parseStackBrokerResponse } from './stackTests.js';
import { mkdirSync } from 'node:fs';
import { cancelCodegen, assertCodegenNotCanceled } from './codeGenerationCancellation.js';
import { trackWorkspaceWrites } from './codeGenerationBarrier.js';
const plan = { version: 1, summary: 'fixture', setup: 'true', start: '', generate: 'generator', outputPaths: ['client.ts'] };
test('capacity and session errors survive the authenticated controller boundary without raw diagnostics', () => {
  for (const code of ['stack_session_capacity', 'stack_session_capacity_config_invalid', 'stack_database_binding_changed', 'stack_interrupted_no_replay']) {
    try { parseStackBrokerResponse(409, JSON.stringify({ error: code, secret: 'PRIVATE' })); assert.fail('must reject'); }
    catch (error) { assert.equal(codegenPublicError(error), 'codegen_' + code); }
    assert.equal(codegenPublicError(new Error(code)), 'codegen_unavailable_no_replay');
  }
  assert.equal(codegenPublicError(new Error('PRIVATE')), 'codegen_unavailable_no_replay');
});
test('saved broker rejection remains specific on re-evaluation and never redispatches', async () => {
  const store = mkdtempSync(path.join(tmpdir(), 'argus-codegen-error-'));
  try {
    const r = parseWorkspaceCodegen({ action: 'generate', threadId: randomUUID(), workspaceRoot: '/workspace/FIXTURE', allowedPaths: [],
      baseCommitSha: 'a'.repeat(40), basisSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), plan, executionMode: 'workspace-session-v1' });
    const requestSha256 = codegenHash(r), job = path.join(store, r.threadId, requestSha256);
    mkdirSync(job, { recursive: true });
    writeFileSync(path.join(job, 'intent.json'), JSON.stringify({ requestSha256, sourceSha256: r.sourceSha256 }));
    writeFileSync(path.join(job, 'broker-error.json'), JSON.stringify({ version: 1, requestSha256, code: 'codegen_stack_session_capacity' }));
    let calls = 0;
    await assert.rejects(runCodeGeneration(r, store, async () => { calls++; }), /codegen_stack_session_capacity/);
    rmSync(path.join(job, 'broker-error.json'));
    await assert.rejects(runCodeGeneration(r, store, async () => { calls++; }));
    assert.equal(calls, 0, 'a legacy missing receipt remains closed too');
  } finally { rmSync(store, { recursive: true, force: true }); }
});
const file = (content = 'new\n', before: string | null = codegenBytesHash(Buffer.from('old\n'))) =>
  ({ path: 'client.ts', beforeSha256: before, sha256: codegenBytesHash(Buffer.from(content)), content: Buffer.from(content).toString('base64') });
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'argus-codegen-test-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); writeFileSync(path.join(dir, 'client.ts'), 'old\n');
  writeFileSync(path.join(dir, 'source.ts'), 'input\n'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture');
  const request = { workspaceRoot: dir, baseCommitSha: git('rev-parse', 'HEAD') };
  return { dir, request, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test('strict proposal and private workspace boundary', () => {
  assert.equal(parseCodegenDecision(JSON.stringify({ version: 1, status: 'ready', plan }), []).status, 'ready');
  assert.throws(() => parseCodegenDecision(JSON.stringify({ version: 1, status: 'ready', plan }), ['other.ts']));
  const r = { action: 'generate', threadId: randomUUID(), workspaceRoot: '/workspace/FIXTURE', allowedPaths: [],
    baseCommitSha: 'a'.repeat(40), basisSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), plan };
  assert.deepEqual(parseWorkspaceCodegen(r), r);
  for (const delta of [{ threadId: '../other' }, { workspaceRoot: '/tmp/fixture' }, { mounts: [] }, { allowedPaths: ['.env'] }, { plan: { ...plan, outputPaths: ['../client.ts'] } }])
    assert.throws(() => parseWorkspaceCodegen({ ...r, ...delta }));
});
test('imports exactly validated outputs and preserves existing executable mode', () => {
  const f = fixture();
  try {
    const before = sourceNow(f.request); chmodSync(path.join(f.dir, 'client.ts'), 0o755);
    importCodegenFiles(f.dir, [file()], () => assert.equal(sourceNow(f.request), before));
    assert.equal(readFileSync(path.join(f.dir, 'client.ts'), 'utf8'), 'new\n');
    assert.equal(statSync(path.join(f.dir, 'client.ts')).mode & 0o777, 0o755);
    assert.equal(readFileSync(path.join(f.dir, 'source.ts'), 'utf8'), 'input\n');
    assert.notEqual(sourceNow(f.request), before);
  } finally { f.cleanup(); }
});
test('source drift and tampered bytes reject before replacement', () => {
  const f = fixture();
  try {
    const before = sourceNow(f.request);
    writeFileSync(path.join(f.dir, 'source.ts'), 'other\n');
    assert.throws(() => importCodegenFiles(f.dir, [file()], () => assert.equal(sourceNow(f.request), before)));
    assert.throws(() => importCodegenFiles(f.dir, [{ ...file(), content: 'dGFtcGVy' }], () => {}));
    assert.equal(readFileSync(path.join(f.dir, 'client.ts'), 'utf8'), 'old\n');
  } finally { f.cleanup(); }
});
test('workspace-session import includes hidden sources but not its own staged files', () => {
  const f = fixture();
  try {
    const request = { ...f.request, executionMode: 'workspace-session-v1' as const };
    writeFileSync(path.join(f.dir, '.python-version'), '3.14\n');
    writeFileSync(path.join(f.dir, '.argus-codegen-project-file'), 'ordinary hidden input\n');
    const before = sourceNow(request);
    let checks = 0;
    importCodegenFiles(f.dir, [file()], staged => {
      checks++;
      assert.equal(sourceNow(request, staged), before);
    });
    assert.equal(checks, 2, 'whole source checked before and after staging');
    assert.equal(readFileSync(path.join(f.dir, 'client.ts'), 'utf8'), 'new\n');
    assert.deepEqual(readdirSync(f.dir).filter(n => n.startsWith('.argus-codegen-')), ['.argus-codegen-project-file']);
    assert.equal(readFileSync(path.join(f.dir, '.python-version'), 'utf8'), '3.14\n');
  } finally { f.cleanup(); }
});
test('hidden-source drift and staged-output tampering remain blocked', () => {
  for (const kind of ['hidden-source', 'internal-looking-source', 'staged-bytes', 'staged-link']) {
    const f = fixture();
    try {
      const request = { ...f.request, executionMode: 'workspace-session-v1' as const };
      const before = sourceNow(request);
      assert.throws(() => importCodegenFiles(f.dir, [file()], staged => {
        if (staged?.length) {
          if (kind === 'hidden-source') writeFileSync(path.join(f.dir, '.python-version'), '3.14\n');
          if (kind === 'internal-looking-source') writeFileSync(path.join(f.dir, '.argus-codegen-unrelated'), 'changed\n');
          if (kind === 'staged-bytes') writeFileSync(staged[0]!, 'tampered\n');
          if (kind === 'staged-link') { rmSync(staged[0]!); symlinkSync('source.ts', staged[0]!); }
        }
        assert.equal(sourceNow(request, staged), before);
      }), () => true, kind);
      assert.equal(readFileSync(path.join(f.dir, 'client.ts'), 'utf8'), 'old\n');
      assert.equal(readFileSync(path.join(f.dir, 'source.ts'), 'utf8'), 'input\n');
    } finally { f.cleanup(); }
  }
});
test('hard links, symlinks, parent symlinks and protected outputs cannot be imported', () => {
  for (const kind of ['hard', 'symbolic', 'parent', 'protected']) {
    const f = fixture();
    try {
      let output = file();
      if (kind === 'hard') linkSync(path.join(f.dir, 'client.ts'), path.join(f.dir, 'alias.ts'));
      if (kind === 'symbolic') { rmSync(path.join(f.dir, 'client.ts')); symlinkSync('source.ts', path.join(f.dir, 'client.ts')); }
      if (kind === 'parent') { symlinkSync(f.dir, path.join(f.dir, 'linked')); output = { ...file(), path: 'linked/client.ts' }; }
      if (kind === 'protected') output = { ...file('new', null), path: 'Jenkinsfile' };
      assert.throws(() => importCodegenFiles(f.dir, [output], () => {}));
      assert.equal(readFileSync(path.join(f.dir, 'source.ts'), 'utf8'), 'input\n');
      assert.equal(existsSync(path.join(f.dir, 'Jenkinsfile')), false);
    } finally { f.cleanup(); }
  }
});
test('an in-flight writer blocks import until operation finish, including trailing slash routes', () => {
  const f = fixture(), res = new EventEmitter();
  try {
    trackWorkspaceWrites({ method: 'POST', path: '/codex/run/' } as never, res as never, () => {});
    assert.throws(() => importCodegenFiles(f.dir, [file()], () => {}), /busy/);
    res.emit('close'); // client disconnect is NOT proof the writer stopped
    assert.throws(() => importCodegenFiles(f.dir, [file()], () => {}), /busy/);
    res.emit('finish'); importCodegenFiles(f.dir, [file()], () => {});
  } finally { f.cleanup(); }
});
test('cancellation persists and is scoped to one run', async () => {
  const f = fixture(), thread = randomUUID();
  try {
    assertCodegenNotCanceled(thread, f.dir);
    await cancelCodegen(thread, f.dir); await cancelCodegen(thread, f.dir);
    assert.throws(() => assertCodegenNotCanceled(thread, f.dir), /canceled/);
    assertCodegenNotCanceled(randomUUID(), f.dir);
  } finally { f.cleanup(); }
});
test('the serialized recovery routes do not count themselves as competing writers', () => {
  const f = fixture();
  try {
    for (const route of ['/code-generation/recovery-preview', '/code-generation/recover/']) {
      const response = new EventEmitter();
      trackWorkspaceWrites({ method: 'POST', path: route } as never, response as never, () => {});
      assert.doesNotThrow(() => importCodegenFiles(f.dir, [file('old\n')], () => {}));
    }
  } finally { f.cleanup(); }
});
