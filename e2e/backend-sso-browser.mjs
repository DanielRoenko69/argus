import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { generateTotp, LOCAL_MFA_ALEX } from '../scripts/lib/localMfaDemo.mjs';

const argusUrl = (process.env.ARGUS_BACKEND_SSO_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const outputDirectory = resolve(import.meta.dirname, '..', 'test-results');
const channels = ['msedge', 'chrome', undefined];
let browser = null;
let browserChannel = 'chromium';
for (const channel of channels) {
  try {
    browser = await chromium.launch({
      ...(channel ? { channel } : {}),
      headless: true,
      args: ['--force-device-scale-factor=1'],
    });
    browserChannel = channel ?? 'chromium';
    break;
  } catch (error) {
    if (channel === undefined) throw error;
  }
}
if (!browser) throw new Error('No supported Chromium browser is available');

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
// Keycloak rejects one-time-code replay. Another certification process may
// have consumed the current Alex code immediately before this one starts, so
// deliberately wait for the next period on the first submission as well.
let previousTotp = generateTotp({ secret: LOCAL_MFA_ALEX.totpSecret });

async function freshTotp() {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const code = generateTotp({ secret: LOCAL_MFA_ALEX.totpSecret });
    if (code !== previousTotp) {
      previousTotp = code;
      return code;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error('No fresh Alex TOTP became available');
}

async function signIntoArgus() {
  await page.goto(`${argusUrl}/login`);
  await page.getByRole('link', { name: /Argus MFA Demo/i }).click();
  const username = page.locator('#username');
  const password = page.locator('#password');
  const otp = page.locator('#otp');
  await username.fill(LOCAL_MFA_ALEX.username);
  await password.fill(LOCAL_MFA_ALEX.password);
  await page.locator('#kc-login').click();

  const argusUrlPattern = new RegExp(`^${argusUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await otp.waitFor({ state: 'visible', timeout: 20_000 });
    await otp.fill(await freshTotp());
    await page.locator('#kc-login').click();
    const returnedToArgus = await page.waitForURL(argusUrlPattern, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (returnedToArgus) return;

    // A preceding certification can consume Alex's current one-time code.
    // Keycloak rejects that replay, so submit the next TOTP period once.
    if (!await otp.isVisible().catch(() => false)) break;
  }

  const providerMessages = await page.locator('#input-error, .kc-feedback-text, [role="alert"]')
    .allTextContents().catch(() => []);
  throw new Error(`Keycloak did not accept Alex's MFA factors: ${providerMessages.join(' ').trim() || page.url()}`);
}

async function readArgusState() {
  return page.evaluate(async () => {
    const [meResponse, fabricResponse] = await Promise.all([
      fetch('/api/me', { headers: { accept: 'application/json' } }),
      fetch('/api/ui/mcp-fabric', { headers: { accept: 'application/json' } }),
    ]);
    return {
      me: { status: meResponse.status, body: await meResponse.json() },
      fabric: { status: fabricResponse.status, body: await fabricResponse.json() },
    };
  });
}

async function authorizeLaunch(portal) {
  if (!portal?.launchPath) throw new Error(`${portal?.application ?? 'Backend'} has no ready SSO launch path`);
  const response = await context.request.get(`${argusUrl}${portal.launchPath}`, { maxRedirects: 0 });
  const location = response.headers()['location'] ?? '';
  return {
    status: response.status(),
    location,
    auditId: response.headers()['x-argus-audit-id'] ?? null,
  };
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

try {
  mkdirSync(outputDirectory, { recursive: true });
  await signIntoArgus();
  const argus = await readArgusState();
  const portals = (argus.fabric.body?.servers ?? [])
    .map(server => ({ backendId: server.id, backendName: server.name, ...server.ssoPortal }))
    .filter(portal => portal.application && portal.state === 'ready');
  const giteaPortal = portals.find(portal => portal.application === 'Gitea');
  const grafanaPortal = portals.find(portal => portal.application === 'Grafana');
  const jenkinsPortal = portals.find(portal => portal.application === 'Jenkins');
  const opensearchPortal = portals.find(portal => portal.application === 'OpenSearch Dashboards');
  if (!giteaPortal || !grafanaPortal || !jenkinsPortal || !opensearchPortal) {
    throw new Error(`Expected ready Gitea, Jenkins, Grafana and OpenSearch portals, got: ${JSON.stringify(portals)}`);
  }

  await page.goto(`${argusUrl}/mcp-fabric?view=connections`);
  await page.getByRole('heading', { name: 'MCP Fabric', level: 1 }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByText('One identity, governed backend access', { exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: resolve(outputDirectory, 'backend-sso-argus-fabric.png'), fullPage: false });

  const giteaLaunch = await authorizeLaunch(giteaPortal);
  await page.goto(giteaLaunch.location);
  await page.waitForURL(url => url.origin === 'http://localhost:3005', { timeout: 30_000 });
  const giteaProfileVisible = await page.evaluate(() => document.body.innerText
    .split(/\s+/u)
    .some(value => value.toLocaleLowerCase() === 'alex'));
  const giteaProfileLabel = giteaProfileVisible ? 'alex' : null;
  await page.screenshot({ path: resolve(outputDirectory, 'backend-sso-gitea-alex.png'), fullPage: false });
  const giteaAdminResponse = await page.goto('http://localhost:3005/-/admin');
  const giteaAdminVisible = giteaAdminResponse?.status() === 200
    && new URL(page.url()).pathname.startsWith('/-/admin');
  await page.screenshot({ path: resolve(outputDirectory, 'backend-sso-gitea-admin-alex.png'), fullPage: false });
  const giteaIdentity = {
    status: giteaProfileVisible ? 200 : 401,
    body: { login: giteaProfileVisible ? 'alex' : null, label: giteaProfileLabel, is_admin: giteaAdminVisible },
  };

  await page.goto(`${argusUrl}/mcp-fabric?view=connections`);
  const grafanaLaunch = await authorizeLaunch(grafanaPortal);
  await page.goto(grafanaLaunch.location);
  await page.waitForURL(url => url.origin === 'http://localhost:3006' && !url.pathname.startsWith('/login'), { timeout: 30_000 });
  const grafanaDashboardTitle = page.getByText(/Argus AIOps.*Workforce SSO/i).first();
  await grafanaDashboardTitle.waitFor({ state: 'visible', timeout: 30_000 });
  const grafanaDashboardVisible = await grafanaDashboardTitle.isVisible();
  const grafanaIdentity = await page.evaluate(async () => {
    const [userResponse, userOrgsResponse, datasourcesResponse] = await Promise.all([
      fetch('/api/user', { headers: { accept: 'application/json' } }),
      fetch('/api/user/orgs', { headers: { accept: 'application/json' } }),
      fetch('/api/datasources', { headers: { accept: 'application/json' } }),
    ]);
    return {
      user: { status: userResponse.status, body: await userResponse.json() },
      userOrgs: { status: userOrgsResponse.status, body: await userOrgsResponse.json() },
      datasources: { status: datasourcesResponse.status, body: await datasourcesResponse.json() },
    };
  });
  await page.screenshot({ path: resolve(outputDirectory, 'backend-sso-grafana-alex.png'), fullPage: false });

  const currentGrafanaOrganization = Array.isArray(grafanaIdentity.userOrgs.body)
    ? grafanaIdentity.userOrgs.body.find(organization => organization.orgId === grafanaIdentity.user.body?.orgId)
    : null;

  await page.goto(`${argusUrl}/mcp-fabric?view=connections`);
  const jenkinsLaunch = await authorizeLaunch(jenkinsPortal);
  await page.goto(jenkinsLaunch.location);
  await page.waitForURL(url => url.origin === 'http://localhost:8081'
    && !url.pathname.startsWith('/securityRealm/finishLogin'), { timeout: 60_000 });
  const jenkinsIdentity = await page.evaluate(async () => {
    const [identityResponse, jobResponse] = await Promise.all([
      fetch('/whoAmI/api/json', { headers: { accept: 'application/json' } }),
      fetch('/job/checkout-api-production/api/json?tree=name,color,lastBuild[number,result,url]', {
        headers: { accept: 'application/json' },
      }),
    ]);
    return {
      identity: { status: identityResponse.status, body: await identityResponse.json() },
      job: { status: jobResponse.status, body: await jobResponse.json() },
    };
  });
  await page.screenshot({ path: resolve(outputDirectory, 'backend-sso-jenkins-alex.png'), fullPage: false });

  await page.goto(`${argusUrl}/mcp-fabric?view=connections`);
  const opensearchLaunch = await authorizeLaunch(opensearchPortal);
  await page.goto(opensearchLaunch.location);
  await page.waitForURL(url => url.origin === 'http://localhost:5601'
    && !url.pathname.startsWith('/auth/openid/login'), { timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded');
  await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
  const opensearchUi = await page.evaluate(() => ({
    title: document.title,
    text: document.body.innerText.slice(0, 20_000),
    url: window.location.href,
  }));
  await page.screenshot({ path: resolve(outputDirectory, 'backend-sso-opensearch-alex.png'), fullPage: false });

  const payload = {
    schema: 'argus.backend-workforce-sso-browser-certification.v2',
    generatedAt: new Date().toISOString(),
    browser: browserChannel,
    identity: {
      argusDisplayName: argus.me.body?.user?.display_name ?? null,
      argusRole: argus.me.body?.user?.role ?? null,
      giteaLogin: giteaIdentity.body?.login ?? null,
      giteaAdmin: giteaIdentity.body?.is_admin ?? null,
      grafanaLogin: grafanaIdentity.user.body?.login ?? null,
      grafanaRole: currentGrafanaOrganization?.role ?? null,
      jenkinsLogin: jenkinsIdentity.identity.body?.name ?? null,
      jenkinsAuthorities: jenkinsIdentity.identity.body?.authorities ?? [],
      opensearchSession: /opensearch|discover/i.test(`${opensearchUi.title} ${opensearchUi.text}`),
    },
    launches: { gitea: giteaLaunch, grafana: grafanaLaunch, jenkins: jenkinsLaunch, opensearch: opensearchLaunch },
    portals: portals.map(({ backendId, backendName, application, providerName, state }) => ({
      backendId, backendName, application, providerName, state,
    })),
    datasources: Array.isArray(grafanaIdentity.datasources.body)
      ? grafanaIdentity.datasources.body.map(item => ({ name: item.name, type: item.type, url: item.url }))
      : [],
    checks: {
      alexArgusIdentity: argus.me.status === 200
        && /^Alex(?:\s|$)/iu.test(String(argus.me.body?.user?.display_name ?? ''))
        && argus.me.body?.user?.role === 'platform_admin',
      premiumPortalsReady: portals.length >= 4 && portals.every(portal => portal.state === 'ready'),
      launchesAudited: [giteaLaunch, grafanaLaunch, jenkinsLaunch, opensearchLaunch]
        .every(launch => launch.status === 302 && /^\d+$/.test(launch.auditId ?? '')),
      giteaSsoIdentity: giteaIdentity.status === 200 && giteaIdentity.body?.login === 'alex',
      giteaRoleMapped: giteaIdentity.body?.is_admin === true,
      grafanaSsoIdentity: grafanaIdentity.user.status === 200 && grafanaIdentity.user.body?.login === 'alex',
      grafanaRoleMapped: grafanaIdentity.userOrgs.status === 200
        && currentGrafanaOrganization?.role === 'Admin',
      grafanaDashboardVisible,
      aiopsDatasourcesGoverned: grafanaIdentity.datasources.status === 200
        && ['prometheus', 'loki', 'jaeger'].every(type => grafanaIdentity.datasources.body?.some(item => item.type === type)),
      jenkinsSsoIdentity: jenkinsIdentity.identity.status === 200
        && jenkinsIdentity.identity.body?.name === 'alex'
        && jenkinsIdentity.identity.body?.authenticated === true,
      jenkinsProductionBuildVisible: jenkinsIdentity.job.status === 200
        && jenkinsIdentity.job.body?.name === 'checkout-api-production'
        && Number.isSafeInteger(jenkinsIdentity.job.body?.lastBuild?.number),
      opensearchSsoSession: opensearchUi.url.startsWith('http://localhost:5601/')
        && /opensearch|discover/i.test(`${opensearchUi.title} ${opensearchUi.text}`)
        && !/unauthorized|authentication exception/i.test(opensearchUi.text),
    },
  };
  const report = {
    ...payload,
    payloadSha256: digest(payload),
    passed: Object.values(payload.checks).every(Boolean),
  };
  writeFileSync(resolve(outputDirectory, 'backend-sso-browser-certification.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) throw new Error('Backend workforce SSO browser certification failed');
} finally {
  await context.close();
  await browser.close();
}
