import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODING_MAX_REVISIONS,
  evaluateWorkflowCompletion,
  getWorkflowDefinition,
  validateWorkflowInput,
} from './workflowCatalog.js';

test('coding workflows require a concrete repository checkout source', () => {
  const workflow = getWorkflowDefinition('ticket-to-pull-request');
  assert.ok(workflow);
  assert.equal(workflow.revisionPolicy?.maxRevisions, CODING_MAX_REVISIONS);
  assert.deepEqual(
    workflow.requiredBundleCategories,
    ['repository', 'repository-checkout', 'ci'],
  );
  const input = validateWorkflowInput(workflow, {
    ticket_id: 'ARGUS-SHOWCASE-123',
    description: 'Implement the bounded showcase change.',
    ci_provider: 'jenkins',
  });
  assert.equal(input.ci_provider, 'jenkins');
});
test('image-only ticket workflow is separate and never asserts passing tests', () => {
  const workflow = getWorkflowDefinition('ticket-to-image-pull-request')!;
  assert.equal(workflow.graphId, 'coding_image_workflow');
  assert.deepEqual(workflow.approvalGates, ['code_approval', 'functional_approval']);
  assert.ok(!workflow.stages.some(stage => ['tests', 'test_design', 'qa_execute'].includes(stage.id)));
  assert.ok(!workflow.completionCriteria.trueFields.includes('tests_passed'));
  assert.equal(validateWorkflowInput(workflow, { ticket_id: 'DEMO-1', issue_reference: '7', description: 'Small fix', ci_job: 'demo-image' }).ci_provider, 'jenkins');
  assert.throws(() => validateWorkflowInput(workflow, { ticket_id: 'DEMO-1', description: 'Small fix', ci_job: 'demo-image' }));
  assert.throws(() => validateWorkflowInput(workflow, { ticket_id: 'DEMO-1', issue_reference: '7', description: 'Small fix', ci_job: 'demo-image', ci_provider: 'gitea' }));
  assert.equal(evaluateWorkflowCompletion(workflow, {
    review_passed: true, human_approved: true, branch_pushed: true, pr_approved: true, pr_url: 'http://gitea/pulls/1', tests_passed: false,
  }).successful, true);
});
test('follow-up workflow requires the source run and fresh issue without claiming tests', () => {
  const workflow = getWorkflowDefinition('ticket-follow-up-image-pull-request')!;
  assert.equal(workflow.graphId, 'coding_follow_up_image_workflow');
  assert.ok(workflow.inputSchema.some(field => field.name === 'source_thread_id' && field.required));
  assert.ok(workflow.inputSchema.some(field => field.name === 'issue_reference' && field.required));
  assert.ok(!workflow.completionCriteria.trueFields.includes('tests_passed'));
  const input = validateWorkflowInput(workflow, {
    source_thread_id: '11111111-1111-4111-8111-111111111111', ticket_id: 'DEMO-2',
    issue_reference: '8', description: 'Extend the existing PR.',
  });
  assert.equal(input.ci_provider, 'jenkins');
  assert.throws(() => validateWorkflowInput(workflow, {
    ticket_id: 'DEMO-2', issue_reference: '8', description: 'Missing source run.',
  }));
});
test('independent QA completion is additive and cannot declare success without passing execution', () => {
  const workflow = getWorkflowDefinition('ticket-to-pull-request')!;
  const values: Record<string, unknown> = Object.fromEntries([
    ...workflow.completionCriteria.trueFields.map(f => [f, true]),
    ...workflow.completionCriteria.nonEmptyFields.map(f => [f, 'fixture']),
  ]);
  assert.equal(evaluateWorkflowCompletion(workflow, values).successful, true);
  values.qa_acceptance_policy_version = 1;
  for (const receipt of [null, { passed: true }, { passed: true, status: 'completed', exitCode: 0, collected: 0 }]) {
    values.qa_receipt = receipt;
    assert.ok(evaluateWorkflowCompletion(workflow, values).missing.includes('qa_acceptance_passed'));
  }
  values.qa_receipt = { passed: true, status: 'completed', exitCode: 0, collected: 1 };
  assert.equal(evaluateWorkflowCompletion(workflow, values).successful, true);
});

