import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { runStackTests } from '/app/dist/routes/stackTests.js';
const threadId = randomUUID(), workspaceRoot = '/workspace/STACK-CERT-' + threadId;
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
await mkdir(workspaceRoot);
await writeFile(workspaceRoot + '/app.py', 'def add(a, b): return a + b\n');
execFileSync('git', ['init', '-q'], { cwd: workspaceRoot });
execFileSync('git', ['add', 'app.py'], { cwd: workspaceRoot });
execFileSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-qm', 'fixture'], { cwd: workspaceRoot });
const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' }).trim();
const common = { threadId, workspaceRoot, baseCommitSha, basisSha256: 'b'.repeat(64) };
const snapshot = await runStackTests({ ...common, action: 'inspect' });
const stackPlan = { version: 1, summary: 'Bridge fixture: exact source and pytest receipt', setup: 'python3 -c "import pytest"', start: '',
  test: 'python3 -c "from app import add; assert add(2,3)==5"', python: '/usr/bin/python3' };
const request = { ...common, action: 'project', sourceSha256: snapshot.sourceSha256, stackPlan };
const project = await runStackTests(request);
assert.equal(project.passed, true, JSON.stringify(project));
assert.equal(project.requestSha256, hash(request));
const qaRequest = { ...request, action: 'run', preparedImage: project.stackEnvironment.preparedImage,
  files: [{ id: 'sum', content: 'from app import add\ndef test_add():\n assert add(7, 8) == 15\n' }] };
const qa = await runStackTests(qaRequest);
assert.equal(qa.passed, true, JSON.stringify(qa));
assert.equal(qa.collected, 1); assert.equal(qa.requestSha256, hash(qaRequest));
assert.equal(qa.testSha256, hash(qaRequest.files));
assert.deepEqual(await runStackTests(qaRequest), qa);
const cancel = await runStackTests({ ...common, action: 'cancel' });
assert.equal(cancel.stopped, true);
console.log(JSON.stringify({ passed: true, checks: ['Workspace snapshot -> authenticated controller HTTP', 'Node/Python hash parity',
  'actual repository tests', 'real independently collected pytest artifact', 'exact prepared image', 'durable cached receipt', 'confirmed scoped cancel'] }));
