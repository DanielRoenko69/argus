import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir,readFile } from 'node:fs/promises';

/** No real credentials, provider calls or production-state mutations. Run via the disposable authoring gate. */
export async function certifyBrowser({ base,datasetId,modelPrefix,check,requests,curation,quality }) {
  const { chromium,expect }=createRequire(resolve('argus-console/package.json'))('@playwright/test');
  const browser=await chromium.launch({ headless:true,...(process.env.EVALUATION_BROWSER_CHANNEL ? { channel:process.env.EVALUATION_BROWSER_CHANNEL } : process.platform==='win32' ? { channel:'msedge' } : {}) });
  const context=await browser.newContext({ viewport:{ width:1440,height:1050 },reducedMotion:'reduce' });
  const page=await context.newPage(),errors=[];
  page.setDefaultTimeout(12000); page.setDefaultNavigationTimeout(15000);
  page.on('pageerror',e => errors.push(e.message));
  await context.route('**/*',route => new URL(route.request().url()).origin===base ? route.continue() : route.abort());
  await mkdir('test-results',{ recursive:true });
  try {
    const qualityResponse=page.waitForResponse(r=>r.url()===base+'/api/admin/evaluations/review-queue/'+quality.traceId);
    await page.goto(base+'/observe/quality?trace='+quality.traceId);
    await check('browser reviews Quality Inbox evidence with provenance and responsive layout, without inference',async () => {
      const response=await qualityResponse,body=await response.json();
      assert.equal(response.status(),200,JSON.stringify(body));
      assert.equal(body.item?.review_stale,true,JSON.stringify(body));
      await expect(page.getByRole('heading',{ name:'Quality Inbox',exact:true })).toBeVisible();
      await expect(page.getByText(/Evidence changed since the last review/)).toBeVisible({ timeout:15000 });
      const detail=page.getByRole('region',{ name:'Selected evidence' });
      await expect(detail.getByRole('button',{ name:'Save review' })).toBeDisabled();
      await detail.getByLabel('Verdict',{ exact:true }).selectOption('confirmed_issue');
      await detail.getByLabel('Review status',{ exact:true }).selectOption('resolved');
      await detail.getByLabel('Reason / next action').fill('Reviewed synthetic CI evidence; regression case linked separately.');
      await page.getByRole('heading',{ name:'Quality Inbox',exact:true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path:'test-results/quality-inbox-dark.png',fullPage:true });
      await page.getByRole('button',{ name:'Use light theme' }).click();
      await page.screenshot({ path:'test-results/quality-inbox-light.png',fullPage:true });
      await page.getByRole('button',{ name:'Use dark theme' }).click();
      await page.setViewportSize({ width:390,height:844 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
      await page.screenshot({ path:'test-results/quality-inbox-mobile.png',fullPage:true });
      await page.setViewportSize({ width:1440,height:1050 });
      await detail.getByRole('button',{ name:'Save review' }).click();
      await expect(page.getByText('Review saved and audited.',{ exact:true })).toBeVisible();
      await expect(detail.getByText('Reviewed synthetic CI evidence; regression case linked separately.',{ exact:true })).toBeVisible();
      await detail.getByRole('button',{ name:'Add as test case',exact:true }).click();
      await expect(page.getByRole('dialog',{ name:'Add trace as test case' })).toBeVisible();
      await page.keyboard.press('Escape');
      assert.equal(requests.length,0);
    });
    await page.goto(base+'/build/evaluations');
    await check('browser previews and imports both starter sets as drafts, without model calls',async () => {
      for (const domain of ['Dev','AIOps']) {
        await page.getByRole('button',{ name:`Review ${domain} starter set`,exact:true }).click();
        const dialog=page.getByRole('dialog',{ name:'Review starter test set' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button',{ name:'Import 12 cases as draft' })).toBeDisabled();
        assert.equal(await dialog.locator('.evaluation-case-list > details').count(),12);
        await dialog.locator('.evaluation-case-list > details').first().locator('summary').first().click();
        await page.screenshot({ path:`test-results/evaluation-starter-${domain.toLowerCase()}.png` });
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('button',{ name:'Import 12 cases as draft' }).click();
        await expect(dialog).not.toBeVisible();
        await expect(page.getByRole('button',{ name:`Open imported ${domain} set` })).toBeVisible();
        assert.equal(requests.length,0);
      }
    });
    await check('browser turns a trace into a reviewed case with independent expectations and provenance',async () => {
      await page.goto(base+'/runs/agent/'+curation.traceId);
      const button=page.getByRole('button',{ name:'Add as test case',exact:true });
      await button.click(); const dialog=page.getByRole('dialog',{ name:'Add trace as test case' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Destination draft test set').selectOption(String(datasetId));
      assert.ok((await dialog.getByLabel('Task',{ exact:true }).inputValue()).includes('[REDACTED]'));
      assert.ok(!(await dialog.textContent()).includes('fixture-password'));
      await expect(dialog.getByLabel('Expected answer / reviewer notes (optional)',{ exact:true })).toHaveValue('');
      await dialog.getByLabel('Case name',{ exact:true }).fill('ci-trace-review');
      await dialog.getByLabel('Task',{ exact:true }).fill('Summarize the checkout incident.');
      await dialog.getByLabel('Reference context (optional)',{ exact:true }).fill('checkout is unavailable');
      await dialog.getByLabel('Expected value 1',{ exact:true }).fill('checkout');
      await expect(dialog.getByRole('button',{ name:'Save reviewed test case' })).toBeDisabled();
      // Exercise mobile sizing before save, then restore desktop for the rest of the gate.
      await page.setViewportSize({ width:390,height:844 });
      await expect.poll(() => dialog.evaluate(d => d.scrollWidth<=d.clientWidth+1)).toBe(true);
      await page.screenshot({ path:'test-results/evaluation-trace-curation-mobile.png' });
      await page.setViewportSize({ width:1440,height:1050 });
      await dialog.getByRole('checkbox').check();
      await page.screenshot({ path:'test-results/evaluation-trace-curation.png' });
      // This case lives in a separate draft so the existing two-call comparison stays unchanged.
      await dialog.getByText('Create a new empty draft',{ exact:true }).click();
      await dialog.getByLabel('New draft name').fill('Browser trace checks');
      await dialog.getByRole('button',{ name:'Create empty draft' }).click();
      await expect(dialog.getByLabel('Task',{ exact:true })).toHaveValue(/Review the failed Jenkins/);
      await dialog.getByLabel('Case name',{ exact:true }).fill('ci-trace-review');
      await dialog.getByLabel('Expected answer / reviewer notes (optional)').fill('Human reference: not ready to merge');
      await dialog.getByLabel('Expected value 1',{ exact:true }).fill('Not ready');
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button',{ name:'Save reviewed test case' }).click();
      const link=dialog.getByRole('link',{ name:'Open test set' }); await expect(link).toBeVisible();
      await link.click();
      await expect(page.getByRole('heading',{ name:'Browser trace checks' })).toBeVisible();
      await page.getByText('ci-trace-review',{ exact:true }).click();
      await expect(page.getByRole('link',{ name:'Open source trace',exact:true })).toHaveAttribute('href',`/observe/logs?trace=${curation.traceId}`);
      assert.equal(requests.length,0);
      await page.goto(base+'/build/evaluations');
    });
    await check('browser authors and activates a real dataset with guided criteria',async () => {
      await page.getByRole('button',{ name:/Browser incident checks/ }).first().click();
      await page.getByLabel('Case name',{ exact:true }).fill('checkout-outage');
      await page.getByLabel('Task',{ exact:true }).fill('Name the affected service.');
      await page.getByLabel('Reference context (optional)',{ exact:true }).fill('checkout is unavailable');
      await page.getByLabel('Expected answer / reviewer notes (optional)',{ exact:true }).fill('Human reference: checkout');
      await page.getByLabel('Expected value 1',{ exact:true }).fill('checkout');
      await page.getByRole('button',{ name:'Add case',exact:true }).click();
      await expect(page.getByText('Evaluation case added.',{ exact:true })).toBeVisible();
      await page.getByRole('button',{ name:'Activate dataset',exact:true }).click();
      await expect(page.getByText('Dataset “Browser incident checks” is active.',{ exact:true })).toBeVisible();
      assert.equal(requests.length,0);
    });
    const open=page.getByRole('button',{ name:'New paired comparison',exact:true });
    await check('native dialog traps focus, escapes and returns keyboard focus',async () => {
      await open.click();
      const dialog=page.getByRole('dialog',{ name:'Create comparison' });
      await expect(dialog).toBeVisible();
      for (let i=0;i<18;i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('dialog')),true); }
      await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(open).toBeFocused();
    });
    await check('browser reviews effective targets before save, starts explicitly and shows A/B criteria',async () => {
      await open.click(); const dialog=page.getByRole('dialog',{ name:'Create comparison' });
      await dialog.getByLabel('Comparison name',{ exact:true }).fill('Incident quality · Reference vs candidate');
      await dialog.getByLabel('Comparison dataset').selectOption(String(datasetId));
      await dialog.getByLabel('A · Baseline API model').selectOption(modelPrefix+'baseline');
      await dialog.getByLabel('B · Candidate API model').selectOption(modelPrefix+'candidate');
      await dialog.getByRole('button',{ name:'Check comparison',exact:true }).click();
      await expect(dialog.getByRole('heading',{ name:'Review model comparison' })).toBeVisible();
      await expect(dialog.getByText('2 planned provider requests',{ exact:true })).toBeVisible();
      assert.equal(requests.length,0);
      await page.screenshot({ path:'test-results/evaluation-ui-review-dark.png' });
      await dialog.getByRole('button',{ name:'Save comparison',exact:true }).click();
      await expect(dialog).not.toBeVisible();
      const paired=page.getByRole('region',{ name:'Paired comparisons' });
      await expect(paired.getByRole('button',{ name:'Start comparison',exact:true })).toBeDisabled();
      assert.equal(requests.length,0);
      await paired.getByRole('checkbox',{ name:/I authorize 2 new provider requests/ }).check();
      await paired.getByRole('button',{ name:'Start comparison',exact:true }).click();
      const answers=paired.getByRole('region',{ name:'Answers side by side' });
      const baseline=answers.getByRole('article',{ name:'A · Baseline answer' });
      const candidate=answers.getByRole('article',{ name:'B · Candidate answer' });
      await expect(baseline.getByText('checkout unavailable',{ exact:true })).toBeVisible({ timeout:20000 });
      await expect(candidate.getByText('Unknown service',{ exact:true })).toBeVisible({ timeout:20000 });
      await expect(baseline.getByText('Passed',{ exact:true })).toBeVisible();
      await expect(candidate.getByText('Failed',{ exact:true })).toBeVisible();
      await expect(candidate.getByRole('link',{ name:'Open correlated trace logs' })).toHaveAttribute('href',/^\/observe\/logs\?trace=/);
      assert.equal(requests.length,2);
      assert.ok(requests.every(r => !JSON.stringify(r.messages).includes('Human reference:')));
      await answers.scrollIntoViewIfNeeded();
      await page.screenshot({ path:'test-results/evaluation-ui-answers-dark.png' });
    });
    await check('browser exports real PDF/JSON/CSV, handles MFA and restores the selected comparison after reload',async () => {
      const exports=page.getByRole('region',{ name:'Comparison exports' });
      await exports.scrollIntoViewIfNeeded();
      await context.setExtraHTTPHeaders({ 'X-Fixture-Mfa':'stale' });
      await exports.getByRole('button',{ name:'Download PDF' }).click();
      await expect(exports.getByRole('link',{ name:'Confirm MFA and return to comparison' })).toHaveAttribute('href',/^\/auth\/oidc\/step-up\?returnTo=%2Fbuild%2Fevaluations%3Fcomparison%3D\d+$/);
      await context.setExtraHTTPHeaders({});
      for(const format of ['pdf','json','csv']) {
        const ready=page.waitForEvent('download');
        await exports.getByRole('button',{ name:'Download '+format.toUpperCase() }).click();
        const download=await ready;assert.match(download.suggestedFilename(),new RegExp(`^argus-evaluation-\\d+-[a-f0-9]{12}\\.${format}$`));
        const file=`test-results/evaluation-browser.${format}`;await download.saveAs(file);assert.equal(await download.failure(),null);
        const content=await readFile(file,'utf8');
        if(format==='pdf') assert.ok(content.startsWith('%PDF-'));
        else if(format==='json') { const doc=JSON.parse(content);assert.equal(doc.schema_version,'argus.evaluation.comparison-export.v1');assert.equal(doc.payload.summary.comparison_state,'failed'); }
        else { assert.ok(content.startsWith('\uFEFF'));assert.equal(content.split('\r\n').filter(Boolean).length,3); }
      }
      assert.match(page.url(),/comparison=\d+/);await page.reload();
      await expect(page.getByRole('article',{ name:'B · Candidate answer' }).getByText('Unknown service',{ exact:true })).toBeVisible();
      assert.equal(requests.length,2);
      await exports.scrollIntoViewIfNeeded();await page.screenshot({ path:'test-results/evaluation-ui-exports.png' });
    });
    await check('dark/light and narrow layouts keep the comparison usable without horizontal overflow',async () => {
      await page.getByRole('button',{ name:'Use light theme' }).click();
      const answers=page.getByRole('region',{ name:'Answers side by side' });
      await answers.scrollIntoViewIfNeeded();
      await page.screenshot({ path:'test-results/evaluation-ui-answers-light.png' });
      await open.click();
      await page.screenshot({ path:'test-results/evaluation-ui-dialog-light.png' });
      for (const viewport of [{ width:1440,height:1050 },{ width:390,height:844 }]) {
        await page.setViewportSize(viewport);
        // Edge may acknowledge viewport metrics before responsive style/layout
        // has caught up. Poll the invariant, not an arbitrary sleep or first frame.
        await expect.poll(() => page.getByRole('dialog').evaluate(d => {
          const rect=d.getBoundingClientRect();
          return rect.left>=0 && rect.right<=innerWidth+1 && d.scrollWidth<=d.clientWidth+1;
        }),{ timeout:5000,message:'Comparison dialog must fit the resized viewport without horizontal overflow' }).toBe(true);
      }
      await page.screenshot({ path:'test-results/evaluation-ui-dialog-mobile.png' });
      await page.keyboard.press('Escape');
      await answers.scrollIntoViewIfNeeded();
      const answerDimensions=await answers.evaluate(a => ({ width:a.clientWidth,scroll:a.scrollWidth }));
      assert.ok(answerDimensions.scroll<=answerDimensions.width+1,JSON.stringify(answerDimensions));
      await page.screenshot({ path:'test-results/evaluation-ui-answers-mobile.png' });
      assert.deepEqual(errors,[]);
    });
  } catch(error) {
    await page.screenshot({ path:'test-results/evaluation-ui-failure.png' }).catch(() => {});
    if (errors.length) error.message+='\nBrowser errors: '+errors.join(' | ');
    throw error;
  } finally { await context.close(); await browser.close(); }
}
