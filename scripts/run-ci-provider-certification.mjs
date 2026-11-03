#!/usr/bin/env node
/**
 * Provider-neutral CI certification report.
 *
 * This command is intentionally safe for PR/nightly use:
 * - no provider mutation is performed (LangGraph only issues GET probes),
 * - missing credentials/configuration become `not_run`, never a false pass,
 * - the report contains status evidence only and never token values.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const PROVIDERS = ['gitea', 'github', 'gitlab', 'jenkins'];
const REPORT_PATH = process.env.ARGUS_PROVIDER_CERTIFICATION_REPORT
  || 'test-results/ci-provider-certification.json';
const LANGGRAPH_URL = (process.env.LANGGRAPH_URL || 'http://localhost:2025').replace(/\/+$/, '');
const WORKSPACE_SECRET = (process.env.WORKSPACE_SECRET || '').trim();
const enabled = process.env.ARGUS_CI_CANARIES_ENABLED === '1';
const requiredProviders = [...new Set((process.env.ARGUS_CI_CANARIES_REQUIRED_PROVIDERS || '')
  .split(',').map(value => value.trim().toLowerCase()).filter(value => PROVIDERS.includes(value)))];

function safeText(value, max = 320) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function safeError(value) {
  return safeText(value instanceof Error ? value.message : value)
    .replace(/(?:authorization|bearer|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]') || 'unknown error';
}

function emptyMatrix(status, reason) {
  return PROVIDERS.map(provider => ({ provider, status, checks: [], reason }));
}

function parseTargets() {
  if (!enabled) return [];
  const raw = process.env.ARGUS_CI_CANARY_TARGETS?.trim();
  if (!raw) throw new Error('ARGUS_CI_CANARY_TARGETS is required when canaries are enabled');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('ARGUS_CI_CANARY_TARGETS is not valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) {
    throw new Error('ARGUS_CI_CANARY_TARGETS must contain 1 to 8 targets');
  }
  return parsed.map((target, index) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error(`CI target ${index + 1} must be an object`);
    const provider = String(target.provider || '').trim().toLowerCase();
    const externalId = safeText(target.run_id, 200);
    const tokenEnv = safeText(target.token_env, 128);
    if (!PROVIDERS.includes(provider)) throw new Error(`CI target ${index + 1} has an unsupported provider`);
    if (!externalId) throw new Error(`CI target ${index + 1} is missing run_id`);
    if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(tokenEnv)) throw new Error(`CI target ${index + 1} has an invalid token_env`);
    return { provider, externalId, tokenConfigured: Boolean(process.env[tokenEnv]) };
  });
}

async function runProbeBatch() {
  const response = await fetch(`${LANGGRAPH_URL}/ci/canaries`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'X-Workspace-Secret': WORKSPACE_SECRET },
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(safeText(payload?.error) || `LangGraph returned HTTP ${response.status}`);
  if (!Array.isArray(payload?.results)) throw new Error('LangGraph returned no CI canary results');
  return payload.results.map(result => ({
    provider: safeText(result.provider, 16).toLowerCase(),
    externalId: safeText(result.external_id, 200),
    status: ['ok', 'failed', 'timeout', 'error'].includes(result.status) ? result.status : 'error',
    httpStatus: Number.isInteger(result.http_status) ? result.http_status : null,
    latencyMs: Number.isInteger(result.latency_ms) ? result.latency_ms : null,
    providerStatus: safeText(result.provider_status, 120) || null,
    errorMessage: result.error_message ? safeError(result.error_message) : null,
  }));
}

function buildMatrix(targets, results, problem, configurationError = false) {
  return PROVIDERS.map(provider => {
    const configured = targets.filter(target => target.provider === provider);
    if (configurationError) return { provider, status: 'failed', checks: [], reason: 'invalid canary configuration' };
    if (!configured.length) return { provider, status: 'not_run', checks: [], reason: 'no target configured' };
    const missingCredential = configured.some(target => !target.tokenConfigured);
    if (missingCredential || targets.some(target => !target.tokenConfigured)) {
      return { provider, status: 'not_run', checks: [], reason: 'target credential is not configured' };
    }
    if (problem && /not configured/i.test(problem)) return { provider, status: 'not_run', checks: [], reason: 'workspace credential is not configured' };
    if (problem) return { provider, status: 'failed', checks: [], reason: problem };
    const checks = configured.map(target => results.find(result => result.provider === provider && result.externalId === target.externalId)
      || { provider, externalId: target.externalId, status: 'error', httpStatus: null, latencyMs: null, providerStatus: null, errorMessage: 'missing result' });
    const status = checks.every(check => check.status === 'ok') ? 'passed' : 'failed';
    return { provider, status, checks, ...(status === 'failed' ? { reason: 'one or more configured checks failed' } : {}) };
  });
}

async function main() {
  let targets = [];
  let problem = null;
  let configurationError = false;
  try {
    targets = parseTargets();
    if (enabled && !WORKSPACE_SECRET) problem = 'WORKSPACE_SECRET is not configured';
    if (enabled && !problem) {
      try { var results = await runProbeBatch(); } catch (error) { problem = safeError(error); }
    }
  } catch (error) {
    problem = safeError(error);
    configurationError = true;
  }
  const matrix = buildMatrix(targets, results || [], problem, configurationError);
  const requiredMissing = requiredProviders.filter(provider => matrix.find(item => item.provider === provider)?.status !== 'passed');
  const hasFailed = matrix.some(item => item.status === 'failed');
  const hasPassed = matrix.some(item => item.status === 'passed');
  const overall = hasFailed || requiredMissing.length ? 'failed' : hasPassed ? 'passed' : 'not_run';
  const report = {
    generated_at: new Date().toISOString(),
    overall,
    enabled,
    required_providers: requiredProviders,
    required_missing: requiredMissing,
    providers: matrix,
  };
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (overall === 'failed') process.exitCode = 2;
}

await main();
