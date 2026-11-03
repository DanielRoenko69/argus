import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchJenkins as gatedDispatch, jenkinsCallbackMatches, makeJenkinsIntent, readJenkinsConfig, type DispatchReceipt } from './jenkinsDispatch.js';
import type { CiRun } from './state.js';

// Provider tests explicitly supply a successful policy gate. Production must
// supply Core authorization; omitting the gate fails closed (tested below).
const dispatchJenkins = (...args: Parameters<typeof gatedDispatch>) =>
  gatedDispatch(args[0], args[1], args[2], args[3], args[4] ?? (async () => {}));

const env = {
  ARGUS_JENKINS_DISPATCH_TARGETS: JSON.stringify([{ repository: 'demo/work', gitOrigin: 'http://gitea:3000', branchPrefix: 'feature/GEM-', job: 'gem-dev' }]),
  ARGUS_JENKINS_API_ORIGIN: 'http://jenkins:8080', ARGUS_JENKINS_PUBLIC_ORIGIN: 'http://localhost:8081',
  ARGUS_JENKINS_DISPATCH_USER: 'service', ARGUS_JENKINS_DISPATCH_TOKEN: 'fixture-secret',
};
const config = readJenkinsConfig(env)!;
const base = 'a'.repeat(40), commit = 'b'.repeat(40);
const values = () => ({
  bitbucket_creds: { kind: 'gitea', base_url: 'http://gitea:3000', project_key: 'demo', user_slug: 'service-user', repo_slug: 'work' },
  human_approved: true, branch_pushed: true, tests_passed: true, review_passed: true, ci_provider: 'jenkins',
  branch_name: 'feature/GEM-4', commit_sha: commit, pr_approved: false, pr_url: '',
  ci_run: { provider: 'jenkins', status: 'queued', branch: 'feature/GEM-4', commit_sha: commit },
});
const intent = makeJenkinsIntent(config, values(), base)!;
const params = { REPOSITORY: 'demo/work', BRANCH_NAME: 'feature/GEM-4', COMMIT_SHA: commit, BASE_SHA: base };
const actions = [{ parameters: Object.entries(params).map(([name, value]) => ({ name, value })) }];
function store() {
  let record: DispatchReceipt | undefined;
  return {
    record: () => record,
    claim: async (receipt: DispatchReceipt) => { if (record) return false; record = receipt; return true; },
    save: async (receipt: DispatchReceipt) => { record = receipt; },
  };
}
function provider(options: { builds?: object[]; queue?: object[]; status?: number; location?: string; error?: boolean } = {}) {
  const writes: RequestInit[] = [];
  const fetcher = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    if (init.method === 'POST') {
      writes.push(init);
      if (options.error) throw new Error('secret body must not escape');
      return new Response(null, { status: options.status ?? 201, headers: { location: options.location ?? 'http://localhost:8081/queue/item/2/' } });
    }
    return Response.json(String(_url).includes('/queue/') ? { items: options.queue ?? [] } : { buildable: true, builds: options.builds ?? [] });
  }) as typeof fetch;
  return { fetcher, writes };
}

test('dispatch is opt-in and rejects ambiguous or unsafe configuration', () => {
  assert.equal(readJenkinsConfig({}), null);
  for (const override of [
    { ARGUS_JENKINS_API_ORIGIN: 'http://user:secret@jenkins' }, { ARGUS_JENKINS_PUBLIC_ORIGIN: 'https://host/path' },
    { ARGUS_JENKINS_DISPATCH_TOKEN: '' }, { ARGUS_JENKINS_DISPATCH_TARGETS: '{}' },
    { ARGUS_JENKINS_DISPATCH_TARGETS: JSON.stringify([...config.targets, ...config.targets]) },
  ]) assert.throws(() => readJenkinsConfig({ ...env, ...override }));
});

