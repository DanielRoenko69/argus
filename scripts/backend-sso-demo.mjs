import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const action = process.argv[2] ?? 'up';
if (!['up', 'verify', 'stop'].includes(action)) {
  throw new Error('Usage: node scripts/backend-sso-demo.mjs <up|verify|stop>');
}
if (!existsSync(resolve(root, '.env'))) {
  throw new Error('Missing .env; complete the normal Argus Docker installation first');
}

function composeArguments() {
  const args = ['compose', '--project-name', 'argus-core', '--project-directory', root, '--env-file', '.env'];
  if (existsSync(resolve(root, '.env.worm-demo.local'))) args.push('--env-file', '.env.worm-demo.local');
  args.push('-f', 'docker-compose.yml');
  for (const file of [
    'compose.external-pack.yml',
    'compose.hermes-attached.yml',
    'compose.hermes-local.yml',
    'compose.aiops-demo.yml',
  ]) {
    if (existsSync(resolve(root, file))) args.push('-f', file);
  }
  if (existsSync(resolve(root, '.env.worm-demo.local'))) {
    args.push('-f', 'compose.audit-evidence.yml', '-f', 'compose.worm-demo.yml');
  }
  args.push(
    '-f', 'compose.mfa-demo.yml',
    '-f', 'compose.backend-sso-demo.yml',
    '--profile', 'dev-demo',
    '--profile', 'aiops-demo',
    '--profile', 'backend-sso-demo',
  );
  return args;
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `: ${(result.stderr || result.stdout || '').trim()}` : '';
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
  return capture ? String(result.stdout) : '';
}

async function runWithRetries(command, args, label, attempts = 5, delayMs = 2_000) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return run(command, args);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      process.stderr.write(`${label} attempt ${attempt}/${attempts} failed; retrying in ${delayMs} ms.\n`);
      await new Promise(resolveWait => setTimeout(resolveWait, delayMs));
    }
  }
  throw lastError;
}

async function waitFor(url, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unreachable';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3_000) });
      lastStatus = `HTTP ${response.status}`;
      if (response.status < 500) return response;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`${label} did not become ready: ${lastStatus}`);
}

const compose = composeArguments();
function effectiveServiceEnvironment(serviceName) {
  const rendered = JSON.parse(run('docker', [...compose, 'config', '--format', 'json'], true));
  const environment = rendered?.services?.[serviceName]?.environment;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error(`Docker Compose did not render an environment for ${serviceName}`);
  }
  return environment;
}

