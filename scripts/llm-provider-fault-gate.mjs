#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible provider-fault certification.
 *
 * The target is opt-in and normally points at the local fake-openai Compose
 * fixture. Reports contain status/latency only; response bodies and secrets
 * are intentionally not copied into evidence.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = (process.env.ARGUS_LLM_FAULT_BASE_URL || 'http://127.0.0.1:4000/v1').replace(/\/+$/, '');
const reportPath = process.env.ARGUS_LLM_FAULT_REPORT || 'test-results/llm-provider-faults.json';
const required = process.env.ARGUS_LLM_FAULT_REQUIRED === '1';
const timeoutMs = Math.min(30_000, Math.max(100, Number(process.env.ARGUS_LLM_FAULT_TIMEOUT_MS || 750) || 750));
const explicitlyConfigured = Boolean(process.env.ARGUS_LLM_FAULT_BASE_URL?.trim() || required);

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 320) || 'unknown error';
}

async function probe(marker, timeout = timeoutMs) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'e2e-chat',
        messages: [{ role: 'user', content: marker }],
        stream: false,
      }),
      signal: AbortSignal.timeout(timeout),
    });
    return {
      status: response.status,
      ok: response.ok,
      retry_after_seconds: Number(response.headers.get('retry-after') || 0) || null,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    const message = safeError(error);
    return {
      status: null,
      ok: false,
      timed_out: /timeout|aborted/i.test(message) || error?.name === 'TimeoutError',
      latency_ms: Date.now() - started,
      error: message,
    };
  }
}

function expected(name, result, predicate, reason) {
  const passed = predicate(result);
  return {
    name,
    status: passed ? 'passed' : 'failed',
    observed: {
      status: result.status,
      retry_after_seconds: result.retry_after_seconds ?? null,
      timed_out: result.timed_out === true,
      latency_ms: result.latency_ms,
    },
    ...(passed ? {} : { reason }),
  };
}

async function main() {
  const report = {
    schema: 'argus.llm-provider-faults.v1',
    generated_at: new Date().toISOString(),
    provider: 'openai-compatible',
    overall: 'not_run',
    checks: [],
  };
  if (!explicitlyConfigured) {
    report.reason = 'fault provider URL not configured';
  } else {
    const unauthorized = await probe('ARGUS_E2E_FAULT_401');
    const rateLimit = await probe('ARGUS_E2E_FAULT_429');
    const serverError = await probe('ARGUS_E2E_FAULT_500');
    const timeout = await probe('ARGUS_E2E_FAULT_TIMEOUT');
    report.checks = [
      expected('unauthorized', unauthorized, result => result.status === 401, 'expected HTTP 401'),
      expected('rate_limit', rateLimit, result => result.status === 429 && result.retry_after_seconds === 1, 'expected HTTP 429 with Retry-After: 1'),
      expected('server_error', serverError, result => result.status === 500, 'expected HTTP 500'),
      expected('timeout', timeout, result => result.timed_out === true, 'expected bounded request timeout'),
    ];
    report.overall = report.checks.every(check => check.status === 'passed') ? 'passed' : 'failed';
  }
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (required && report.overall !== 'passed') process.exitCode = 2;
  if (report.overall === 'failed') process.exitCode = 2;
}

try { await main(); } catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 2;
}
