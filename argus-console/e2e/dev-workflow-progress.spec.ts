import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createServer as createViteServer } from 'vite';
import { developmentWorkflow, workspaceQaEvidence } from '../src/test-fixtures/developmentWorkflow';

// Browser layout tests use the real component and Console CSS, without login,
// model calls, live API mutations or restarting the running development stack.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
let vite: ViteDevServer;
let DevWorkflowProgress: typeof import('../src/pages/DevWorkflowProgress')['DevWorkflowProgress'];

test.beforeAll(async () => {
  // Playwright's test transform represents JSX imported directly by a spec as
  // serializable component-test objects. Load the production component through
  // Vite's SSR pipeline so ReactDOM receives real React elements instead.
  vite = await createViteServer({
    appType: 'custom',
    configFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    root: process.cwd(),
    server: { middlewareMode: true, hmr: false },
  });
  ({ DevWorkflowProgress } = await vite.ssrLoadModule('/src/pages/DevWorkflowProgress.tsx'));
});
test.afterAll(async () => { await vite?.close(); });

test.use({
  storageState: { cookies: [], origins: [] }, video: 'off',
  ...(process.env['ARGUS_E2E_EXECUTABLE_PATH'] ? { launchOptions: { executablePath: process.env['ARGUS_E2E_EXECUTABLE_PATH'] } } : {}),
});
for (const theme of ['dark', 'light']) {
  for (const width of [390, 900, 1440]) {
    test(`compact workflow: ${theme}, ${width}px, keyboard details without overlap`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const markup = renderToStaticMarkup(createElement(DevWorkflowProgress, {
        workflow: developmentWorkflow, state: 'TASK_STATE_WORKING',
        evidence: { currentStage: 'technical_investigation', qaAcceptance: workspaceQaEvidence },
      }));
      await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body>
        <main style="margin:16px; padding:16px; background:var(--surface)">
        <div class="solution-detail-flow">${markup}</div></main></body></html>`);
      const phases = page.getByRole('list', { name: 'Workflow phases' });
      await expect(phases.locator(':scope > li')).toHaveCount(7);
      await expect(page.getByRole('status')).toContainText('Preparation · Technical investigation');
      const details = page.locator('.dev-workflow-steps');
      await expect(details).not.toHaveAttribute('open');
      await expect(page.getByText('Technical investigation budget', { exact: true })).not.toBeVisible();
      await page.locator('.dev-workflow-steps > summary').focus();
      await page.keyboard.press('Enter');
      await expect(details).toHaveAttribute('open');
      await expect(page.getByText('Technical investigation budget', { exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Conditional input steps' })).toBeVisible();
      const layout = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.dev-workflow-phases > li')];
        const overlap = cards.some((a, index) => cards.slice(index + 1).some(b => {
          const x = a.getBoundingClientRect(); const y = b.getBoundingClientRect();
          return x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top;
        }));
        const overflow = [...document.querySelectorAll('.dev-workflow-phases li, .dev-workflow-phases li div, .dev-workflow-step-groups li')]
          .some(element => element.scrollWidth > element.clientWidth + 1);
        return { overlap, overflow, pageOverflow: document.documentElement.scrollWidth > window.innerWidth };
      });
      expect(layout).toEqual({ overlap: false, overflow: false, pageOverflow: false });
      await page.screenshot({ path: testInfo.outputPath('expanded.png'), fullPage: true });
      await page.keyboard.press('Space');
      await expect(details).not.toHaveAttribute('open');
      await page.screenshot({ path: testInfo.outputPath('compact.png'), fullPage: true });
    });
  }
}