const mcpServerEnvironment = effectiveServiceEnvironment('mcp-server');
const giteaPort = process.env.GITEA_PORT ?? '3005';
const grafanaPort = process.env.ARGUS_GRAFANA_PORT ?? '3006';
const jenkinsPort = process.env.ARGUS_JENKINS_PORT ?? '8081';
const opensearchPort = process.env.ARGUS_OPENSEARCH_PORT ?? '9202';
const opensearchDashboardsPort = process.env.ARGUS_OPENSEARCH_DASHBOARDS_PORT ?? '5601';
const keycloakPort = process.env.ARGUS_MFA_DEMO_PORT ?? '8180';
const giteaName = 'argus-mfa-demo';
const jenkinsServiceToken = String(mcpServerEnvironment.ARGUS_JENKINS_SERVICE_TOKEN ?? '').trim();
const opensearchServicePassword = String(mcpServerEnvironment.ARGUS_OPENSEARCH_SERVICE_PASSWORD ?? '').trim();
if (!jenkinsServiceToken || !opensearchServicePassword) {
  throw new Error('Docker Compose must render the Jenkins and OpenSearch service credentials');
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function fetchJson(url, label, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  return { status: response.status, body };
}

function configureGiteaOidc() {
  const list = run('docker', [...compose, 'exec', '-T', '--user', 'git', 'gitea', 'gitea', 'admin', 'auth', 'list'], true);
  const existing = list.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .find(columns => columns[1] === giteaName);
  const command = existing ? 'update-oauth' : 'add-oauth';
  const args = [
    ...compose,
    'exec', '-T', '--user', 'git', 'gitea',
    'gitea', 'admin', 'auth', command,
    ...(existing ? ['--id', existing[0]] : []),
    '--name', giteaName,
    '--provider', 'openidConnect',
    '--key', 'argus-gitea',
    '--secret', 'argus-gitea-client-secret',
    '--auto-discover-url', 'http://keycloak-mfa:8080/realms/argus-mfa-demo/.well-known/openid-configuration',
    '--scopes', 'openid',
    '--scopes', 'profile',
    '--scopes', 'email',
    '--group-claim-name', 'groups',
    '--admin-group', 'argus-platform-admins',
    '--skip-local-2fa', 'true',
  ];
  run('docker', args);
}

async function verifyInfrastructure() {
  const [keycloak, gitea, grafana, jenkins, opensearch, opensearchDashboards] = await Promise.all([
    waitFor(`http://localhost:${keycloakPort}/realms/argus-mfa-demo/.well-known/openid-configuration`, 'Keycloak'),
    waitFor(`http://localhost:${giteaPort}/api/healthz`, 'Gitea'),
    waitFor(`http://localhost:${grafanaPort}/api/health`, 'Grafana'),
    waitFor(`http://localhost:${jenkinsPort}/login`, 'Jenkins', 240_000),
    waitFor(`http://localhost:${opensearchPort}/_cluster/health`, 'OpenSearch', 240_000),
    waitFor(`http://localhost:${opensearchDashboardsPort}/api/status`, 'OpenSearch Dashboards', 240_000),
  ]);
  const authList = run('docker', [...compose, 'exec', '-T', '--user', 'git', 'gitea', 'gitea', 'admin', 'auth', 'list'], true);
  const grafanaLogin = await fetch(`http://localhost:${grafanaPort}/login`, { redirect: 'manual' });
  const grafanaOauth = await fetch(`http://localhost:${grafanaPort}/login/generic_oauth`, { redirect: 'manual' });
  const grafanaLoginLocation = grafanaLogin.headers.get('location') ?? '';
  const grafanaOauthLocation = grafanaOauth.headers.get('location') ?? '';
  const jenkinsLogin = await fetch(`http://localhost:${jenkinsPort}/securityRealm/commenceLogin?from=%2F`, { redirect: 'manual' });
  const opensearchLogin = await fetch(`http://localhost:${opensearchDashboardsPort}/auth/openid/login`, { redirect: 'manual' });
  const jenkinsJobs = await fetchJson(`http://localhost:${jenkinsPort}/api/json?tree=jobs[name,color,lastBuild[number,result]]`, 'Jenkins service read', {
    headers: { authorization: basicAuth('argus-service', jenkinsServiceToken) },
  });
  const opensearchLogs = await fetchJson(`http://localhost:${opensearchPort}/argus-production-logs/_search`, 'OpenSearch service read', {
    method: 'POST',
    headers: {
      authorization: basicAuth('argus-service', opensearchServicePassword),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: { match: { message: 'payment-provider-timeout' } } }),
  });
  const jenkinsJob = Array.isArray(jenkinsJobs.body?.jobs)
    ? jenkinsJobs.body.jobs.find(job => job.name === 'checkout-api-production') : null;
  const opensearchHit = opensearchLogs.body?.hits?.hits?.find(hit => hit?._source?.message === 'payment-provider-timeout');
  const jenkinsLocation = jenkinsLogin.headers.get('location') ?? '';
  const opensearchLocation = opensearchLogin.headers.get('location') ?? '';
  const checks = {
    keycloakReady: keycloak.status === 200,
    giteaReady: gitea.status === 200,
    grafanaReady: grafana.status === 200,
    jenkinsReady: jenkins.status < 500,
    opensearchReady: opensearch.status < 500,
    opensearchDashboardsReady: opensearchDashboards.status < 500,
    giteaOidcSource: authList.split(/\r?\n/).some(line => line.includes(giteaName) && /OAuth2/i.test(line)),
    grafanaStartsOidc: grafanaLogin.status >= 300 && grafanaLogin.status < 400
      && grafanaLoginLocation.startsWith('/login/generic_oauth')
      && grafanaOauth.status >= 300 && grafanaOauth.status < 400
      && grafanaOauthLocation.includes('/realms/argus-mfa-demo/'),
    jenkinsStartsOidc: jenkinsLogin.status >= 300 && jenkinsLogin.status < 400
      && jenkinsLocation.includes('/realms/argus-mfa-demo/'),
    opensearchStartsOidc: opensearchLogin.status >= 300 && opensearchLogin.status < 400
      && opensearchLocation.includes('/realms/argus-mfa-demo/'),
    jenkinsReadOnlyEvidence: Boolean(jenkinsJob?.lastBuild?.number)
      && ['SUCCESS', null].includes(jenkinsJob.lastBuild?.result ?? null),
    opensearchProductionEvidence: Boolean(opensearchHit)
      && opensearchHit?._source?.service === 'checkout-api'
      && opensearchHit?._source?.environment === 'production',
  };
  const report = {
    schema: 'argus.backend-sso-infrastructure.v1',
    generatedAt: new Date().toISOString(),
    passed: Object.values(checks).every(Boolean),
    applications: {
      argus: 'http://localhost:3000',
      gitea: `http://localhost:${giteaPort}`,
      grafana: `http://localhost:${grafanaPort}`,
      jenkins: `http://localhost:${jenkinsPort}`,
      opensearch: `http://localhost:${opensearchPort}`,
      opensearchDashboards: `http://localhost:${opensearchDashboardsPort}`,
      identityProvider: `http://localhost:${keycloakPort}`,
    },
    checks,
  };
  mkdirSync(resolve(root, 'test-results'), { recursive: true });
  writeFileSync(resolve(root, 'test-results', 'backend-sso-infrastructure.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) throw new Error('Backend SSO infrastructure verification failed');
}

if (action === 'stop') {
  run('docker', [...compose, 'rm', '-f', '-s',
    'grafana-sso', 'jenkins-sso', 'opensearch-dashboards-sso', 'opensearch-sso-init', 'opensearch-sso']);
  process.stdout.write('Backend SSO demo portal stopped. Community/service credential paths remain unchanged.\n');
  process.exit(0);
}

if (action === 'up') {
  run(process.execPath, ['scripts/mfa-demo.mjs', 'up']);
  run('docker', [...compose, 'config', '--quiet']);
  run('docker', [...compose, 'up', '-d', '--build',
    'gitea', 'keycloak-mfa', 'grafana-sso', 'jenkins-sso',
    'opensearch-sso', 'opensearch-sso-init', 'opensearch-dashboards-sso']);
  // One-shot seed containers otherwise remain completed across repeated demo
  // starts. Recreate it so time-bounded OpenSearch showcase evidence is fresh.
  run('docker', [...compose, 'up', '-d', '--force-recreate', '--no-deps', 'opensearch-sso-init']);
  await waitFor(`http://localhost:${keycloakPort}/realms/argus-mfa-demo/.well-known/openid-configuration`, 'Keycloak');
  configureGiteaOidc();
  run('docker', [...compose, 'up', '-d', '--build', '--force-recreate', '--no-deps', 'mcp-server']);
  await waitFor('http://localhost:3000/health', 'Argus');
  await runWithRetries(
    'docker',
    [
      ...compose,
      'exec', '-T', '-e', 'ARGUS_DEV_INSTALL_REPOSITORY_RAG=false',
      'mcp-server', 'node', 'dist/scripts/seedLocalDevDemo.js',
    ],
    'Argus.Dev demo seed',
  );
  await runWithRetries(
    'docker',
    [...compose, 'exec', '-T', 'mcp-server', 'node', 'dist/scripts/seedBackendSsoDemo.js'],
    'Backend SSO demo seed',
  );
  // The seed writes encrypted backend rows directly. Restart Core once so its
  // in-memory backend registry and readiness snapshot use the newly rendered
  // credentials instead of the pre-seed objects loaded during startup.
  run('docker', [...compose, 'restart', 'mcp-server']);
  await waitFor('http://localhost:3000/health', 'Argus after backend seed');
}

await verifyInfrastructure();
process.stdout.write([
  '',
  'Backend workforce SSO is ready.',
  'Run the browser proof with: npm run certify:backend-sso',
  '',
].join('\n'));
