import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Exercises the shared responsive primitives that previously pushed complete
// admin pages beyond the viewport. This fixture is credential-free and uses
// the production Console stylesheet in every supported theme and breakpoint.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test.use({
  storageState: { cookies: [], origins: [] },
  video: 'off',
  ...(process.env['ARGUS_E2E_EXECUTABLE_PATH']
    ? { launchOptions: { executablePath: process.env['ARGUS_E2E_EXECUTABLE_PATH'] } }
    : {}),
});

const fixture = `
  <main class="app-content">
    <header class="page-heading">
      <div><span class="eyebrow">OPERATE</span><h1>Responsive release gate</h1><p>Representative admin actions and evidence tables.</p></div>
      <div class="page-actions">
        <button class="button button-secondary">Bundle Sets</button>
        <button class="button button-secondary">Connector templates</button>
        <button class="button button-secondary">Browse catalog</button>
        <button class="button button-primary">Create new capability</button>
      </div>
    </header>
    <div class="connection-notice">
      <span>Agents use pinned Skill versions. Existing assignments remain immutable.</span>
      <a class="button button-secondary" href="#versions">Compare &amp; release Skill versions</a>
    </div>
    <section class="panel table-panel capability-studio-panel">
      <div class="capability-studio-table">
        <div class="data-row capability-studio-row">
          <span>aiops_kubernetes_get_cluster_configuration</span><span>remote</span><span>read</span><span>operations</span><span>healthy</span>
        </div>
      </div>
    </section>
    <section class="observe-traces">
      <div class="panel table-panel">
        <div class="data-table observe-trace-table">
          <div class="data-row data-head"><span>Execution</span><span>Status</span><span>Duration</span><span>Risk</span><span>Updated</span></div>
          <a class="data-row" href="#trace"><div class="table-primary"><span><b>Showcase FastAPI follow-up</b><small>workflow · immutable evidence</small></span></div><span>Completed</span><span>2m 14s</span><span class="trace-risk trace-risk-low">low</span><time>now</time></a>
        </div>
      </div>
    </section>
    <section class="panel table-panel">
      <div class="data-table log-table">
        <div class="data-row data-head"><span>Time</span><span>Level</span><span>Event</span><span>Source</span><span>Correlation</span></div>
        <div class="data-row"><time>now</time><span class="log-level log-info">info</span><div class="log-message"><span><b>Workflow checkpoint recovered</b><small>platform event</small></span></div><span>argus</span><div class="log-correlation-id"><span>Trace —</span><code>No child ID</code></div></div>
      </div>
    </section>
  </main>`;

for (const theme of ['dark', 'light']) {
  for (const width of [390, 900, 1440]) {
    test(`shared shell: ${theme}, ${width}px has no page overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body>${fixture}</body></html>`);

      const layout = await page.evaluate(() => {
        const actions = document.querySelector('.page-actions')!;
        const notice = document.querySelector('.connection-notice')!;
        const trace = document.querySelector('.observe-trace-table .data-row:not(.data-head)')!;
        const log = document.querySelector('.log-table .data-row:not(.data-head)')!;
        const capabilityTable = document.querySelector('.capability-studio-table')!;
        return {
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          actionsRight: Math.round(actions.getBoundingClientRect().right),
          noticeRight: Math.round(notice.getBoundingClientRect().right),
          actionLayout: getComputedStyle(actions).display,
          noticeDirection: getComputedStyle(notice).flexDirection,
          traceColumns: getComputedStyle(trace).gridTemplateColumns.split(' ').length,
          logColumns: getComputedStyle(log).gridTemplateColumns.split(' ').length,
          logContained: log.scrollWidth <= log.clientWidth,
          capabilityContained: capabilityTable.scrollWidth > capabilityTable.clientWidth
            ? ['auto', 'scroll'].includes(getComputedStyle(capabilityTable).overflowX)
            : true,
        };
      });

      expect(layout.pageOverflow).toBe(false);
      expect(layout.actionsRight).toBeLessThanOrEqual(width);
      expect(layout.noticeRight).toBeLessThanOrEqual(width);
      expect(layout.capabilityContained).toBe(true);
      if (width === 390) {
        expect(layout.actionLayout).toBe('grid');
        expect(layout.noticeDirection).toBe('column');
        expect(layout.traceColumns).toBe(2);
        expect(layout.logColumns).toBe(3);
        expect(layout.logContained).toBe(true);
      }
    });
  }
}
