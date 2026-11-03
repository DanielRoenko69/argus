import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const manifestText = await readFile(
  resolve('demo/aiops/kubernetes/remediation-connector.yaml'),
  'utf8',
);
const seed = await readFile(resolve('demo/aiops/seed.sql'), 'utf8');
const adapterStateMigration = await readFile(
  resolve('db/migrations/182_generic_incident_remediation_adapter_state.sql'),
  'utf8',
);
const connectorSource = await readFile(
  resolve('demo/aiops/kubernetes/remediation-connector/server.mjs'),
  'utf8',
);
const connectorDockerfile = await readFile(
  resolve('demo/aiops/kubernetes/remediation-connector/Dockerfile'),
  'utf8',
);
const demoBootstrap = await readFile(resolve('scripts/bootstrap-aiops-demo.ps1'), 'utf8');
const remediationBootstrap = await readFile(
  resolve('scripts/bootstrap-aiops-kubernetes-remediation.ps1'),
  'utf8',
);
const remediationBootstrapShell = await readFile(
  resolve('scripts/bootstrap-aiops-kubernetes-remediation.sh'),
  'utf8',
);
const coreCompose = await readFile(resolve('docker-compose.yml'), 'utf8');
const documents = [];
yaml.loadAll(manifestText, document => {
  if (document) documents.push(document);
});

function resource(kind, namespace, name) {
  const found = documents.find(document => document.kind === kind
    && document.metadata?.namespace === namespace
    && document.metadata?.name === name);
  assert.ok(found, `${kind} ${namespace}/${name} must exist`);
  return found;
}

test('remediation connector has a namespaced workload-bounded Kubernetes identity', () => {
  assert.equal(documents.some(document => document.kind === 'ClusterRole'), false);
  assert.equal(documents.some(document => document.kind === 'ClusterRoleBinding'), false);

  const role = resource('Role', 'argus-demo', 'argus-kubernetes-remediation');
  assert.deepEqual(role.rules, [{
    apiGroups: ['apps'],
    resources: ['deployments/scale', 'statefulsets/scale'],
    verbs: ['get', 'patch', 'update'],
  }, {
    apiGroups: ['apps'],
    resources: ['deployments'],
    verbs: ['get', 'patch'],
  }, {
    apiGroups: ['apps'],
    resources: ['replicasets'],
    verbs: ['get', 'list'],
  }]);

  const binding = resource('RoleBinding', 'argus-demo', 'argus-kubernetes-remediation');
  assert.deepEqual(binding.subjects, [{
    kind: 'ServiceAccount',
    name: 'argus-kubernetes-remediation',
    namespace: 'argus-aiops-system',
  }]);
});

test('remediation MCP image and process are pinned, hardened and workload allowlisted', () => {
  const deployment = resource('Deployment', 'argus-aiops-system', 'argus-kubernetes-remediation');
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(pod.serviceAccountName, 'argus-kubernetes-remediation');
  assert.equal(container.image, 'argus-aiops-remediation-connector:local');
  assert.equal(container.imagePullPolicy, 'Never');
  assert.deepEqual(container.env, [
    { name: 'EXECUTION_NAMESPACES', value: 'argus-demo' },
    { name: 'EXECUTION_WORKLOADS', value: 'checkout-api' },
  ]);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.runAsNonRoot, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);

  const service = resource('Service', 'argus-aiops-system', 'argus-kubernetes-remediation');
  assert.equal(service.spec.type, 'NodePort');
  assert.equal(service.spec.ports[0].port, 8085);
  assert.equal(service.spec.ports[0].nodePort, 30085);
});

