import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StateGraph, MemorySaver, START, END, Command } from '@langchain/langgraph';
import { WorkflowState } from './state.js';
import { humanApprovalNode, humanApprovalPrNode } from './workflows/approvals.js';
import { assertGitDeliveryApproval } from './devGit.js';

// Real approval nodes and checkpoint/resume semantics. No provider/model calls;
// Core signature/owner/current-access checks are covered by its HTTP suite.
function fixture() {
  const delivered: string[] = [];
  const graph = new StateGraph(WorkflowState)
    .addNode('human_approval', humanApprovalNode)
    .addNode('push_fixture', state => {
      assertGitDeliveryApproval(state);
      delivered.push(`push:${state.argus_execution_grant}`);
      return { branch_pushed: true, delivery_status: 'ci_passed' as const,
        ci_run: { provider: 'jenkins' as const, status: 'success' as const,
          branch: state.branch_name, commit_sha: state.commit_sha, external_id: 'fixture',
          workflow: 'fixture', conclusion: 'success', run_url: 'http://fixture.invalid/build/1', updated_at: new Date().toISOString() } };
    })
    .addNode('human_approval_pr', humanApprovalPrNode)
    .addNode('pr_fixture', state => {
      assertGitDeliveryApproval(state, true);
      delivered.push(`pr:${state.argus_execution_grant}`);
      return {};
    })
    .addEdge(START, 'human_approval')
    .addConditionalEdges('human_approval', state => state.human_approved ? 'push_fixture' : END)
    .addEdge('push_fixture', 'human_approval_pr')
    .addConditionalEdges('human_approval_pr', state => state.pr_approved ? 'pr_fixture' : END)
    .addEdge('pr_fixture', END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: randomUUID() } };
  const input = { ticket_id: 'SSO-FIXTURE', tests_passed: true, review_passed: true,
    branch_name: 'feature/SSO-FIXTURE', commit_sha: 'a'.repeat(40), argus_execution_grant: 'expired-original',
    bitbucket_creds: { kind: 'gitea' as const, base_url: 'http://fixture.invalid', project_key: 'fixture',
      user_slug: '', repo_slug: 'repo', target_branch: 'main', token: null,
      reference: { version: 1 as const, bundleId: 50, backendId: 5, binding: 'b'.repeat(64) } } };
  return { graph, config, input, delivered };
}

test('real approval interrupts retain both human gates and persist each fresh grant only on resume', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const { graph, config, input, delivered } = fixture();
  await graph.invoke(input, config);
  assert.deepEqual((await graph.getState(config)).next, ['human_approval']);
  assert.deepEqual(delivered, []);
  await graph.invoke(new Command({ resume: { approved: true } }), {
    configurable: { ...config.configurable, approvalGrant: 'fresh-code-grant' },
  });
  const paused = await graph.getState(config);
  assert.deepEqual(paused.next, ['human_approval_pr']);
  assert.equal(paused.values.argus_execution_grant, 'fresh-code-grant');
  assert.equal(paused.values.pr_approved, false);
  assert.deepEqual(delivered, ['push:fresh-code-grant']);
  await graph.invoke(new Command({ resume: { approved: true } }), {
    configurable: { ...config.configurable, approvalGrant: 'fresh-pr-grant' },
  });
  assert.deepEqual((await graph.getState(config)).next, []);
  assert.equal((await graph.getState(config)).values.argus_execution_grant, 'fresh-pr-grant');
  assert.deepEqual(delivered, ['push:fresh-code-grant', 'pr:fresh-pr-grant']);
});

test('bare resume cannot deliver a broker run; a renewed rejection never pushes', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const bare = fixture();
  await bare.graph.invoke(bare.input, bare.config);
  const beforeFailure = await bare.graph.getState(bare.config);
  await assert.rejects(bare.graph.invoke(new Command({ resume: { approved: true } }), bare.config), /approval renewal is required/);
  assert.deepEqual(bare.delivered, []);
  const stillPaused = await bare.graph.getState(bare.config);
  assert.equal(stillPaused.config.configurable?.checkpoint_id, beforeFailure.config.configurable?.checkpoint_id);
  assert.equal(stillPaused.tasks.some(task => task.interrupts.length > 0), true);
  await bare.graph.invoke(new Command({ resume: { approved: true } }), {
    configurable: { ...bare.config.configurable, approvalGrant: 'recovered-code-grant' },
  });
  assert.deepEqual(bare.delivered, ['push:recovered-code-grant']);
  assert.deepEqual((await bare.graph.getState(bare.config)).next, ['human_approval_pr']);
  const rejected = fixture();
  await rejected.graph.invoke(rejected.input, rejected.config);
  await rejected.graph.invoke(new Command({ resume: { approved: false, feedback: 'Needs another review' } }), {
    configurable: { ...rejected.config.configurable, approvalGrant: 'fresh-rejection-grant' },
  });
  assert.equal((await rejected.graph.getState(rejected.config)).values.human_approved, false);
  assert.deepEqual(rejected.delivered, []);
});

test('functional approval recovery does not repeat the completed push or create two PRs', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const { graph, config, input, delivered } = fixture();
  await graph.invoke(input, config);
  await graph.invoke(new Command({ resume: { approved: true } }), {
    configurable: { ...config.configurable, approvalGrant: 'original-code-grant' },
  });
  const before = await graph.getState(config);
  assert.deepEqual(before.next, ['human_approval_pr']);
  assert.deepEqual(delivered, ['push:original-code-grant']);
  await assert.rejects(graph.invoke(new Command({ resume: { approved: true } }), config), /approval renewal is required/);
  const failed = await graph.getState(config);
  assert.equal(failed.config.configurable?.checkpoint_id, before.config.configurable?.checkpoint_id);
  assert.equal(failed.tasks.some(task => task.name === 'human_approval_pr' && task.interrupts.length > 0 && task.error), true);
  assert.deepEqual(delivered, ['push:original-code-grant']);
  await graph.invoke(new Command({ resume: { approved: true } }), {
    configurable: { ...config.configurable, approvalGrant: 'recovered-functional-grant' },
  });
  assert.deepEqual(delivered, ['push:original-code-grant', 'pr:recovered-functional-grant']);
  assert.deepEqual((await graph.getState(config)).next, []);
});
