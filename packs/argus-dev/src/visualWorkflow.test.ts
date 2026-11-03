import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateVisualCondition,
  parseVisualWorkflowSpec,
  resolveVisualRouteValue,
  visualReviewPassed,
  visualResponseFallback,
  visualRoutingSkipReason,
  visualSelectedTarget,
  visualWorkerTaskType,
  visualWorkflowCatalogEntry,
} from './visualWorkflow.js';

const spec = {
  schemaVersion: 'argus.workflow/v1',
  id: 'visual-9-governed-delivery',
  graphId: 'visual_workflow_9',
  source: { system: 'argus.core', workflowId: 9, updatedAt: '2026-08-20T10:00:00.000Z' },
  revision: 1,
  name: 'governed_delivery',
  label: 'Governed Delivery',
  description: 'Plan and approve.',
  inputSchema: [{ name: 'task', type: 'string', description: 'Task', required: true }],
  nodes: [
    { id: 'plan', type: 'argus.agent', label: 'Plan', dependsOn: [], args: { prompt: '{{ input.task }}' }, agentRole: 'planner' },
    { id: 'approval', type: 'argus.approval', label: 'Approve', dependsOn: ['plan'], args: { message: 'Approve?' } },
    { id: 'response', type: 'logic.response', label: 'Result', dependsOn: ['approval'], args: { value: '{{ steps.plan.result }}' } },
  ],
  agentRequirements: [{ role: 'planner', stepIds: ['plan'] }],
  requiredBundleCategories: [],
  completion: { trueFields: ['visual_completed'], nonEmptyFields: ['delivery_summary'] },
};

test('accepts Argus Workflow Spec v1 and projects a dynamic Agent Card workflow', () => {
  const parsed = parseVisualWorkflowSpec(spec);
  const catalog = visualWorkflowCatalogEntry(parsed);
  assert.equal(catalog.id, spec.id);
  assert.equal(catalog.origin, 'visual-builder');
  assert.deepEqual(catalog.approvalGates, ['approval']);
  assert.deepEqual(catalog.requiredAgents, ['planner']);
  assert.equal(catalog.stages.find(stage => stage.id === 'approval')?.kind, 'approval');
});

test('rejects cyclic visual workflow specs before graph registration', () => {
  assert.throws(() => parseVisualWorkflowSpec({
    ...spec,
    nodes: [
      { ...spec.nodes[0], dependsOn: ['response'] },
      spec.nodes[1],
      spec.nodes[2],
    ],
  }), /acyclic/);
});

test('maps portable Agent roles to the Core-assigned subscription runtime task types', () => {
  assert.equal(visualWorkerTaskType({ agentRole: 'planner' }), 'plan');
  assert.equal(visualWorkerTaskType({ agentRole: 'coder' }), 'implement_ticket');
  assert.equal(visualWorkerTaskType({ agentRole: 'reviewer' }), 'review');
  assert.equal(visualWorkerTaskType({ agentRole: 'researcher' }), 'knowledge');
  assert.equal(visualWorkerTaskType({ agentRole: 'custom-role' }), undefined);
});

test('projects an explicit reviewer verdict into shared workflow evidence', () => {
  assert.equal(visualReviewPassed('APPROVE\n\nThe scoped evidence is complete.'), true);
  assert.equal(visualReviewPassed('Verdict: APPROVED.\nValidation passed.'), true);
  assert.equal(visualReviewPassed('REQUEST_CHANGES\n\nAdd a regression test.'), false);
  assert.equal(visualReviewPassed('The review is descriptive but has no verdict.'), false);
});

test('evaluates the safe portable Condition subset', () => {
  assert.equal(evaluateVisualCondition('input.approved === true', { approved: true }, {}), true);
  assert.equal(evaluateVisualCondition('input.intent !== "reject"', { intent: 'implement' }, {}), true);
  assert.equal(evaluateVisualCondition('steps.review.result === "APPROVE"', {}, {
    review: { result: 'APPROVE' },
  }), true);
  assert.equal(evaluateVisualCondition('!input.enabled', { enabled: false }, {}), true);
});

test('resolves a Router value and selects its configured branch or fallback', () => {
  const router = {
    type: 'logic.router' as const,
    args: {
      route_on: '{{ input.intent }}',
      routes: { implement: 'coder', explain: 'planner' },
      default_route: 'fallback',
    },
  };
  assert.equal(resolveVisualRouteValue(router.args.route_on, { intent: 'implement' }, {}), 'implement');
  assert.equal(visualSelectedTarget(router, 'implement'), 'coder');
  assert.equal(visualSelectedTarget(router, 'unknown'), 'fallback');
});

test('accepts a portable Router only when every target is directly connected', () => {
  const routedNodes = [
    { id: 'route', type: 'logic.router', label: 'Route', dependsOn: [], args: {
      route_on: '{{ input.task }}', routes: { plan: 'plan', review: 'review' },
    } },
    { ...spec.nodes[0], dependsOn: ['route'] },
    { id: 'review', type: 'argus.agent', label: 'Review', dependsOn: ['route'], args: {}, agentRole: 'reviewer' },
    { ...spec.nodes[2], dependsOn: ['plan', 'review'] },
  ];
  const routed = {
    ...spec,
    nodes: routedNodes,
  };
  assert.equal(parseVisualWorkflowSpec(routed).nodes[0]?.type, 'logic.router');
  assert.throws(() => parseVisualWorkflowSpec({
    ...routed,
    nodes: routedNodes.map(node => node.id === 'route'
      ? { ...node, args: { ...node.args, routes: { plan: 'plan', review: 'response' } } }
      : node),
  }), /directly connected/);
});

test('skips only the unselected branch and still permits a shared response join', () => {
  const router = {
    id: 'route', type: 'logic.router' as const, label: 'Route', dependsOn: [],
    args: { route_on: '{{ input.intent }}', routes: { implement: 'coder', explain: 'planner' } },
  };
  const coder = { id: 'coder', type: 'argus.agent' as const, label: 'Coder', dependsOn: ['route'], args: {}, agentRole: 'coder' };
  const planner = { id: 'planner', type: 'argus.agent' as const, label: 'Planner', dependsOn: ['route'], args: {}, agentRole: 'planner' };
  const response = { id: 'response', type: 'logic.response' as const, label: 'Response', dependsOn: ['coder', 'planner'], args: {} };
  const nodes = new Map([router, coder, planner, response].map(node => [node.id, node]));
  const afterRoute = { route: { status: 'completed' as const, result: 'implement' } };

  assert.equal(visualRoutingSkipReason(coder, afterRoute, nodes), undefined);
  assert.match(visualRoutingSkipReason(planner, afterRoute, nodes) ?? '', /selected 'coder'/);
  assert.equal(visualRoutingSkipReason(response, {
    ...afterRoute,
    coder: { status: 'completed', result: 'implemented' },
    planner: { status: 'skipped', result: 'not selected' },
  }, nodes), undefined);
  assert.equal(visualResponseFallback(response.dependsOn, {
    coder: { status: 'completed', result: 'implemented' },
    planner: { status: 'skipped', result: 'not selected' },
  }), 'implemented');
});
