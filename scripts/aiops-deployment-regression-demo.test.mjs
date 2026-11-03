import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const runner = await readFile(resolve('scripts/run-aiops-deployment-regression-demo.ps1'), 'utf8');
const patch = yaml.load(await readFile(
  resolve('demo/aiops/kubernetes/checkout-api-regression-patch.yaml'),
  'utf8',
));
const completion = await readFile(
  resolve('src/scripts/completeAiopsDeploymentRegressionDemo.ts'),
  'utf8',
);
const investigation = await readFile(resolve('src/scripts/runAiopsIncidentDemo.ts'), 'utf8');
const abortCleanup = await readFile(resolve('src/scripts/abortAiopsDeploymentRegressionDemo.ts'), 'utf8');
const intentMigration = await readFile(
  resolve('db/migrations/183_deployment_revision_remediation_intent.sql'),
  'utf8',
);

test('deployment regression changes only the checkout-api pod template', () => {
  assert.equal(patch.kind, 'Deployment');
  assert.equal(patch.metadata.namespace, 'argus-demo');
  assert.equal(patch.metadata.name, 'checkout-api');
  assert.deepEqual(Object.keys(patch.spec), ['template']);
  assert.equal(patch.spec.template.metadata.annotations['argus.aiops/demo-regression'], 'unready-rollout-v1');
  assert.equal(patch.spec.template.spec.containers.length, 1);
  assert.equal(patch.spec.template.spec.containers[0].name, 'api');
  assert.match(patch.spec.template.spec.containers[0].command.join(' '), /simulated checkout-api startup regression/);
});

test('guided demo fails safe and delegates the actual recovery to the Core adapter', () => {
  assert.match(runner, /ARGUS_AIOPS_DEMO_REMEDIATION=deployment-revision/);
  assert.match(runner, /ARGUS_AIOPS_TARGET_REVISION=\$healthyRevision/);
  assert.match(runner, /Waiting up to \$ApprovalTimeoutMinutes minutes for Core-verified recovery/);
  assert.match(runner, /completeAiopsDeploymentRegressionDemo\.js/);
  assert.match(runner, /finally\s*\{/);
  assert.match(runner, /rollout undo/);
  assert.match(runner, /checkout-api is already healthy; no second operator rollback is needed/);
  assert.match(runner, /if \(-not \(Test-Recovered \$kubectl\)\) \{ throw \}/);
  assert.match(runner, /abortAiopsDeploymentRegressionDemo\.js/);
  assert.doesNotMatch(runner, /kubectl[^\r\n]*(?:delete namespace|delete ns|--all)/i);
});

test('failed-demo incident cleanup is bound to an unguessable run identity', () => {
  assert.match(runner, /\[guid\]::NewGuid\(\)\.ToString\(\)/);
  assert.match(investigation, /demoRunId: deploymentRegression \? demoRunId/);
  assert.match(abortCleanup, /context->>'demoRunId'=\$1/);
  assert.match(abortCleanup, /context->>'signal'='deployment_availability'/);
});

test('incident recovery requires a verified revision change plan', () => {
  assert.match(completion, /plan\.adapter_key='kubernetes\.deployment-revision-rollback\.v1'/);
  assert.match(completion, /plan\.status='verified'/);
  assert.match(completion, /state='recovered'/);
  assert.doesNotMatch(completion, /plan\.status\s+IN/);
});

test('revision proposals require persisted Kubernetes provider evidence', () => {
  assert.match(investigation, /span\.tool_name LIKE 'aiops_kubernetes_%'/);
  assert.match(investigation, /span\.status='completed'/);
  assert.match(investigation, /completed without persisted Kubernetes tool evidence/);
});

test('the database admits only exact registered scale or revision intents', () => {
  assert.match(intentMigration, /kubernetes\.scale\.v1/);
  assert.match(intentMigration, /kubernetes\.deployment-revision-rollback\.v1/);
  assert.match(intentMigration, /ARRAY\['adapterKey','workloadKind','workloadName','targetRevision'\]/);
  assert.match(intentMigration, /execution_intent->>'workloadKind' = 'Deployment'/);
  assert.match(intentMigration, /BETWEEN 1 AND 1000000000/);
  assert.doesNotMatch(intentMigration, /resources_create_or_update|shell\.exec/);
});