test('revision restoration is fingerprint-bound, preconditioned and conflict-bounded', () => {
  assert.match(connectorDockerfile, /FROM node:20-alpine@sha256:[a-f0-9]{64}/);
  assert.match(connectorDockerfile, /USER 1000:1000/);
  assert.match(connectorSource, /EXECUTION_WORKLOADS/);
  assert.match(connectorSource, /expectedCurrentTemplateHash/);
  assert.match(connectorSource, /targetTemplateHash/);
  assert.match(connectorSource, /op: 'test', path: '\/metadata\/resourceVersion'/);
  assert.match(connectorSource, /attempt <= 5/);
  assert.doesNotMatch(connectorSource, /resources_create_or_update|pods_exec|child_process|execFile|spawn/);
});

test('Argus keeps remediation tools outside the read-only Agent bundle', () => {
  assert.match(seed, /'argus-aiops-remediate'[\s\S]*'Argus\.AIOps Remediate'/);
  assert.match(seed, /'aiops-kubernetes-remediation'[\s\S]*'argus-aiops-remediate'/);
  assert.match(seed, /"remediation_source_bundles":\["argus-aiops-observe"\]/);
  assert.match(seed, /'aiops_kubernetes_remediation_resources_scale'/);
  assert.match(seed, /'aiops_kubernetes_remediation_deployment_revision_rollback'/);
  assert.match(seed, /"execution_workloads":\["checkout-api"\]/);

  const agentSection = seed.slice(seed.indexOf('-- Pack-owned Core Agent declarations.'));
  assert.doesNotMatch(agentSection, /argus-aiops-remediate/);
});

test('Core reaches the connector only over the private Kind Docker network', async () => {
  const compose = await readFile(resolve('compose.aiops-demo.yml'), 'utf8');
  assert.match(coreCompose, /argus-aiops-control-plane/);
  assert.match(compose, /argus-kind:[\s\S]*external:\s*true[\s\S]*name:\s*kind/);
  assert.doesNotMatch(seed, /host\.docker\.internal:18085/);
  assert.match(demoBootstrap, /Ensure-ContainerNetworkMembership \$coreContainer 'argus-core-network'/);
  assert.match(demoBootstrap, /Ensure-ContainerNetworkMembership \$coreContainer 'kind'/);
  assert.match(demoBootstrap, /docker network connect \$NetworkName \$ContainerId/);
});

test('expected Kubernetes deny assertions do not leak a failing process exit code', () => {
  assert.match(remediationBootstrap, /if \(\$actual -ne \$Expected\)[\s\S]*\$global:LASTEXITCODE = 0/);
  assert.match(remediationBootstrapShell, /"--subresource=\$subresource"/);
  assert.match(remediationBootstrapShell, /auth can-i "\$verb" "\$resource_name"/);
  assert.match(remediationBootstrapShell, /\|\| true/);
});

test('base Compose preserves the exact Argus-owned internal service allowlist across rebuilds', () => {
  assert.match(coreCompose, /SSRF_ALLOWLIST_HOSTS:\s*gitea,langgraph,argus-dev,argus-aiops,prometheus,loki,jaeger,host\.docker\.internal,argus-aiops-control-plane,/);
  assert.doesNotMatch(coreCompose, /SSRF_ALLOWLIST_HOSTS:\s*(?:\*|0\.0\.0\.0\/0)/);
});

test('Core persists immutable adapter state without forcing future adapters into replica columns', () => {
  assert.match(adapterStateMigration, /ADD COLUMN IF NOT EXISTS adapter_state JSONB/);
  assert.match(adapterStateMigration, /ALTER COLUMN adapter_state SET NOT NULL/);
  assert.match(adapterStateMigration, /ALTER COLUMN previous_replicas DROP NOT NULL/);
  assert.match(adapterStateMigration, /ALTER COLUMN desired_replicas DROP NOT NULL/);
  assert.match(adapterStateMigration, /NEW\.adapter_state IS DISTINCT FROM OLD\.adapter_state/);
  assert.match(adapterStateMigration, /ADD COLUMN IF NOT EXISTS observed_state JSONB/);
  assert.match(adapterStateMigration, /jsonb_typeof\(observed_state->'schemaVersion'\) = 'number'/);
});
