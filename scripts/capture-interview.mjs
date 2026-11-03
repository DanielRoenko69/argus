import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '../argus-console/node_modules/playwright/index.mjs';

const root = process.cwd();
const outputDir = path.resolve(root, 'demo/interview-assets');
const storageState = process.env.ARGUS_E2E_STORAGE_STATE;

if (!storageState) {
  throw new Error(
    'Set ARGUS_E2E_STORAGE_STATE to a Playwright storage-state JSON created after logging into Argus.',
  );
}

await fs.mkdir(path.join(outputDir, 'video'), { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: path.resolve(root, storageState),
  viewport: { width: 1600, height: 1000 },
  colorScheme: 'dark',
  recordVideo: { dir: path.join(outputDir, 'video'), size: { width: 1600, height: 1000 } },
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);

const routes = [
  ['01-home.png', '/home'],
  ['02-mcp-fabric.png', '/mcp-fabric'],
  ['03-agent-studio.png', '/build/agents'],
  ['04-models.png', '/settings/models'],
  ['05-runs.png', '/runs'],
  ['06-observe.png', '/observe'],
];

for (const [filename, route] of routes) {
  await page.goto(`http://localhost:3000${route}`, { waitUntil: 'domcontentloaded' });
  if (new URL(page.url()).pathname === '/login') {
    throw new Error(`Storage state is not authenticated; redirected to /login while opening ${route}.`);
  }
  await page.waitForTimeout(1_500);
  // The runs page can contain hundreds of historical rows. A full-page image
  // makes those rows unreadable in a README, so keep that one at the interview
  // viewport while retaining full-page captures for the overview pages.
  await page.screenshot({ path: path.join(outputDir, filename), fullPage: route !== '/runs' });
}

await page.goto('http://localhost:3000/home', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1_000);
await page.close();
await context.close();
await browser.close();

console.log(`Interview screenshots written to ${outputDir}`);
console.log('The recorded WebM is in demo/interview-assets/video/.');
