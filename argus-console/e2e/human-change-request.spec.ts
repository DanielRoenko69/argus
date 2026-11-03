import { expect, test } from '@playwright/test';

type CodingThread = {
  thread_id: string;
  metadata?: Record<string, unknown>;
  values?: Record<string, unknown>;
};

test('human change request remains visible in the control plane and run detail after reload', async ({ page }) => {
  await page.goto('/solutions/argus.dev', { waitUntil: 'domcontentloaded' });
  const loginPage = /\/login(?:$|\?)/.test(page.url());
  test.skip(loginPage, 'Provide ARGUS_E2E_STORAGE_STATE for an authenticated Console session.');

  const threads = await page.evaluate(async () => {
    const response = await fetch('/api/coding/threads');
    if (!response.ok) return [] as CodingThread[];
    const payload = await response.json() as { threads?: CodingThread[] } | CodingThread[];
    return Array.isArray(payload) ? payload : payload.threads ?? [];
  });
  const thread = threads.find(candidate => typeof candidate.values?.['human_change_request'] === 'string'
    && String(candidate.values['human_change_request']).trim());
  test.skip(!thread, 'No persisted Argus Dev human change request is available.');

  const request = String(thread!.values?.['human_change_request']).trim();
  const taskId = typeof thread!.metadata?.['a2a_task_id'] === 'string'
    ? String(thread!.metadata['a2a_task_id'])
    : thread!.thread_id;

  await page.goto(`/solutions/argus.dev?task=${encodeURIComponent(taskId)}`, { waitUntil: 'domcontentloaded' });
  const dialog = page.getByRole('dialog', { name: /Argus Dev run/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Human change request')).toContainText(request);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('dialog', { name: /Argus Dev run/ }).getByLabel('Human change request')).toContainText(request);

  await page.goto(`/runs/workflow/${encodeURIComponent(thread!.thread_id)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Human change request')).toContainText(request);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Human change request')).toContainText(request);
});
