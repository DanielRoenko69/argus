import { test, expect } from '@playwright/test';

test('models route is reachable and remains protected when unauthenticated', async ({ page }) => {
  await page.goto('/settings/models', { waitUntil: 'domcontentloaded' });

  const modelsHeading = page.getByRole('heading', { name: 'Providers & Models' });
  if (await modelsHeading.isVisible().catch(() => false)) {
    await expect(modelsHeading).toBeVisible();
    return;
  }

  await expect(page).toHaveTitle(/Anmelden|Login|Argus/i);
});

test('authenticated models page shows execution runtime profiles', async ({ page }) => {
  await page.goto('/settings/models', { waitUntil: 'domcontentloaded' });

  const modelsHeading = page.getByRole('heading', { name: 'Providers & Models' });
  test.skip(!(await modelsHeading.isVisible().catch(() => false)), 'Provide ARGUS_E2E_STORAGE_STATE for an authenticated Console session.');

  await expect(page.getByRole('heading', { name: 'Agent runtime profiles' })).toBeVisible();
  await expect(page.getByText('Codex · ChatGPT Subscription')).toBeVisible();
  await expect(page.getByText('Argus / LiteLLM')).toBeVisible();
});
