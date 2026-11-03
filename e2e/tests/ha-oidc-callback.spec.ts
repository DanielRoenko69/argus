import { test, expect } from '@playwright/test';

const primary = (process.env.ARGUS_HA_PRIMARY_BASE_URL || 'http://argus-a:3000').replace(/\/$/, '');
const secondary = (process.env.ARGUS_HA_SECONDARY_BASE_URL || 'http://argus-b:3000').replace(/\/$/, '');

test('OIDC state created on replica A is consumed on B and rejects replay', async ({ page, context }) => {
  test.skip(process.env.ARGUS_HA_OIDC !== '1', 'HA OIDC journey is opt-in.');
  test.setTimeout(120_000);

  await page.goto(`${primary}/login`);
  const registrationHeading = page.getByRole('heading', { name: 'Ersten Administrator anlegen' });
  if (await registrationHeading.count()) {
    await page.locator('#username').fill('ha-bootstrap-admin');
    await page.locator('#display_name').fill('Argus HA Bootstrap');
    await page.locator('#password').fill('ArgusHa42!');
    await page.locator('#password_confirm').fill('ArgusHa42!');
    await Promise.all([
      page.waitForURL(`${primary}/home`),
      page.getByRole('button', { name: 'Registrieren' }).click(),
    ]);
    // Stop the authenticated SPA before clearing its cookie. Otherwise its
    // background 401 handler can race the next explicit navigation to /login.
    await page.goto('about:blank');
    await context.clearCookies();
  }

  await page.goto(`${primary}/login`);
  await page.getByRole('link', { name: 'Mit Keycloak anmelden' }).click();
  await expect(page.locator('#username')).toBeVisible();
  await page.locator('#username').fill('argus-developer');
  await page.locator('#password').fill('ArgusE2e42!');
  await page.locator('#kc-login').click();
  await expect(page).toHaveURL(/^http:\/\/callback-capture:9999\/auth\/oidc\/callback\?/);
  const callbackCaptureUrl = await page.url();
  expect(callbackCaptureUrl).toContain('callback-capture:9999/auth/oidc/callback?');

  // The authorization code was issued after a state created by A. Sending the
  // untouched pair to B proves SESSION_SECRET/Redis make the callback replica-safe.
  const captured = new URL(callbackCaptureUrl);
  const callbackOnB = new URL(`${secondary}/auth/oidc/callback`);
  callbackOnB.search = captured.search;
  // The callback is bound to the browser that started the login. Real replicas
  // share one public hostname; these fixtures use two, so carry the binding
  // cookie from A to B as the shared hostname would.
  const binding = (await context.cookies()).find(cookie => cookie.name === 'argus_oidc_binding'
    && cookie.domain === new URL(primary).hostname);
  expect(binding).toBeTruthy();
  await context.addCookies([{ ...binding!, domain: new URL(secondary).hostname }]);
  await page.goto(callbackOnB.toString());
  await expect(page).toHaveURL(`${secondary}/home`);
  const me = await page.evaluate(async () => {
    const response = await fetch('/api/me');
    return response.json() as Promise<{ user: { role: string; username: string } }>;
  });
  expect(me.user.role).toBe('developer');
  expect(me.user.username).toMatch(/^oidc:/);

  // Redis NX consumption makes the exact callback one-shot, even on B.
  await page.goto(callbackOnB.toString());
  await expect(page.getByText('Keycloak-Anmeldung fehlgeschlagen. Bitte erneut versuchen.')).toBeVisible();
});
