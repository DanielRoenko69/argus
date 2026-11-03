import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { experimentProposal, experimentEvidence, experimentBasis, experimentContext, executeTechnicalExperiment, validateExperimentReceipt,
  type ExperimentState, type TechnicalExperimentReceipt } from './technicalExperiment.js';
import { technicalFindingRecords } from './technicalDesign.js';
import { qaResponseBasis } from './qaResponseRecovery.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const state: ExperimentState = { technical_design_policy_version: 1, technical_experiment_policy_version: 1,
    technical_investigation_count: 1, technical_investigation_pending: true, workflow_blockers: ['Need observation'],
    workspace_dir: '/workspace/FIXTURE', argus_workspace_root: '/workspace/FIXTURE', base_commit_sha: 'a'.repeat(40),
    description: 'Fixture', argus_bundle_ids: [7], argus_execution_grant: 'synthetic-private',
    technical_open_findings: technicalFindingRecords([{ kind: 'design', source: 'proposal', summary: 'Need evidence', evidence: ['src/reference.py'] }]) };
  const proposal = { purpose: 'Reference calibration', hypothesis: 'Convergence', protocol: 'Fixed input 1', interpretation: 'Only this fixture',
    findingIds: [state.technical_open_findings![0]!.id], script: 'print(42)' };
  const request = experimentProposal(state, JSON.stringify({ experiment: proposal }), randomUUID())!;
  state.technical_experiment_request = request; state.technical_experiment_count = 1;
  const threadId = randomUUID();
  const receipt: TechnicalExperimentReceipt = { version: 1, threadId, baseCommitSha: state.base_commit_sha!,
    basisSha256: request.basisSha256, requestSha256: request.requestSha256, scriptSha256: request.scriptSha256,
    snapshotSha256: 'b'.repeat(64), profile: 'python-bwrap-v1', status: 'completed', exitCode: 0,
    stdout: '42\n', stderr: '', outputSha256: hash(JSON.stringify(['42\n', ''])), startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), durationMs: 1, files: 1, excludedFiles: 0, pythonVersion: '3.12.14',
    limits: { wallMs: 30000, cpuSeconds: 20, memoryBytes: 536870912, outputBytes: 32768, scriptBytes: 24000, snapshotBytes: 67108864, snapshotFiles: 3000 } };
  return { state, proposal, threadId, receipt };
}
test('experiment proposals require one reserved investigation, provenance and exact unresolved finding IDs', () => {
  const { state, proposal } = fixture();
  const eligible = { ...state, technical_experiment_request: null, technical_experiment_count: 0 };
  for (const change of [{ technical_experiment_policy_version: 0 }, { technical_investigation_count: 0 },
    { technical_investigation_pending: false }, { technical_experiment_count: 1 }]) {
    assert.throws(() => experimentProposal({ ...eligible, ...change }, JSON.stringify({ experiment: proposal }), randomUUID()));
  }
  assert.throws(() => experimentProposal(eligible, JSON.stringify({ experiment: proposal }), undefined));
  for (const change of [{ findingIds: ['f_' + '0'.repeat(24)] }, { script: 'é'.repeat(13000) }, { cwd: '/other' }]) {
    assert.throws(() => experimentProposal(eligible, JSON.stringify({ experiment: { ...proposal, ...change } }), randomUUID()));
  }
  assert.equal(experimentProposal(eligible, '{"outcome":{}}', undefined), null);
  assert.throws(() => experimentProposal(state, JSON.stringify({ experiment: proposal }), randomUUID()));
});
test('frozen evidence rejects changed source, scope, script, identity, output and fake success', () => {
  const { state, receipt, threadId } = fixture();
  assert.deepEqual(validateExperimentReceipt(state, threadId, receipt), receipt);
  for (const change of [{ threadId: randomUUID() }, { baseCommitSha: 'b'.repeat(40) }, { stdout: '43' },
    { scriptSha256: 'c'.repeat(64) }, { exitCode: 1 }, { profile: 'unisolated' }]) {
    assert.throws(() => validateExperimentReceipt(state, threadId, { ...receipt, ...change }));
  }
  for (const change of [{ description: 'different' }, { allowed_files: 'src/' }, { argus_bundle_ids: [8] }, { context: 'different' }]) {
    assert.notEqual(experimentBasis({ ...state, ...change }), receipt.basisSha256);
    assert.throws(() => validateExperimentReceipt({ ...state, ...change }, threadId, receipt));
  }
  const modified = structuredClone(state); modified.technical_experiment_request!.script = 'print(43)';
  assert.equal(experimentEvidence(modified), null);
  assert.ok(!JSON.stringify(experimentEvidence(state)).includes('synthetic-private'));
});
test('execution makes one grant-bound request; only completed evidence proceeds, never retries unknown outcomes', async () => {
  const { state, receipt, threadId } = fixture(); let calls = 0;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    calls++; assert.equal((init.headers as Record<string,string>).authorization, 'Bearer synthetic-private');
    assert.equal(JSON.parse(String(init.body)).workspaceRoot, undefined);
    return Response.json(receipt);
  }) as typeof fetch;
  const done = await executeTechnicalExperiment(state, threadId, 1, fetchFn);
  assert.ok('technical_experiment_result' in done);
  assert.equal(done.technical_experiment_result?.status, 'completed'); assert.equal(calls, 1);
  assert.ok(!Object.hasOwn(done, 'human_approved')); assert.ok(!Object.hasOwn(done, 'pr_approved'));
  const output = experimentContext({ ...state, technical_experiment_result: receipt });
  assert.match(output, /untrusted observations/); assert.match(output, /print\(42\)/);
  assert.match(output, /Independently inspect/);
  const stopped = await executeTechnicalExperiment(state, threadId, 1, (async () => { calls++; throw new Error('lost'); }) as typeof fetch);
  assert.match(stopped.workflow_blockers![0]!, /attempt remains consumed/); assert.equal(calls, 2);
  const failed = await executeTechnicalExperiment(state, threadId, 1, (async () => Response.json({ ...receipt, status: 'timeout', exitCode: null })) as typeof fetch);
  assert.ok('technical_experiment_result' in failed);
  assert.equal(failed.technical_experiment_result?.status, 'timeout'); assert.ok(failed.workflow_blockers?.length);
  const never = (async () => { throw new Error('should not call'); }) as typeof fetch;
  for (const change of [{ technical_experiment_count: 0 }, { technical_experiment_result: receipt }, { argus_workspace_root: '/other' }]) {
    const denied = await executeTechnicalExperiment({ ...state, ...change }, threadId, 1, never);
    assert.match(denied.workflow_blockers![0]!, /Nothing was executed/);
  }
});
test('default experiment annotations preserve historical QA receipt hashes; enabled evidence is bound', () => {
  const legacy = { plan: 'old' };
  assert.equal(qaResponseBasis(legacy), qaResponseBasis({ ...legacy, technical_experiment_policy_version: 0,
    technical_experiment_count: 0, technical_experiment_request: null, technical_experiment_result: null }));
  assert.notEqual(qaResponseBasis(legacy), qaResponseBasis({ ...legacy, technical_experiment_policy_version: 1 }));
});
test('new snapshot bounds and preparation receipts remain strictly source-bound; no execution or budget reset', async () => {
  const { state, receipt, threadId } = fixture();
  const limits = { ...receipt.limits, snapshotFileBytes: 16 * 1048576, snapshotBytes: 128 * 1048576 };
  assert.equal(validateExperimentReceipt(state, threadId, { ...receipt, limits }).status, 'completed');
  const preparation = { version: 1, threadId, baseCommitSha: receipt.baseCommitSha, basisSha256: receipt.basisSha256,
    requestSha256: receipt.requestSha256, scriptSha256: receipt.scriptSha256, status: 'preparation_failed',
    executionStarted: false, reason: 'snapshot_file_size_limit', actual: 17 * 1048576, limit: 16 * 1048576, filePath: 'docs/banner.jpg', limits };
  assert.equal(validateExperimentReceipt(state, threadId, preparation).status, 'preparation_failed');
  for (const change of [{ executionStarted: true }, { threadId: randomUUID() }, { actual: 2 }, { limit: 2 },
    { filePath: '../secret' }, { filePath: 'bad\nfile' }, { filePath: 'bad\\file' }, { filePath: undefined },
    { stdout: 'fake success' }, { reason: 'arbitrary backend message' },
    { limits: { ...limits, snapshotBytes: 257 * 1048576 } }, { limits: { ...limits, snapshotFileBytes: 33 * 1048576 } }]) {
    assert.throws(() => validateExperimentReceipt(state, threadId, { ...preparation, ...change }));
  }
  let calls = 0;
  const update = await executeTechnicalExperiment(state, threadId, 1, (async () => { calls++; return Response.json(preparation); }) as typeof fetch);
  assert.equal(calls, 1); assert.ok('technical_experiment_result' in update);
  assert.equal(update.technical_experiment_result?.status, 'preparation_failed');
  assert.match(update.workflow_blockers![0]!, /17.00 MiB.*16.00 MiB/);
  assert.match(update.workflow_blockers![0]!, /Python script did not start/);
  assert.ok(!Object.hasOwn(update, 'technical_experiment_count')); assert.ok(!Object.hasOwn(update, 'human_approved'));
});
