import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInvestigationPlan } from './domain.js';

test('builds a bounded, read-only incident investigation plan', () => {
  const plan = buildInvestigationPlan({
    title: 'Checkout latency',
    summary: 'P95 latency increased after a production deployment.',
    severity: 'critical',
    service: 'checkout',
    environment: 'production',
    started_at: '2026-08-10T10:30:00.000Z',
    correlation_window_minutes: 30,
  }, {
    now: new Date('2026-08-10T10:40:00.000Z'),
    selectedBundleIds: [9, 9, 4],
    resourceScope: { kind: 'kubernetes', backendId: 7, targetId: 'test-cluster', cluster: 'test', namespace: 'production', environment: 'test' },
  });

  assert.equal(plan.kind, 'aiops-investigation-plan');
  assert.equal(plan.scope.windowStart, '2026-08-10T10:00:00.000Z');
  assert.equal(plan.scope.windowEnd, '2026-08-10T11:00:00.000Z');
  assert.deepEqual(plan.scope.selectedBundleIds, [9, 4]);
  assert.deepEqual(plan.evidenceLanes.map(lane => lane.id), ['topology', 'metrics', 'logs', 'traces', 'changes', 'knowledge']);
  assert.equal(plan.hypotheses.every(item => item.status === 'untested' && item.confidence === null), true);
  assert.deepEqual(plan.safety, { mode: 'read-only', writesAllowed: false, rawTelemetryPersisted: false });
});

test('rejects an unbounded correlation window', () => {
  assert.throws(() => buildInvestigationPlan({
    title: 'Checkout latency',
    summary: 'The service is slow.',
    severity: 'warning',
    service: 'checkout',
    environment: 'production',
    correlation_window_minutes: 1_000,
  }, { resourceScope: { kind: 'kubernetes', backendId: 7, targetId: 'test-cluster', cluster: 'test', namespace: 'production', environment: 'test' } }));
});

