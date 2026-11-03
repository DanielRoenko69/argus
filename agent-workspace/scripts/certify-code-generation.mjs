import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { runCodeGeneration, parseWorkspaceCodegen } from '/app/dist/routes/codeGeneration.js';
import { cancelCodegen } from '/app/dist/routes/codeGenerationCancellation.js';
import { runStackTests, stackBroker } from '/app/dist/routes/stackTests.js';
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function fixture() {
  const threadId = randomUUID(), workspaceRoot = '/workspace/CODEGEN-CERT-' + threadId;
  await mkdir(workspaceRoot);
  await writeFile(workspaceRoot + '/schema.txt', 'query: string\n');
  await writeFile(workspaceRoot + '/client.ts', 'old\n');
  await writeFile(workspaceRoot + '/generate.py', "from pathlib import Path\nimport packaging\nassert packaging.__version__ == '24.2'\nPath('client.ts').write_text('export type Query = string;\\n')\n");
  await writeFile(workspaceRoot + '/.gitignore', 'ignored.ts\n');
  execFileSync('git', ['init', '-q'], { cwd: workspaceRoot });
  execFileSync('git', ['add', '.'], { cwd: workspaceRoot });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-qm', 'fixture'], { cwd: workspaceRoot });
  const baseCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' }).trim();
  const common = { threadId, workspaceRoot, baseCommitSha, basisSha256: 'b'.repeat(64) };
  const snapshot = await runStackTests({ ...common, action: 'inspect' });
  const plan = { version: 1, summary: 'Install public packaging in disposable venv, run checked-in generator offline',
    setup: 'python3 -m venv /opt/gen\n/opt/gen/bin/pip -q install packaging==24.2\n(sleep 120) >/tmp/background.log 2>&1 &',
    start: '',
    generate: "/opt/gen/bin/python generate.py\n/opt/gen/bin/python - <<'PY'\nimport socket, os\nassert not os.path.exists('/run/secrets')\nassert not os.path.exists('/var/run/docker.sock')\nassert not any(k in os.environ for k in ['WORKSPACE_SECRET', 'GITEA_TOKEN', 'ARGUS_API_KEY'])\ns=socket.socket(); s.settimeout(1); assert s.connect_ex(('1.1.1.1',443)) != 0\ntry: socket.gethostbyname('stack-egress'); raise AssertionError('proxy still connected')\nexcept socket.gaierror: pass\nPY",
    outputPaths: ['client.ts'] };
  return { ...common, action: 'generate', sourceSha256: snapshot.sourceSha256, plan, allowedPaths: ['client.ts'] };
}
const request = await fixture();
const beforeInput = await readFile(request.workspaceRoot + '/schema.txt', 'utf8');
const result = await runCodeGeneration(request);
assert.equal(result.applied, true); assert.equal(result.requestSha256, hash(parseWorkspaceCodegen(request)));
assert.equal(await readFile(request.workspaceRoot + '/client.ts', 'utf8'), 'export type Query = string;\n');
assert.equal(await readFile(request.workspaceRoot + '/schema.txt', 'utf8'), beforeInput);
assert.deepEqual(await runCodeGeneration(request), result);
await writeFile(request.workspaceRoot + '/schema.txt', 'concurrent drift\n');
await assert.rejects(runCodeGeneration(request), /source_changed/);
for (const mode of ['modified-input', 'modified-setup', 'binary', 'failed', 'ignored', 'cancel-before-import', 'response-lost']) {
  const r = await fixture();
  if (mode === 'ignored') r.plan.outputPaths = r.allowedPaths = ['ignored.ts'];
  if (mode === 'modified-input') r.plan.generate += '\nprintf changed > schema.txt';
  if (mode === 'modified-setup') r.plan.setup += '\nprintf changed > schema.txt';
  if (mode === 'binary') r.plan.generate = "python3 -c \"open('client.ts','wb').write(bytes([0]))\"";
  if (mode === 'failed') r.plan.generate = 'exit 9';
  // Avoid reinstalling tools in the negative fixtures: the generator can run
  // with the base Python for these deterministic boundary checks.
  if (!['modified-setup'].includes(mode)) r.plan.setup = 'true';
  r.plan.generate = r.plan.generate.replaceAll('/opt/gen/bin/python', 'python3').replace('python3 generate.py', "python3 -c \"open('client.ts','w').write('generated')\"");
  let calls = 0;
  const post = async (action, body) => {
    calls++;
    const output = await stackBroker(action, body);
    if (mode === 'response-lost') throw Error('synthetic response loss after completed generation');
    if (mode === 'cancel-before-import') await cancelCodegen(r.threadId);
    return output;
  };
  await assert.rejects(runCodeGeneration(r, undefined, post));
  assert.equal(await readFile(r.workspaceRoot + '/client.ts', 'utf8'), 'old\n', mode);
  const firstCalls = calls;
  await assert.rejects(runCodeGeneration(r, undefined, post));
  assert.equal(calls, firstCalls, 'no uncertain redispatch: ' + mode);
}
const canceled = await fixture();
await cancelCodegen(canceled.threadId);
await assert.rejects(runCodeGeneration(canceled, undefined, () => { throw Error('must not dispatch'); }), /canceled/);
// Real validated terminal failure -> a DIFFERENT recipe, SAME source/thread/scope.
// No model/provider is involved and no live application checkout is mounted.
const correction = await fixture();
correction.plan.setup = 'python3 -m venv /opt/gen\n/opt/gen/bin/pip -q install packaging==24.2 email-validator==2.3.0';
correction.plan.start = 'export FIRST_SUPERUSER=argus@example.invalid';
correction.plan.generate = '/opt/gen/bin/python -c "import os; from email_validator import validate_email; validate_email(os.environ[\'FIRST_SUPERUSER\'], check_deliverability=False)"\n' + correction.plan.generate;
const originalPlan = structuredClone(correction.plan);
let originalCalls = 0;
const counted = async (...args) => { originalCalls++; return stackBroker(...args); };
await assert.rejects(runCodeGeneration(correction, undefined, counted), error => {
  assert.equal(error.failure?.status, 'failed'); assert.equal(error.failure?.phase, 'generate');
  assert.match(error.failure?.stderr ?? '', /reserved|special-use/); return true;
});
assert.equal(await readFile(correction.workspaceRoot + '/client.ts', 'utf8'), 'old\n');
await assert.rejects(runCodeGeneration(correction, undefined, counted));
assert.equal(originalCalls, 1, 'same failed request is never redispatched');
correction.plan = { ...originalPlan, start: 'export FIRST_SUPERUSER=argus@example.com' };
const corrected = await runCodeGeneration(correction, undefined, counted);
assert.equal(corrected.applied, true); assert.equal(originalCalls, 2);
assert.equal(corrected.sourceSha256, correction.sourceSha256);
assert.equal(await readFile(correction.workspaceRoot + '/schema.txt', 'utf8'), 'query: string\n');
assert.equal(await readFile(correction.workspaceRoot + '/client.ts', 'utf8'), 'export type Query = string;\n');
console.log(JSON.stringify({ passed: true, checks: ['public tool installation', 'offline repository-owned generator', 'no host mounts or credentials',
  'only declared outputs imported', 'Node/Python request hashes match', 'cached success without redispatch', 'changed source rejects cached receipt',
  'setup cannot modify source', 'generator cannot modify inputs', 'binary output blocked', 'nonzero exit no import',
  'ignored output rejected before execution', 'cancel before import', 'lost response no replay', 'late canceled dispatch denied',
  'real email validator failure with no import', 'changed recipe on same source/thread succeeds', 'identical failed request never redispatched'] }));
