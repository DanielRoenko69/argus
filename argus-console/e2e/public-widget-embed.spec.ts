import { expect, test } from '@playwright/test';

test('public widget page renders its persisted Argus branding without embed overrides', async ({ request }) => {
  const response = await request.get('http://localhost:3000/public/widget/argus-public-demo');
  expect(response.ok()).toBe(true);
  const html = await response.text();
  expect(html).toContain('<title>Ask Argus</title>');
  expect(html).toContain('Hi! Ask me what Argus, Argus Dev or Argus AIOps can do.');
  expect(html).toContain('placeholder="Ask Argus a question..."');
});

for (const websiteUrl of ['http://localhost:4173', 'http://127.0.0.1:4173']) {
test(`external product page embeds the governed public Argus assistant from ${websiteUrl}`, async ({ page }) => {
  await page.goto(websiteUrl, { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { name: /Build agents/ })).toBeVisible();
  await expect(page.getByText('A real public Argus agent')).toBeVisible();

  const launcher = page.getByRole('button', { name: 'Ask Argus' });
  await expect(launcher).toBeVisible();
  await expect(launcher.locator('img')).toHaveAttribute('src', `${websiteUrl}/argus-mark.svg`);
  await launcher.click();

  const frame = page.locator('iframe[title="Ask Argus"]');
  await expect(frame).toBeVisible();
  const frameUrl = new URL(await frame.getAttribute('src') ?? '');
  expect(`${frameUrl.origin}${frameUrl.pathname}`).toBe('http://localhost:3000/public/widget/argus-public-demo');
  expect(frameUrl.searchParams.get('accent')).toBe('#8b5cf6');
  expect(frameUrl.searchParams.get('title')).toBe('Ask Argus');
  const publicChat = page.frameLocator('iframe[title="Ask Argus"]');
  await expect(publicChat.locator('#chatMessages')).toBeVisible();
  await expect(publicChat.getByText('Hi! Ask me what Argus, Argus Dev or Argus AIOps can do.')).toBeVisible();
  await expect(publicChat.locator('#chatInput')).toHaveAttribute('placeholder', 'Ask Argus a question...');
  await expect(publicChat.locator('#settingsToggleBtn')).toHaveCount(0);
  await expect(publicChat.locator('.chat-header-actions')).toHaveCount(0);
});
}
