import assert from 'node:assert/strict';
import test from 'node:test';
import { ARGUS_DEV_PACK_MANIFEST } from './packManifest.js';

test('Argus Dev publishes a stable container-delivered pack identity', () => {
  assert.equal(ARGUS_DEV_PACK_MANIFEST.apiVersion, 'argus.eu/v1alpha1');
  assert.equal(ARGUS_DEV_PACK_MANIFEST.metadata.id, 'argus.dev');
  assert.equal(ARGUS_DEV_PACK_MANIFEST.spec.delivery.protocol, 'argus-pack-v1alpha1');
  assert.equal(ARGUS_DEV_PACK_MANIFEST.spec.delivery.healthPath, '/healthz');
  assert.equal(ARGUS_DEV_PACK_MANIFEST.spec.delivery.readinessPath, '/readyz');
});

test('Argus Dev declares its governed coding workflow references consistently', () => {
  const agent = ARGUS_DEV_PACK_MANIFEST.spec.components.agents[0];
  assert.ok(agent);
  assert.equal(agent.runtime, 'a2a');
  assert.equal(agent.a2aAgentCardPath, '/.well-known/agent-card.json');
  for (const skill of agent.skills) {
    assert.ok(ARGUS_DEV_PACK_MANIFEST.spec.components.skills.includes(skill));
  }
  for (const bundle of agent.bundles) {
    assert.ok(ARGUS_DEV_PACK_MANIFEST.spec.components.bundles.includes(bundle));
  }
  assert.deepEqual(agent.coreAgents, ['planner', 'knowledge', 'coder', 'reviewer', 'researcher']);
  assert.ok(ARGUS_DEV_PACK_MANIFEST.spec.components.workflows.includes('ticket-to-pull-request'));
  assert.ok(ARGUS_DEV_PACK_MANIFEST.spec.components.workflows.includes('pull-request-review'));
  assert.ok(ARGUS_DEV_PACK_MANIFEST.spec.components.workflows.includes('ci-failure-recovery'));
  assert.ok(ARGUS_DEV_PACK_MANIFEST.spec.components.workflows.includes('security-remediation'));
  assert.ok(ARGUS_DEV_PACK_MANIFEST.spec.components.workflows.includes('release-notes'));
  assert.ok(ARGUS_DEV_PACK_MANIFEST.spec.components.workflows.includes('backlog-grooming'));
});
