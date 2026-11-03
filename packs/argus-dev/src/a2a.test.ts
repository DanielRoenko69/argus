import assert from 'node:assert/strict';
import test from 'node:test';
import {
  A2A_AGENT_CARD_PATH,
  A2A_CONTENT_TYPE,
  A2A_VERSION,
  a2aErrorBody,
  buildArgusDevAgentCard,
  projectCodingWorkflowTask,
  projectWorkflowTask,
} from './a2a.js';

test('Argus Dev publishes an authenticated HTTP+JSON A2A v1 Agent Card', () => {
  const card = buildArgusDevAgentCard('http://argus-dev:2025', true);
  assert.equal(A2A_AGENT_CARD_PATH, '/.well-known/agent-card.json');
  assert.equal(A2A_CONTENT_TYPE, 'application/a2a+json');
  assert.equal(A2A_VERSION, '1.0');
  assert.deepEqual(card['supportedInterfaces'], [{
    url: 'http://argus-dev:2025',
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0',
  }]);
  assert.ok(card['securitySchemes']);
  assert.ok(Array.isArray(card['securityRequirements']));
  assert.deepEqual((card['skills'] as Array<Record<string, unknown>>)[0]?.['id'], 'coding-preflight');
  assert.deepEqual(
    (card['skills'] as Array<Record<string, unknown>>).map(skill => skill['id']),
    ['coding-preflight', 'ticket-to-pull-request', 'ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request', 'pull-request-review', 'ci-failure-recovery', 'security-remediation', 'release-notes', 'backlog-grooming'],
  );
  const prReview = (card['skills'] as Array<Record<string, unknown>>)
    .find(skill => skill['id'] === 'pull-request-review');
  const workflow = prReview?.['x-argus-workflow'] as Record<string, unknown>;
  assert.equal(workflow['graphId'], 'pull_request_review');
  assert.deepEqual(
    (workflow['stages'] as Array<Record<string, unknown>>).map(stage => stage['id']),
    ['inspect_pull_request', 'run_tests', 'review_pull_request', 'human_approval', 'fix_pull_request', 'release_handoff'],
  );
});

test('A2A errors carry the standardized ErrorInfo reason', () => {
  const body = a2aErrorBody(404, 'TASK_NOT_FOUND', 'task not found', 'task-42');
  const error = body['error'] as Record<string, unknown>;
  assert.equal(error['code'], 404);
  const details = error['details'] as Array<Record<string, unknown>>;
  assert.equal(details[0]?.['reason'], 'TASK_NOT_FOUND');
  assert.equal(details[0]?.['domain'], 'a2a-protocol.org');
});

test('an accepted cancellation remains working until the runtime confirms termination', () => {
  const task = { id: 'task', metadata: { resultArtifactId: 'artifact', workflowId: 'backlog-grooming' } };
  const pending = projectWorkflowTask(task, { status: 'canceling', values: {} }, 'backlog-grooming');
  assert.equal(pending.state, 'TASK_STATE_WORKING');
  assert.match(JSON.stringify(pending.task.status), /Cancellation requested/);
  assert.equal((pending.task.metadata as any).runtimeStatus, 'canceling');
  assert.equal(projectWorkflowTask(pending.task, { status: 'canceled', values: {} }, 'backlog-grooming').state, 'TASK_STATE_CANCELED');
});

