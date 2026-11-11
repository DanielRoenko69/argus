import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const seed = await readFile(resolve('src/scripts/seedBackendSsoDemo.ts'), 'utf8');
const compose = await readFile(resolve('deploy/compose/demo/compose.backend-sso-demo.yml'), 'utf8');
const jenkinsInit = await readFile(resolve('demo/backend-sso/jenkins/init.groovy.d/10-argus-production-proof.groovy'), 'utf8');
const demoRunner = await readFile(resolve('scripts/backend-sso-demo.mjs'), 'utf8');

test('backend SSO proof grants only the bounded read-only tools to the workforce admin group', () => {
  assert.match(seed, /ARGUS_SSO_DEMO_GROUP/);
  assert.match(seed, /argus-platform-admins/);
  for (const tool of [
    'gitea_local_get_repo',
    'gitea_local_list_action_runs',
    'jenkins_prod_list_jobs',
    'jenkins_prod_get_job',
    'aiops_prometheus_query',
    'aiops_loki_query_range',
    'aiops_jaeger_services',
    'opensearch_prod_get_cluster_health',
    'opensearch_prod_search',
  ]) {
    assert.match(seed, new RegExp(`'${tool}'`));
  }
  assert.doesNotMatch(seed, /proofToolPatterns[\s\S]*?\*_\*/);
  assert.match(seed, /mcp_group_tool_rules/);
  assert.match(seed, /effect='allow'/);
});

test('production-like Jenkins and OpenSearch use separate least-privileged service identities', () => {
  assert.match(seed, /name: 'jenkins-prod'/);
  assert.match(seed, /name: 'opensearch-prod'/);
  assert.match(seed, /credential_mode: 'readonly-service-identity'/);
  assert.match(seed, /is_write, risk_level[\s\S]*true,false,'low'/);
  assert.match(seed, /payment-provider-timeout/);
  assert.doesNotMatch(seed, /jenkins_prod_trigger_build/);
});

test('Jenkins, Argus and live verification resolve one operator-controlled service token', () => {
  const jenkinsService = compose.slice(compose.indexOf('  jenkins-sso:'), compose.indexOf('  opensearch-sso:'));
  assert.match(jenkinsService, /ARGUS_JENKINS_SERVICE_TOKEN:\s*\$\{ARGUS_JENKINS_SERVICE_TOKEN:-/);
  assert.match(jenkinsInit, /System\.getenv\('ARGUS_JENKINS_SERVICE_TOKEN'\)/);
  assert.match(jenkinsInit, /addFixedNewToken\([\s\S]*?serviceToken/);
  assert.doesNotMatch(jenkinsInit, /11a64f0e733bfa5da9d8bb312839476a1d/);
  assert.match(demoRunner, /effectiveServiceEnvironment\('mcp-server'\)/);
  assert.match(demoRunner, /mcpServerEnvironment\.ARGUS_JENKINS_SERVICE_TOKEN/);
  const backendSeed = demoRunner.indexOf("'Backend SSO demo seed'");
  const coreReload = demoRunner.indexOf("'restart', 'mcp-server'", backendSeed);
  assert.ok(backendSeed >= 0 && coreReload > backendSeed, 'Core must reload the backend registry after the direct seed');
  assert.match(demoRunner.slice(coreReload), /waitFor\('http:\/\/localhost:3000\/health', 'Argus after backend seed'\)/);
});

test('backend SSO proof remains an idempotent read-only visual workflow', () => {
  assert.match(seed, /sso_it_readonly_backend_proof/);
  assert.match(seed, /ON CONFLICT \(tenant_key, workspace_key, name\) DO UPDATE/);
  assert.match(seed, /Argus SSO IT golden-path read-only proof/);
  const toolBoundary = seed.slice(seed.indexOf('const proofToolPatterns'), seed.indexOf('const proofSteps'));
  assert.doesNotMatch(toolBoundary, /workspace_exec|delete|deploy|merge|remediat/i);
});

test('OpenSearch Dashboards health checks the live OIDC entry point', () => {
  const service = compose.slice(compose.indexOf('  opensearch-dashboards-sso:'));
  assert.match(service, /healthcheck:[\s\S]*\/auth\/openid\/login/);
  assert.doesNotMatch(service, /^\s*test:.*\/api\/status/m);
});
