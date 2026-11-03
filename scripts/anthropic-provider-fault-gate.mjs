#!/usr/bin/env node
/**
 * Deterministic Anthropic-compatible provider-fault certification.
 *
 * This gate validates the wire contract and the same bounded HTTP fault
 * matrix as the OpenAI-compatible fixture. It never stores response bodies.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = (process.env.ARGUS_ANTHROPIC_FAULT_BASE_URL || 'http://127.0.0.1:4100/v1').replace(/\/+$/, '');
const reportPath = process.env.ARGUS_ANTHROPIC_FAULT_REPORT || 'test-results/anthropic-provider-faults.json';
const required = process.env.ARGUS_ANTHROPIC_FAULT_REQUIRED === '1';
const timeoutMs = Math.min(30_000, Math.max(100, Number(process.env.ARGUS_ANTHROPIC_FAULT_TIMEOUT_MS || 750) || 750));
const explicitlyConfigured = Boolean(process.env.ARGUS_ANTHROPIC_FAULT_BASE_URL?.trim() || required);

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 320) || 'unknown error';
}

async function probe(marker, timeout = timeoutMs, protocol = false) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'argus-e2e-key', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'e2e-claude',
        max_tokens: 32,
        messages: [{ role: 'user', content: marker }],
        stream: false,
      }),
      signal: AbortSignal.timeout(timeout),
    });
    let protocolOk = null;
    if (protocol && response.ok) {
      const payload = await response.json();
      protocolOk = payload?.type === 'message'
        && payload?.role === 'assistant'
        && Array.isArray(payload?.content)
        && payload.content.some(item => item?.type === 'text' && item?.text === 'ARGUS_E2E_ANTHROPIC_OK');
    }
    return {
      status: response.status,
      ok: response.ok,
      protocol_ok: protocolOk,
      retry_after_seconds: Number(response.headers.get('retry-after') || 0) || null,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    const message = safeError(error);
    return {
      status: null,
      ok: false,
      protocol_ok: false,
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
      protocol_ok: result.protocol_ok ?? null,
      retry_after_seconds: result.retry_after_seconds ?? null,
      timed_out: result.timed_out === true,
      latency_ms: result.latency_ms,
    },
    ...(passed ? {} : { reason }),
  };
}

async function main() {
  const report = {
    schema: 'argus.anthropic-provider-faults.v1',
    generated_at: new Date().toISOString(),
    provider: 'anthropic-compatible',
    overall: 'not_run',
    checks: [],
  };
  if (!explicitlyConfigured) {
    report.reason = 'Anthropic fault provider URL not configured';
  } else {
    const normal = await probe('ARGUS_E2E_ANTHROPIC_PROTOCOL', timeoutMs, true);
    const unauthorized = await probe('ARGUS_E2E_FAULT_401');
    const rateLimit = await probe('ARGUS_E2E_FAULT_429');
    const serverError = await probe('ARGUS_E2E_FAULT_500');
    const timeout = await probe('ARGUS_E2E_FAULT_TIMEOUT');
    report.checks = [
      expected('protocol', normal, result => result.status === 200 && result.protocol_ok === true, 'expected a valid Anthropic message response'),
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