test('CI failure recovery is discoverable with provider-neutral inputs and completion evidence', () => {
  const workflow = getWorkflowDefinition('ci-failure-recovery');
  assert.ok(workflow);
  assert.equal(workflow.graphId, 'ci_failure_recovery');
  assert.deepEqual(workflow.approvalGates, ['ci_recovery_approval']);
  assert.ok(workflow.stages.some(stage => stage.id === 'external_ci_retry'));

  const input = validateWorkflowInput(workflow, {
    ticket_id: 'ARGUS-CI-123',
    repository: 'argus/argus-dev-sample',
    branch_name: 'feature/ARGUS-CI-123',
    commit_sha: 'abcdef123456',
    ci_provider: 'gitea',
    ci_workflow: 'default',
    ci_run_url: 'http://127.0.0.1:3005/argus/argus-dev-sample/actions/runs/22',
    ci_failure_context: 'job test failed with an assertion',
  });
  assert.equal(input.ci_provider, 'gitea');

  const complete = evaluateWorkflowCompletion(workflow, {
    tests_passed: true,
    fix_applied: true,
    human_approved: true,
    branch_pushed: true,
    ci_recovery_completed: true,
    delivery_summary: 'Recovery passed.',
  });
  assert.equal(complete.successful, true);
  assert.deepEqual(complete.missing, []);
});

test('security remediation requires triage, verification and two approval gates', () => {
  const workflow = getWorkflowDefinition('security-remediation');
  assert.ok(workflow);
  assert.equal(workflow.graphId, 'security_remediation');
  assert.deepEqual(workflow.approvalGates, ['security_fix_approval', 'security_pr_approval']);
  const input = validateWorkflowInput(workflow, {
    ticket_id: 'ARGUS-SEC-123',
    repository: 'argus/argus-dev-sample',
    source_branch: 'main',
    security_finding_id: 'CVE-2026-12345',
    security_tool: 'OSV',
    security_severity: 'high',
    security_package: 'example-package',
    security_current_version: '1.2.3',
    security_finding_context: 'The scanner reported a vulnerable transitive dependency.',
  });
  assert.equal(input.security_severity, 'high');
  const complete = evaluateWorkflowCompletion(workflow, {
    tests_passed: true,
    security_passed: true,
    human_approved: true,
    branch_pushed: true,
    pr_approved: true,
    pr_url: 'http://gitea.local/pulls/1',
  });
  assert.equal(complete.successful, true);
});

test('release notes workflow has a bounded review loop and handoff criteria', () => {
  const workflow = getWorkflowDefinition('release-notes');
  assert.ok(workflow);
  assert.equal(workflow.graphId, 'release_notes');
  assert.deepEqual(workflow.approvalGates, ['release_approval']);
  const input = validateWorkflowInput(workflow, {
    release_id: 'ARGUS-REL-123',
    repository: 'argus/argus-dev-sample',
    source_branch: 'main',
    release_version: 'v1.4.0',
    release_scope: 'PR #10 and commits since v1.3.0',
    release_goal: 'Prepare public release notes with breaking changes called out.',
  });
  assert.equal(input.release_version, 'v1.4.0');
  const complete = evaluateWorkflowCompletion(workflow, {
    review_passed: true,
    human_approved: true,
    release_completed: true,
    release_notes: '# v1.4.0',
    delivery_summary: 'Handoff ready.',
  });
  assert.equal(complete.successful, true);
});

test('Backlog Planning preserves its workflow identity and produces an approved task plan', () => {
  const workflow = getWorkflowDefinition('backlog-grooming');
  assert.ok(workflow);
  assert.equal(workflow.graphId, 'backlog_grooming');
  assert.equal(workflow.label, 'Backlog Planning');
  assert.deepEqual(workflow.reviewPolicy, { maxAttempts: 2 });
  assert.deepEqual(workflow.requiredAgents, ['researcher', 'planner', 'reviewer']);
  const input = validateWorkflowInput(workflow, {
    backlog_id: 'ARGUS-EPIC-123',
    repository: 'argus/argus-dev-sample',
    source_branch: 'main',
    issue_title: 'Introduce tenant-aware audit retention',
    issue_body: 'Design the feature and split it into implementation-ready tasks.',
    backlog_audience: 'Engineering team',
  });
  assert.equal(input.backlog_id, 'ARGUS-EPIC-123');
  const complete = evaluateWorkflowCompletion(workflow, {
    review_passed: true,
    human_approved: true,
    backlog_completed: true,
    backlog_tasks: '1. Add storage model',
    delivery_summary: 'Handoff ready.',
  });
  assert.equal(complete.successful, true);
});