test('multiple jobs on one repository require explicit selection and retain callback isolation', () => {
  const multiple = { ...config, targets: [...config.targets, { ...config.targets[0]!, job: 'gem-source-dev' }] };
  assert.equal(makeJenkinsIntent(multiple, values(), base), null);
  const selected = { ...values(), ci_job: 'gem-source-dev' };
  assert.equal(makeJenkinsIntent(multiple, selected, base)?.job, 'gem-source-dev');
  assert.equal(makeJenkinsIntent(multiple, { ...selected, ci_job: 'unbound' }, base), null);
  const incoming = { provider: 'jenkins', workflow: 'gem-dev', external_id: '1', commit_sha: commit, branch: 'feature/GEM-4' } as CiRun;
  assert.equal(jenkinsCallbackMatches(multiple, selected, incoming), false);
  assert.equal(jenkinsCallbackMatches(multiple, selected, { ...incoming, workflow: 'gem-source-dev' }), true);
});
test('requires approved tested reviewed pushed exact source and binding', () => {
  assert.ok(intent);
  for (const key of ['human_approved', 'branch_pushed', 'tests_passed', 'review_passed']) assert.equal(makeJenkinsIntent(config, { ...values(), [key]: false }, base), null);
  for (const override of [{ pr_approved: true }, { pr_url: 'existing' }, { ci_provider: 'github' }, { branch_name: 'main' }, { commit_sha: 'abc' }]) {
    assert.equal(makeJenkinsIntent(config, { ...values(), ...override }, base), null);
  }
  assert.equal(makeJenkinsIntent(config, values(), commit), null);
  for (const override of [{ base_url: 'http://untrusted:3000' }, { project_key: 'other' }, { kind: 'github' }]) {
    assert.equal(makeJenkinsIntent(config, { ...values(), bitbucket_creds: { ...values().bitbucket_creds, ...override } }, base), null);
  }
  for (const override of [{ status: 'success' }, { status: 'failure' }, { branch: 'different' }, { commit_sha: base }]) {
    assert.equal(makeJenkinsIntent(config, { ...values(), ci_run: { ...values().ci_run, ...override } }, base), null);
  }
});
test('review-only dispatch remains confined to the selected workflow and exact job', () => {
  const imageConfig = { ...config, targets: [...config.targets, { ...config.targets[0]!, job: 'gem-image' }] };
  const image = { ...values(), delivery_mode: 'ticket-to-image-pull-request', tests_passed: false, ci_job: 'gem-image',
    ci_run: { ...values().ci_run, workflow: 'gem-image' } };
  assert.equal(makeJenkinsIntent(imageConfig, image, base)?.job, 'gem-image');
  assert.equal(makeJenkinsIntent(imageConfig, { ...image, delivery_mode: '' }, base), null);
  assert.equal(makeJenkinsIntent(imageConfig, { ...image, human_approved: false }, base), null);
  assert.equal(makeJenkinsIntent(imageConfig, { ...image, review_passed: false }, base), null);
  assert.equal(makeJenkinsIntent(imageConfig, { ...image, ci_job: '' }, base), null);
});
test('durable claim precedes POST and records real queue receipt; retry never duplicates', async () => {
  const storage = store(); const server = provider();
  const fetcher = (async (url, init) => {
    if (init?.method === 'POST') assert.equal(storage.record()?.state, 'intent');
    return server.fetcher(url, init);
  }) as typeof fetch;
  const result = await dispatchJenkins(config, intent, storage, fetcher);
  assert.equal(result.status, 'queued'); assert.equal(result.workflow, 'gem-dev'); assert.equal(result.run_url, 'http://localhost:8081/job/gem-dev/');
  assert.equal(storage.record()?.queueId, 2); assert.equal(storage.record()?.state, 'accepted');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(server.writes[0].body))), params);
  const repeated = await dispatchJenkins(config, intent, storage, fetcher);
  assert.equal(server.writes.length, 1); assert.equal(repeated.status, 'unknown');
});
test('network ambiguity, redirects, wrong origins, and missing queue receipts never auto-retry', async () => {
  for (const options of [{ error: true }, { status: 302 }, { status: 403 }, { location: 'https://untrusted/queue/item/2/' }, { location: '/' }]) {
    const storage = store(); const server = provider(options);
    const result = await dispatchJenkins(config, intent, storage, server.fetcher);
    assert.equal(result.conclusion, 'dispatch_uncertain_operator_review');
    assert.equal(storage.record()?.state, 'uncertain');
    await dispatchJenkins(config, intent, storage, server.fetcher);
    assert.equal(server.writes.length, 1);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});
test('provider queue/build observations reconcile without a second POST or fabricated success', async () => {
  for (const options of [
    { queue: [{ id: 7, task: { name: 'gem-dev' }, actions }] },
    { builds: [{ number: 3, building: true, actions }] },
    { builds: [{ number: 3, building: false, result: 'SUCCESS', actions }] },
  ]) {
    const storage = store(); const server = provider(options);
    const result = await dispatchJenkins(config, intent, storage, server.fetcher);
    assert.equal(server.writes.length, 0); assert.equal(storage.record()?.state, 'accepted');
    assert.notEqual(result.status, 'success');
  }
});
test('authenticated Jenkins reads fail closed without a callback, but never certify success', async () => {
  for (const [result, expected] of [['FAILURE', 'failure'], ['UNSTABLE', 'failure'],
    ['NOT_BUILT', 'failure'], ['ABORTED', 'canceled'], ['SUCCESS', 'unknown']] as const) {
    const storage = store();
    const server = provider({ builds: [{ number: 3, building: false, result, actions }] });
    const receipt = await dispatchJenkins(config, intent, storage, server.fetcher);
    assert.equal(receipt.status, expected);
    assert.equal(receipt.external_id, '3');
    assert.equal(server.writes.length, 0);
    assert.equal(storage.record()?.state, 'accepted');
    assert.equal(receipt.conclusion, result === 'SUCCESS' ? 'awaiting_provider_callback' : `provider_api_reconciled: ${result}`);
  }
});
test('same commit on another repo or branch is not accepted as this build', async () => {
  const server = provider({ builds: [{ number: 9, building: true, actions: [{ parameters: [{ name: 'COMMIT_SHA', value: commit }] }] }] });
  await dispatchJenkins(config, intent, store(), server.fetcher);
  assert.equal(server.writes.length, 1);
});
test('concurrent claimants produce at most one provider POST', async () => {
  const storage = store(); const server = provider();
  await Promise.all([dispatchJenkins(config, intent, storage, server.fetcher), dispatchJenkins(config, intent, storage, server.fetcher)]);
  assert.equal(server.writes.length, 1);
});

test('callback must match the configured job, approved source and observed build', () => {
  const incoming: CiRun = { provider: 'jenkins', external_id: '1', workflow: 'gem-dev', status: 'success', conclusion: 'SUCCESS',
    branch: intent.branch, commit_sha: commit, run_url: 'http://localhost:8081/job/gem-dev/1/', updated_at: new Date().toISOString() };
  assert.equal(jenkinsCallbackMatches(config, values(), incoming), true);
  for (const override of [{ provider: 'gitea' }, { workflow: 'other-job' }, { branch: 'other' }, { commit_sha: base }, { external_id: '' }]) {
    assert.equal(jenkinsCallbackMatches(config, values(), { ...incoming, ...override } as CiRun), false);
  }
  assert.equal(jenkinsCallbackMatches(config, { ...values(), ci_run: { ...values().ci_run, external_id: '2' } }, incoming), false);
});

test('missing authorization makes zero provider calls and creates no write intent', async () => {
  const storage = store(); let calls = 0;
  await assert.rejects(gatedDispatch(config, intent, storage, async () => { calls++; return Response.json({}); }), /authorization is required/);
  assert.equal(calls, 0); assert.equal(storage.record(), undefined);
});

test('revocation is checked before every provider request including before claiming a POST', async () => {
  for (const denyAt of [1, 2, 3]) {
    const storage = store(); const server = provider(); let checks = 0; let calls = 0;
    const fetcher: typeof fetch = async (...args) => { calls++; return server.fetcher(...args); };
    await assert.rejects(gatedDispatch(config, intent, storage, fetcher, async () => {
      if (++checks === denyAt) throw new Error('revoked');
    }), /revoked/);
    assert.equal(calls, denyAt - 1); assert.equal(server.writes.length, 0); assert.equal(storage.record(), undefined);
  }
});