test('LangGraph state projects to approval-aware A2A tasks without credential state', () => {
  const baseTask = {
    id: '6dbc13b5-bd57-4c2b-b503-24e381b6c8d6',
    contextId: 'c295ea44-7543-4f78-b524-7a38915ad6e4',
    status: { state: 'TASK_STATE_WORKING' },
    metadata: {
      workflowThreadId: '43667960-d455-4453-b0cf-1bae4955270d',
      resultArtifactId: '9b6934dd-37e3-4eb1-8766-962efaab63a1',
    },
  };
  const waiting = projectCodingWorkflowTask(baseTask, {
    status: 'interrupted',
    values: {
      ticket_id: 'ARGUS-42',
      tests_passed: true,
      test_profiles: [{ id: 'node:.', runner: 'node', root: '.', passed: true }],
      review_passed: true,
      review: 'VERDICT: APPROVED',
      revision_history: [{
        attempt: 1,
        retryCount: 0,
        trigger: 'initial',
        triggerFeedback: '',
        startedAt: '2026-08-20T10:00:00.000Z',
        coder: { output: 'changed', traceId: 'coder-trace', recordedAt: '2026-08-20T10:00:00.000Z' },
        tests: { passed: true, output: 'PASS', profiles: [], recordedAt: '2026-08-20T10:01:00.000Z' },
        reviewer: { verdict: 'APPROVE', summary: 'Good', findings: [], requiredChanges: [], output: 'VERDICT: APPROVED', traceId: 'review-trace', recordedAt: '2026-08-20T10:02:00.000Z' },
        humanDecisions: [],
        fileDiffs: [],
      }],
      bitbucket_creds: { token: 'must-never-leave-the-pack' },
    },
  });
  assert.equal(waiting.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal((waiting.task['status'] as Record<string, unknown>)['state'], 'TASK_STATE_INPUT_REQUIRED');
  assert.ok(!JSON.stringify(waiting.task).includes('must-never-leave-the-pack'));
  const waitingArtifacts = waiting.task['artifacts'] as Array<Record<string, unknown>>;
  const waitingParts = waitingArtifacts[0]?.['parts'] as Array<Record<string, unknown>>;
  const waitingData = waitingParts[0]?.['data'] as Record<string, unknown>;
  assert.equal((waitingData['revisionHistory'] as Array<Record<string, unknown>>)[0]?.['attempt'], 1);
  assert.equal(((waitingData['revisionHistory'] as Array<Record<string, unknown>>)[0]?.['coder'] as Record<string, unknown>)['traceId'], 'coder-trace');

  const completed = projectCodingWorkflowTask(waiting.task, {
    status: 'completed',
    values: {
      ticket_id: 'ARGUS-42',
      tests_passed: true,
      test_profiles: [{ id: 'node:.', runner: 'node', root: '.', passed: true }],
      review_passed: true,
      human_approved: true,
      branch_pushed: true,
      pr_approved: true,
      pr_url: 'http://gitea.local/argus/demo/pulls/42',
    },
  });
  assert.equal(completed.state, 'TASK_STATE_COMPLETED');
  const artifacts = completed.task['artifacts'] as Array<Record<string, unknown>>;
  const parts = artifacts[0]?.['parts'] as Array<Record<string, unknown>>;
  const data = parts[0]?.['data'] as Record<string, unknown>;
  assert.equal(data['ticketId'], 'ARGUS-42');
  assert.equal(data['humanApproved'], true);
  assert.equal(data['testsPassed'], true);
  assert.deepEqual(data['testProfiles'], [{ id: 'node:.', runner: 'node', root: '.', passed: true }]);
  assert.equal(data['reviewPassed'], true);
});

test('A2A evidence carries the persisted human change request after a retry', () => {
  const projected = projectCodingWorkflowTask({
    id: '6dbc13b5-bd57-4c2b-b503-24e381b6c8d6',
    status: { state: 'TASK_STATE_WORKING' },
    metadata: { resultArtifactId: '9b6934dd-37e3-4eb1-8766-962efaab63a1' },
  }, {
    status: 'interrupted',
    next: ['human_approval'],
    values: {
      ticket_id: 'ARGUS-CHANGE-42',
      retry_count: 1,
      human_change_request: 'Add a README note and verify it in review.',
      tests_passed: true,
      review_passed: true,
    },
  });
  const artifacts = projected.task['artifacts'] as Array<Record<string, unknown>>;
  const parts = artifacts[0]?.['parts'] as Array<Record<string, unknown>>;
  const data = parts[0]?.['data'] as Record<string, unknown>;
  assert.equal(projected.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(data['humanChangeRequest'], 'Add a README note and verify it in review.');
  assert.equal(data['retryCount'], 1);
});

test('external CI interrupts remain working and expose the provider lifecycle', () => {
  const projected = projectCodingWorkflowTask({
    id: '6dbc13b5-bd57-4c2b-b503-24e381b6c8d6',
    status: { state: 'TASK_STATE_WORKING' },
    metadata: { resultArtifactId: '9b6934dd-37e3-4eb1-8766-962efaab63a1' },
  }, {
    status: 'interrupted',
    interrupts: [{ value: { stage: 'external_ci' } }],
    values: {
      ticket_id: 'ARGUS-CI-42',
      branch_pushed: true,
      delivery_status: 'awaiting_ci',
      ci_run: { provider: 'gitea', status: 'queued', branch: 'feature/ARGUS-CI-42' },
    },
  });
  assert.equal(projected.state, 'TASK_STATE_WORKING');
  const artifacts = projected.task['artifacts'] as Array<Record<string, unknown>>;
  const data = ((artifacts[0]?.['parts'] as Array<Record<string, unknown>>)[0]?.['data']) as Record<string, unknown>;
  assert.equal(data['currentStage'], 'external_ci');
  assert.equal(data['deliveryStatus'], 'awaiting_ci');
});

test('a technically ended workflow is failed when delivery criteria were not satisfied', () => {
  const projected = projectCodingWorkflowTask({
    id: '6dbc13b5-bd57-4c2b-b503-24e381b6c8d6',
    status: { state: 'TASK_STATE_WORKING' },
    metadata: { resultArtifactId: '9b6934dd-37e3-4eb1-8766-962efaab63a1' },
  }, {
    status: 'completed',
    values: {
      ticket_id: 'ARGUS-FAILED-42',
      tests_passed: true,
      review_passed: false,
      retry_count: 4,
    },
  });

  assert.equal(projected.state, 'TASK_STATE_FAILED');
  const status = projected.task['status'] as Record<string, unknown>;
  assert.equal(status['state'], 'TASK_STATE_FAILED');
  const message = status['message'] as Record<string, unknown>;
  assert.match(JSON.stringify(message), /review_passed/);
  const metadata = projected.task['metadata'] as Record<string, unknown>;
  assert.equal(metadata['completionCriteriaSatisfied'], false);
  assert.deepEqual(metadata['completionCriteriaMissing'], [
    'review_passed', 'human_approved', 'branch_pushed', 'pr_approved', 'pr_url',
  ]);
});

test('a PR provider failure never projects a successful delivery', () => {
  const projected = projectCodingWorkflowTask({
    id: '6dbc13b5-bd57-4c2b-b503-24e381b6c8d6',
    status: { state: 'TASK_STATE_WORKING' },
    metadata: { resultArtifactId: '9b6934dd-37e3-4eb1-8766-962efaab63a1' },
  }, {
    status: 'completed',
    values: {
      ticket_id: 'ARGUS-PR-FAIL-42',
      tests_passed: true,
      review_passed: true,
      human_approved: true,
      branch_pushed: true,
      pr_approved: true,
      delivery_status: 'pr_failed',
      pr_url: '',
      delivery_summary: 'Pull request creation failed: Gitea PR API 404',
    },
  });
  assert.equal(projected.state, 'TASK_STATE_FAILED');
  const status = projected.task['status'] as Record<string, unknown>;
  assert.equal(status['state'], 'TASK_STATE_FAILED');
  assert.match(JSON.stringify(status['message']), /pr_url/);
  const artifacts = projected.task['artifacts'] as Array<Record<string, unknown>>;
  const data = ((artifacts[0]?.['parts'] as Array<Record<string, unknown>>)[0]?.['data']) as Record<string, unknown>;
  assert.equal(data['deliveryStatus'], 'pr_failed');
  assert.equal(data['prUrl'], '');
});

test('working A2A tasks expose live, curated workflow evidence', () => {
  const projected = projectCodingWorkflowTask({
    id: '6dbc13b5-bd57-4c2b-b503-24e381b6c8d6',
    status: { state: 'TASK_STATE_WORKING' },
    metadata: { resultArtifactId: '9b6934dd-37e3-4eb1-8766-962efaab63a1' },
  }, {
    status: 'running',
    next: ['tests'],
    values: { ticket_id: 'ARGUS-43', plan: 'Implement the feature safely.' },
  });
  const artifacts = projected.task['artifacts'] as Array<Record<string, unknown>>;
  const parts = artifacts[0]?.['parts'] as Array<Record<string, unknown>>;
  const data = parts[0]?.['data'] as Record<string, unknown>;
  assert.equal(data['ticketId'], 'ARGUS-43');
  assert.equal(data['currentStage'], 'tests');
  assert.equal(data['plan'], 'Implement the feature safely.');
});

test('pull-request workflow projects workflow-neutral run identity and delivery evidence', () => {
  const projected = projectWorkflowTask({
    id: '6dbc13b5-bd57-4c2b-b503-24e381b6c8d6',
    status: { state: 'TASK_STATE_WORKING' },
    metadata: { workflowId: 'pull-request-review', resultArtifactId: '9b6934dd-37e3-4eb1-8766-962efaab63a1' },
  }, {
    status: 'completed',
    values: {
      repository: 'argus/core', pull_request_number: 42,
      review_goal: 'Validate release readiness.',
      tests_passed: true, review_passed: true,
      human_approved: true, pr_approved: true,
      delivery_summary: 'Approved release handoff for argus/core PR #42.',
    },
  }, 'pull-request-review');
  const artifacts = projected.task['artifacts'] as Array<Record<string, unknown>>;
  const parts = artifacts[0]?.['parts'] as Array<Record<string, unknown>>;
  const data = parts[0]?.['data'] as Record<string, unknown>;
  assert.equal(projected.state, 'TASK_STATE_COMPLETED');
  assert.equal(data['workflowId'], 'pull-request-review');
  assert.equal(data['workflowLabel'], 'Pull request review');
  assert.equal(data['runTitle'], 'PR #42');
  assert.equal(data['repository'], 'argus/core');
  assert.equal(data['pullRequestNumber'], 42);
  assert.equal(data['deliverySummary'], 'Approved release handoff for argus/core PR #42.');
});
