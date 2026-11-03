// Opt-in local demo acceptance. Preparation/export never dispatch a model.
// A separate, persistent run marker prevents accidental replay after interruption.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { generateTotp, LOCAL_MFA_ALEX } from '../scripts/lib/localMfaDemo.mjs';
import { launchDemoBrowser } from '../scripts/lib/demo-browser.mjs';

const mode = process.argv[2];
assert.ok(['--prepare', '--run', '--inspect'].includes(mode), 'Use --prepare, --run, or --inspect');
const base = 'http://localhost:3000';
const out = resolve(import.meta.dirname, '../test-results/codex-evaluation-live');
const stateFile = resolve(out, 'progress.json');
mkdirSync(out, { recursive: true });
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {
  stamp: new Date().toISOString().replace(/[-:.TZ]/g, ''), dispatch_requested: false,
};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
if (mode === '--prepare') assert.ok(!state.dispatch_requested && !state.comparison_id && !state.dataset_id,
  'A dataset/comparison already exists: inspect it instead of duplicating preparation');
if (mode === '--run') {
  assert.equal(process.env.ARGUS_CODEX_EVALUATION_LIVE_CONFIRM, 'two-subscription-requests', 'Explicit two-call authorization required');
  assert.ok(state.comparison_id && !state.dispatch_requested, 'No new dispatch: inspect the previous attempt instead');
}
const browser = await launchDemoBrowser(chromium);
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(25_000);
const delay = ms => new Promise(r => setTimeout(r, ms));
let previousCode;
async function factors() {
  await page.waitForLoadState('domcontentloaded');
  const provider = new URL(page.url());
  assert.equal(provider.hostname, 'localhost', 'Demo factors may only be entered at the local IdP');
  assert.ok(provider.pathname.startsWith('/realms/'), 'Unexpected identity provider page');
  if (await page.locator('#password').isVisible()) {
    if (await page.locator('#username').isVisible()) await page.locator('#username').fill(LOCAL_MFA_ALEX.username);
    await page.locator('#password').fill(LOCAL_MFA_ALEX.password);
    await page.locator('#kc-login').click();
  }
  if (page.url().startsWith(base + '/')) return;
  // A previous separate demo browser may already have consumed this TOTP.
  // Retry identity verification once with a NEW code, never a model request.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('#otp').waitFor({ state: 'visible' });
    const deadline = Date.now() + 35_000;
    let code = generateTotp({ secret: LOCAL_MFA_ALEX.totpSecret });
    while (code === previousCode && Date.now() < deadline) {
      await delay(250);
      code = generateTotp({ secret: LOCAL_MFA_ALEX.totpSecret });
    }
    assert.notEqual(code, previousCode, 'No fresh demo MFA code');
    previousCode = code;
    await page.locator('#otp').fill(code);
    await page.locator('#kc-login').click();
    if (await page.waitForURL(url => url.origin === base, { timeout: 5000 }).then(() => true).catch(() => false)) return;
  }
  throw new Error('Local IdP rejected demo MFA; no model request was made');
}
async function api(path, body) {
  const result = await page.evaluate(async ({ path, body }) => {
    const r = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  }, { path, body });
  assert.ok(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status}, code ${result.body?.code ?? 'unknown'}`);
  return result.body;
}
async function clickResponse(button, path, method = 'POST') {
  const pending = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === method);
  await button.click();
  const response = await pending;
  assert.ok(response.ok(), `${path}: HTTP ${response.status()}`);
  return response.json();
}
try {
  await page.goto(base + '/login');
  await page.getByRole('link', { name: /Argus MFA Demo/i }).click();
  await factors();
  await page.goto(base + '/auth/oidc/step-up?returnTo=%2Fbuild%2Fevaluations');
  await factors();
  const identity = await api('/api/me/identity-security');
  assert.equal(identity.session.ssoLinked, true);
  assert.equal(identity.session.mfaFresh, true);
  state.sso_mfa = true;
  console.log('PASS: real local SSO and fresh MFA (separate browser context)');
  if (mode === '--prepare') {
    const profiles = await api('/api/admin/runtime-profiles');
    const profile = profiles.find(p => p.enabled && p.runtime_type === 'codex' && p.model === 'gpt-5.6-terra'
      && p.reasoning_effort === 'xhigh' && p.auth_mode === 'chatgpt' && (!p.auth_ref || p.auth_ref === 'codex-auth'));
    assert.ok(profile, 'An existing enabled Terra/xhigh subscription profile is required');
    const agent = state.agent_id ? { id: state.agent_id } : await api('/api/admin/agents', {
      name: 'evaluation-smoke-' + state.stamp, label: 'Codex evaluation smoke ' + state.stamp,
      description: 'Synthetic isolated evaluation acceptance; no tools, no RAG, no backend changes.',
      model: profile.model, runtime_profile_id: profile.id, bundle_ids: [], min_role: 'platform_admin',
      system_prompt: 'Answer the supplied task exactly. No tools or actions.', codegraph_enabled: false,
    });
    state.agent_id = agent.id;
    assert.ok(state.agent_id);
    save();
    await page.reload();
    await page.getByLabel('Dataset key', { exact: true }).fill('codex-live-' + state.stamp);
    await page.getByLabel('Name', { exact: true }).fill('Codex live repeatability ' + state.stamp);
    await page.getByRole('combobox', { name: /^Default agent/ }).selectOption(String(agent.id));
    const created = await clickResponse(page.getByRole('button', { name: 'Create draft', exact: true }), '/api/admin/evaluations/datasets');
    state.dataset_id = created.dataset.id;
    save();
    await page.getByLabel('Case name', { exact: true }).fill('synthetic-ok');
    await page.getByLabel('Task', { exact: true }).fill('Reply with exactly OK and nothing else.');
    await page.getByRole('combobox', { name: /^Check 1/ }).selectOption('text_equals');
    await page.getByLabel('Expected value 1', { exact: true }).fill('OK');
    await clickResponse(page.getByRole('button', { name: 'Add case', exact: true }), `/api/admin/evaluations/datasets/${state.dataset_id}/cases`);
    await clickResponse(page.getByRole('button', { name: 'Activate dataset', exact: true }), `/api/admin/evaluations/datasets/${state.dataset_id}/activate`);
    await page.getByRole('button', { name: 'New paired comparison', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create comparison', exact: true });
    await dialog.getByLabel('Comparison name', { exact: true }).fill('Codex Terra/xhigh live A/B ' + state.stamp);
    await dialog.getByRole('combobox', { name: /^Comparison dataset/ }).selectOption(String(state.dataset_id));
    for (const side of ['A · Baseline', 'B · Candidate']) {
      await dialog.getByRole('combobox', { name: new RegExp('^' + side + ' Agent') }).selectOption(String(agent.id));
      await dialog.getByRole('combobox', { name: new RegExp('^' + side + ' Runtime model') }).selectOption('gpt-5.6-terra');
    }
    const preview = await clickResponse(dialog.getByRole('button', { name: 'Check comparison', exact: true }), '/api/admin/evaluations/comparisons/preflight');
    assert.equal(preview.planned_requests, 2);
    assert.equal(preview.baseline.reasoning_effort, 'xhigh');
    assert.equal(preview.candidate.reasoning_effort, 'xhigh');
    await page.screenshot({ path: resolve(out, '01-preflight.png') });
    const comparison = await clickResponse(dialog.getByRole('button', { name: 'Save comparison', exact: true }), '/api/admin/evaluations/comparisons');
    state.comparison_id = comparison.comparison.id;
    save();
    console.log(JSON.stringify({ prepared: true, ...state, model_calls: 0 }));
  } else {
    assert.ok(state.comparison_id, 'Prepare a comparison first');
    await page.goto(`${base}/build/evaluations?comparison=${state.comparison_id}`);
    if (mode === '--run') {
      const before = await api(`/api/admin/evaluations/comparisons/${state.comparison_id}`);
      assert.equal(before.comparison.status, 'queued');
      assert.equal(before.summary.planned_requests, 2);
      assert.equal(before.records.length, 2);
      assert.ok(before.records.every(r => r.results.length === 0));
      for (const record of before.records) {
        const experiment = record.experiment;
        const target = experiment.configuration_snapshot?.execution;
        assert.equal(experiment.agent_id, state.agent_id);
        assert.equal(experiment.dataset_id, state.dataset_id);
        assert.equal(experiment.expected_cases.length, 1);
        assert.equal(target?.type, 'codex');
        assert.equal(target?.effective_model, 'gpt-5.6-terra');
        assert.equal(target?.reasoning_effort, 'xhigh');
        assert.equal(target?.executor_version, 'argus.codex-reference.v1');
      }
      await page.getByRole('checkbox', { name: /I authorize 2 new provider requests/ }).check();
      // Persist BEFORE clicking: an uncertain response must never cause another start.
      state.dispatch_requested = true;
      save();
      await clickResponse(page.getByRole('button', { name: 'Start comparison', exact: true }), `/api/admin/evaluations/comparisons/${state.comparison_id}/run`);
      console.log('Exactly one A/B start submitted; no retry path in this harness.');
    }
    let detail;
    const deadline = Date.now() + 390_000;
    while (Date.now() < deadline) {
      detail = await api(`/api/admin/evaluations/comparisons/${state.comparison_id}`);
      if (detail.comparison.status !== 'running') break;
      await delay(2500);
    }
    state.status = detail.comparison.status;
    state.gate = detail.summary.comparison_state;
    state.results = detail.records.map(r => ({ experiment_id: r.experiment.id, status: r.experiment.status,
      results: r.results.map(v => ({ status: v.status, trace_id: v.trace_id, attempt: v.attempt,
        input_tokens: v.input_tokens, output_tokens: v.output_tokens, latency_ms: v.latency_ms,
        cost_usd: v.cost_usd, executor_version: v.evidence?.executor_version })) }));
    save();
    assert.equal(state.status, 'completed');
    assert.equal(state.gate, 'passed');
    for (const record of detail.records) {
      assert.equal(record.results.length, 1);
      const r = record.results[0];
      assert.equal(r.attempt, 1);
      assert.equal(r.status, 'passed');
      assert.equal(r.output_redacted, 'OK');
      assert.equal(r.cost_usd, null);
      assert.equal(r.evidence.executor_version, 'argus.codex-reference.v1');
      assert.ok(r.trace_id && r.input_tokens > 0 && r.output_tokens > 0);
    }
    await page.reload();
    const exports = page.getByRole('region', { name: 'Comparison exports' });
    await exports.getByRole('button', { name: 'Download PDF' }).waitFor();
    state.exports = [];
    for (const format of ['pdf', 'json', 'csv']) {
      const downloadPending = page.waitForEvent('download');
      const responsePending = page.waitForResponse(r => new URL(r.url()).pathname === `/api/admin/evaluations/comparisons/${state.comparison_id}/export/content`
        && new URL(r.url()).searchParams.get('format') === format);
      await exports.getByRole('button', { name: 'Download ' + format.toUpperCase(), exact: true }).click();
      const response = await responsePending;
      assert.equal(response.status(), 200, `Export ${format}`);
      const download = await downloadPending;
      const file = resolve(out, `comparison-${state.comparison_id}.${format}`);
      await download.saveAs(file);
      const bytes = readFileSync(file);
      if (format === 'pdf') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      if (format === 'json') JSON.parse(bytes.toString());
      assert.ok(bytes.length > 100);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(sha256, response.headers()['x-argus-artifact-sha256']);
      const audit = response.headers()['x-argus-audit-event-id'];
      assert.ok(audit);
      state.exports.push({ format, bytes: bytes.length, sha256, audit_event_id: audit });
      save();
    }
    await page.getByRole('region', { name: 'Paired comparisons' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(out, '02-comparison.png') });
    await page.getByRole('heading', { name: 'Answers side by side' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(out, '03-answers-dark.png') });
    await page.getByRole('button', { name: 'Use light theme', exact: true }).click();
    await page.screenshot({ path: resolve(out, '04-answers-light.png') });
    await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
    state.passed = true;
    save();
    console.log(JSON.stringify(state, null, 2));
  }
} catch (error) {
  if (page.url().startsWith(base + '/build/evaluations')) {
    await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
  }
  // Never dump browser cookies, request headers or provider forms.
  console.error(error instanceof Error ? error.message.split('\n')[0] : 'Acceptance failed');
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
