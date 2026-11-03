import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

// Built Console, isolated fixture API: no real credentials or live key creation.
let server: Server;
let origin: string;
test.use({ storageState: { cookies: [], origins: [] }, video: 'off',
  ...(process.env.ARGUS_E2E_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.ARGUS_E2E_EXECUTABLE_PATH } } : {}),
});
test.beforeAll(async () => {
  const dist = resolve('dist');
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://fixture').pathname;
    const asset = /^\/console-assets\/assets\/([\w.-]+\.(?:js|css))$/.exec(path);
    if (path !== '/settings/api-keys' && !asset) { res.writeHead(404).end(); return; }
    const file = asset ? `assets/${asset[1]}` : 'index.html';
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(readFileSync(resolve(dist, file)));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { await new Promise<void>(done => server.close(() => done())); });

for (const theme of ['dark', 'light']) for (const width of [390, 1440]) {
  test(`API key identity: ${theme}, ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(value => localStorage.setItem('argus-theme', value), theme);
    let created: Record<string, unknown> | undefined;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown = {};
      if (path === '/api/me') data = { user: { id: 3, username: 'alex', display_name: 'Alex Fixture', role: 'platform_admin' } };
      else if (path === '/api/ui/navigation-capabilities') data = { navigation: { canAdminPlatform: true }, modules: [], permissions: [] };
      else if (path === '/api/ui/mcp-fabric') data = { bundles: [] };
      else if (path === '/api/admin/api-keys/binding-targets') data = [{ id: 3, username: 'alex', display_name: 'Alex Fixture', role: 'platform_admin', is_self: true }];
      else if (path === '/api/admin/api-keys' && route.request().method() === 'GET') data = [];
      else if (path === '/api/admin/api-keys' && route.request().method() === 'POST') {
        created = route.request().postDataJSON();
        data = { id: 1, label: 'Fixture chat', api_key: 'fixture-not-a-real-secret' };
      } else { await route.fulfill({ status: 404, json: {} }); return; }
      await route.fulfill({ json: data });
    });
    await page.goto(`${origin}/settings/api-keys`);
    await page.getByRole('button', { name: 'Create API key' }).click();
    await page.getByRole('textbox', { name: /Label/ }).fill('Fixture chat');
    const submit = page.getByRole('button', { name: 'Generate API key' });
    await expect(submit).toBeDisabled();
    const identity = page.getByRole('combobox', { name: /Act as identity/ });
    await identity.selectOption('3');
    await expect(submit).toBeEnabled();
    await identity.focus();
    await page.screenshot({ path: testInfo.outputPath('user-identity.png'), fullPage: true });
    expect(await page.locator('.api-key-editor').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await submit.click();
    expect(created).toMatchObject({ acting_as_user_id: 3, allowed_bundles: [], scope: 'mcp' });
    await expect(page.getByRole('button', { name: 'Close one-time secret' })).toBeDisabled();
    await expect(page.getByText('fixture-not-a-real-secret')).toBeVisible();
  });
}
