#!/usr/bin/env node
/**
 * Disposable Qdrant contract certification.
 *
 * Creates a short-lived collection, writes two deterministic points, verifies
 * vector search + payload mapping, then removes the collection. Reports only
 * status/latency and bounded reasons; point payloads are never copied.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = (process.env.ARGUS_QDRANT_CERTIFICATION_BASE_URL || 'http://127.0.0.1:6333').replace(/\/+$/, '');
const reportPath = process.env.ARGUS_QDRANT_CERTIFICATION_REPORT || 'test-results/qdrant-provider-certification.json';
const required = process.env.ARGUS_QDRANT_CERTIFICATION_REQUIRED === '1';
const timeoutMs = Math.min(30_000, Math.max(100, Number(process.env.ARGUS_QDRANT_CERTIFICATION_TIMEOUT_MS || 2_000) || 2_000));
const explicitlyConfigured = Boolean(process.env.ARGUS_QDRANT_CERTIFICATION_BASE_URL?.trim() || required);
const collection = `argus-e2e-${String(process.env.ARGUS_QDRANT_COLLECTION || 'knowledge').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40)}`;
const apiKey = process.env.ARGUS_QDRANT_CERTIFICATION_API_KEY?.trim() || '';

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 320) || 'unknown error';
}

async function request(method, path, body) {
  const started = Date.now();
  try {
    const headers = { 'content-type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) };
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, ok: response.ok, latency_ms: Date.now() - started, payload: response.ok ? await response.json().catch(() => ({})) : null };
  } catch (error) {
    return { status: null, ok: false, latency_ms: Date.now() - started, error: safeError(error), payload: null };
  }
}

function check(name, result, predicate, reason) {
  const passed = predicate(result);
  return {
    name,
    status: passed ? 'passed' : 'failed',
    observed: { status: result.status, latency_ms: result.latency_ms },
    ...(passed ? {} : { reason: reason || result.error || 'unexpected Qdrant response' }),
  };
}

async function main() {
  const report = {
    schema: 'argus.qdrant-provider-certification.v1',
    generated_at: new Date().toISOString(),
    provider: 'qdrant',
    collection,
    overall: 'not_run',
    checks: [],
  };
  if (!explicitlyConfigured) {
    report.reason = 'Qdrant certification URL not configured';
  } else {
    const ready = await request('GET', '/readyz');
    const deleted = await request('DELETE', `/collections/${encodeURIComponent(collection)}`);
    const created = await request('PUT', `/collections/${encodeURIComponent(collection)}`, {
      vectors: { size: 3, distance: 'Cosine' },
    });
    const upserted = await request('PUT', `/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      points: [
        { id: 1, vector: [1, 0, 0], payload: { id: 'doc-1', content: 'ARGUS_QDRANT_CERTIFIED', source: 'runbook.md' } },
        { id: 2, vector: [0, 1, 0], payload: { id: 'doc-2', content: 'secondary document', source: 'other.md' } },
      ],
    });
    const searched = await request('POST', `/collections/${encodeURIComponent(collection)}/points/search`, {
      vector: [1, 0, 0], limit: 2, with_payload: true, with_vector: false,
    });
    const scrolled = await request('POST', `/collections/${encodeURIComponent(collection)}/points/scroll`, {
      limit: 2, with_payload: true, with_vector: false,
    });
    report.checks = [
      check('ready', ready, result => result.status === 200, 'expected Qdrant /readyz HTTP 200'),
      check('collection', created, result => result.status === 200 && result.payload?.result === true, 'expected collection creation success'),
      check('upsert', upserted, result => result.status === 200 && upserted.payload?.status === 'ok', 'expected deterministic point upsert success'),
      check('search', searched, result => result.status === 200 && Array.isArray(result.payload?.result) && result.payload.result.some(point => point?.payload?.content === 'ARGUS_QDRANT_CERTIFIED'), 'expected vector search to return the certified payload'),
      check('scroll', scrolled, result => result.status === 200 && Array.isArray(result.payload?.result?.points) && result.payload.result.points.length >= 2, 'expected payload scroll to return seeded points'),
    ];
    report.overall = report.checks.every(item => item.status === 'passed') ? 'passed' : 'failed';
    // A failed create/upsert must not prevent cleanup of an older disposable collection.
    await request('DELETE', `/collections/${encodeURIComponent(collection)}`);
    void deleted;
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
