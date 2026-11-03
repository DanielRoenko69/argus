import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { generateTotp, LOCAL_MFA_DEMO, LOCAL_MFA_DEVELOPER } from '../scripts/lib/localMfaDemo.mjs';
import { launchDemoBrowser } from '../scripts/lib/demo-browser.mjs';

const baseUrl = (process.env.ARGUS_MFA_DEMO_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const outputDirectory = resolve(import.meta.dirname, '..', 'test-results');
// Pin the browser scale so Windows display scaling cannot distort the visual
// certification screenshot even though the DOM layout itself is correct.
const browser = await launchDemoBrowser(chromium);
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const lastSubmittedTotp = new Map();

async function generateFreshTotp(identity) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const code = generateTotp({ secret: identity.totpSecret });
    if (code !== lastSubmittedTotp.get(identity.username)) {
      lastSubmittedTotp.set(identity.username, code);
      return code;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error('A fresh TOTP was not generated before the certification timeout');
}

async function submitKeycloakFactors(targetPage, identity) {
  await targetPage.waitForLoadState('domcontentloaded');
  const username = targetPage.locator('#username');
  const password = targetPage.locator('#password');
  const otp = targetPage.locator('#otp');
  if (await password.isVisible().catch(() => false)) {
    if (await username.isVisible().catch(() => false)) await username.fill(identity.username);
    await password.fill(identity.password);
    await targetPage.locator('#kc-login').click();
  }
  if (targetPage.url().startsWith(baseUrl)) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await otp.waitFor({ state: 'visible' });
    await otp.fill(await generateFreshTotp(identity));
    await targetPage.locator('#kc-login').click();
    const returnedToArgus = await targetPage.waitForURL(
      new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`),
      { timeout: 5_000 },
    ).then(() => true).catch(() => false);
    if (returnedToArgus) return;
    // The provider-side verification performed by `demo:mfa:up` can consume
    // the current one-time code immediately before this browser run. Keycloak
    // correctly rejects that replay, so wait for and submit the next code.
    if (!await otp.isVisible().catch(() => false)) break;
  }
  const providerMessages = await targetPage.locator('#input-error, .kc-feedback-text, [role="alert"]')
    .allTextContents().catch(() => []);
  throw new Error(`Keycloak did not accept the MFA factors: ${providerMessages.join(' ').trim() || targetPage.url()}`);
}

try {
  await page.goto(`${baseUrl}/login`);
  await page.getByRole('link', { name: /Argus MFA Demo/i }).click();
  await submitKeycloakFactors(page, LOCAL_MFA_DEMO);
  await page.waitForURL(new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));

  // Exercise the actual Argus step-up endpoint even if the initial SSO login
  // already produced a fresh assurance assertion.
  await page.goto(`${baseUrl}/auth/oidc/step-up?returnTo=${encodeURIComponent('/observe/audit?tab=reports')}`);
  await submitKeycloakFactors(page, LOCAL_MFA_DEMO);
  await page.waitForURL(`${baseUrl}/observe/audit?tab=reports`);
  const auditHeading = page.getByRole('heading', { name: 'Audit & evidence' });
  await auditHeading.waitFor({ state: 'visible', timeout: 30_000 });
  const reportsTab = page.getByRole('button', { name: 'Reports' });
  await reportsTab.waitFor({ state: 'visible' });

  const result = await page.evaluate(async () => {
    const [catalogResponse, identityResponse] = await Promise.all([
      fetch('/api/ui/audit/reports/v1', { headers: { accept: 'application/json' } }),
      fetch('/api/me/identity-security', { headers: { accept: 'application/json' } }),
    ]);
    const gateResponse = await fetch('/api/ui/audit/report-runs/v1', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ reportType: '__mfa_gate_probe__' }),
    });
    return {
      catalog: { status: catalogResponse.status, body: await catalogResponse.json() },
      identity: { status: identityResponse.status, body: await identityResponse.json() },
      gate: { status: gateResponse.status, body: await gateResponse.json() },
    };
  });
  const platformAdminConsole = await auditHeading.isVisible()
    && await reportsTab.getAttribute('class').then(value => value?.includes('is-active') ?? false);
  await page.goto(`${baseUrl}/settings/identity`);
  const identityHeading = page.getByRole('heading', { name: 'Sign-in & MFA' });
  await identityHeading.waitFor({ state: 'visible', timeout: 30_000 });
  const layout = await page.evaluate(() => {
    const rect = selector => {
      const element = document.querySelector(selector);
      const bounds = element?.getBoundingClientRect();
      return bounds ? { left: bounds.left, right: bounds.right, width: bounds.width } : null;
    };
    return {
      viewportWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
      sidebar: rect('.app-sidebar'),
      stage: rect('.app-stage'),
      content: rect('.app-content'),
      heading: rect('.page-heading'),
      mobileMenuVisible: getComputedStyle(document.querySelector('.mobile-menu-button')).display !== 'none',
    };
  });
  const checks = {
    reportCatalogAuthorized: result.catalog.status === 200,
    freshMfaSatisfied: result.catalog.body?.exportSecurity?.requiresFreshMfa === true
      && result.catalog.body?.exportSecurity?.satisfied === true,
    protectedReportActionAuthorized: result.gate.status === 422
      && result.gate.body?.error === 'reportType is invalid',
    platformAdminConsole,
    identitySecurityStatus: result.identity.status === 200
      && result.identity.body?.provider?.enabled === true
      && result.identity.body?.session?.ssoLinked === true
      && result.identity.body?.session?.mfaFresh === true
      && result.identity.body?.complianceReports?.ready === true,
    identitySecurityConsole: await identityHeading.isVisible()
      && await page.getByText('Fresh MFA verified', { exact: true }).first().isVisible(),
    identitySecurityLayout: layout.sidebar !== null
      && layout.heading !== null
      && layout.heading.left >= layout.sidebar.right
      && layout.mobileMenuVisible === false,
    selfServiceMfaManagement: await page.getByRole('link', { name: /Manage MFA at Argus MFA Demo/ }).isVisible(),
    organizationMfaPolicyManagement: await page.getByRole('link', { name: /Open identity-provider policy/ }).isVisible(),
  };
  mkdirSync(outputDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(outputDirectory, 'local-mfa-identity-security.png'),
    fullPage: true,
  });

  // A second real workforce identity proves that MFA assurance does not
  // silently grant platform-admin privileges. The developer may use Argus
  // Dev, workflows and governed MCP integrations, while report generation
  // remains denied by role even though the signed MFA assertion is fresh.
  const developerContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  const developerPage = await developerContext.newPage();
  await developerPage.goto(`${baseUrl}/login`);
  await developerPage.getByRole('link', { name: /Argus MFA Demo/i }).click();
  await submitKeycloakFactors(developerPage, LOCAL_MFA_DEVELOPER);
  await developerPage.waitForURL(new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
  const developerEvidence = await developerPage.evaluate(async () => {
    async function get(path, init) {
      const response = await fetch(path, { headers: { accept: 'application/json' }, ...init });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status, body };
    }
    const [me, identity, packs, workflows, fabric, reports, reportRun] = await Promise.all([
      get('/api/me'),
      get('/api/me/identity-security'),
      get('/api/ui/solution-packs'),
      get('/api/admin/workflows'),
      get('/api/ui/mcp-fabric'),
      get('/api/ui/audit/reports/v1'),
      get('/api/ui/audit/report-runs/v1', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ reportType: '__mfa_role_gate_probe__' }),
      }),
    ]);
    return { me, identity, packs, workflows, fabric, reports, reportRun };
  });
  const backendNames = (developerEvidence.fabric.body?.servers ?? [])
    .map(item => String(item.name ?? item.label ?? '').toLowerCase());
  const developerChecks = {
    developerRoleMapped: developerEvidence.me.status === 200
      && developerEvidence.me.body?.user?.role === 'developer',
    developerMfaVerified: developerEvidence.identity.status === 200
      && developerEvidence.identity.body?.session?.mfaFresh === true,
    argusDevAuthorized: developerEvidence.packs.status === 200
      && (developerEvidence.packs.body?.packs ?? []).some(pack => pack.configuredId === 'argus.dev'),
    workflowsAuthorized: developerEvidence.workflows.status === 200,
    governedIntegrationsAuthorized: developerEvidence.fabric.status === 200
      && backendNames.length > 0,
    repositoryOrCiIntegrationVisible: backendNames.some(name => /gitea|github|gitlab|jenkins/.test(name)),
    observabilityIntegrationVisible: backendNames.some(name => /loki|elastic|opensearch|grafana|prometheus|jaeger/.test(name)),
    reportCatalogReadable: developerEvidence.reports.status === 200,
    complianceReportsRoleDenied: developerEvidence.reportRun.status === 403,
  };
  const developerUiDiagnostics = {};
  await developerPage.goto(`${baseUrl}/solutions/argus.dev`);
  developerChecks.argusDevConsole = await developerPage.getByRole('heading', { name: /Argus.?Dev/i, level: 1 })
    .waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
  if (!developerChecks.argusDevConsole) {
    developerUiDiagnostics.argusDevUrl = developerPage.url();
    developerUiDiagnostics.argusDevText = (await developerPage.locator('body').innerText()).slice(0, 1_500);
    await developerPage.screenshot({ path: resolve(outputDirectory, 'local-sso-argus-dev-failure.png'), fullPage: true });
  }
  await developerPage.goto(`${baseUrl}/build/workflows`);
  developerChecks.workflowConsole = await developerPage.getByRole('heading', { name: 'Workflows', level: 1 })
    .waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
  await developerPage.goto(`${baseUrl}/mcp-fabric`);
  developerChecks.mcpFabricConsole = await developerPage.getByRole('heading', { name: 'MCP Fabric', level: 1 })
    .waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
  await developerPage.goto(`${baseUrl}/settings/identity`);
  await developerPage.getByRole('heading', { name: 'Sign-in & MFA' }).waitFor({ state: 'visible' });
  await developerPage.screenshot({
    path: resolve(outputDirectory, 'local-sso-developer-access.png'),
    fullPage: true,
  });
  await developerContext.close();
  await page.goto(`${baseUrl}/settings/users`);
  await page.getByRole('heading', { name: 'Users & Roles' }).waitFor({ state: 'visible' });
  // Keycloak subjects are stable in the checked-in realm. Selecting the most
  // recent card also keeps this certification useful against older local demo
  // databases that still contain identities from pre-stability test runs.
  const developerCard = page.locator('.user-admin-card').filter({ hasText: 'Argus MFA Developer' }).last();
  checks.adminSeesDeveloperSso = await developerCard.getByText('SSO linked', { exact: true }).isVisible().catch(() => false);
  checks.adminSeesDeveloperMfa = await developerCard.getByText('MFA observed', { exact: true }).isVisible().catch(() => false);
  await page.screenshot({
    path: resolve(outputDirectory, 'local-sso-user-assurance.png'),
    fullPage: true,
  });
  const report = {
    schema: 'argus.local-sso-mfa-browser-certification.v2',
    generatedAt: new Date().toISOString(),
    passed: Object.values(checks).every(Boolean) && Object.values(developerChecks).every(Boolean),
    baseUrl,
    finalUrl: page.url(),
    layout,
    checks,
    developer: {
      username: LOCAL_MFA_DEVELOPER.username,
      visibleBackends: backendNames,
      apiStatus: Object.fromEntries(Object.entries(developerEvidence).map(([name, value]) => [name, value.status])),
      apiErrors: Object.fromEntries(Object.entries(developerEvidence)
        .filter(([, value]) => value.status >= 400)
        .map(([name, value]) => [name, value.body?.error ?? value.body?.code ?? null])),
      uiDiagnostics: developerUiDiagnostics,
      checks: developerChecks,
    },
  };
  writeFileSync(resolve(outputDirectory, 'local-mfa-browser-certification.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) throw new Error('Browser MFA certification failed');
} finally {
  await context.close();
  await browser.close();
}
