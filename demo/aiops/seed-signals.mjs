import { randomBytes } from 'node:crypto';

const lokiUrl = (process.env.LOKI_URL ?? 'http://loki:3100').replace(/\/+$/, '');
const jaegerOtlpUrl = (process.env.JAEGER_OTLP_URL ?? 'http://jaeger:4318').replace(/\/+$/, '');
const jaegerQueryUrl = (process.env.JAEGER_QUERY_URL ?? 'http://jaeger:16686').replace(/\/+$/, '');

async function waitFor(url, attempts = 60) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (cause) {
      lastError = cause;
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`${url} did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function nanoTimestamp(milliseconds) {
  return `${BigInt(milliseconds) * 1_000_000n}`;
}

const now = Date.now();
const traceId = randomBytes(16).toString('hex');
const rootSpanId = randomBytes(8).toString('hex');
const childSpanId = randomBytes(8).toString('hex');
const checkoutTraceId = randomBytes(16).toString('hex');
const checkoutRootSpanId = randomBytes(8).toString('hex');
const checkoutChildSpanId = randomBytes(8).toString('hex');
const start = now - 75_000;

await waitFor(`${lokiUrl}/ready`);
await waitFor(`${jaegerQueryUrl}/api/services`);

const logResponse = await fetch(`${lokiUrl}/loki/api/v1/push`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    streams: [
      {
        stream: { service: 'argus-core', environment: 'local-demo', level: 'warn', source: 'argus-aiops-demo' },
        values: [
          [nanoTimestamp(start + 20_000), 'request latency crossed the local demonstration threshold', { trace_id: traceId, event: 'latency-threshold' }],
          [nanoTimestamp(start + 45_000), 'downstream postgres call returned a simulated timeout', { trace_id: traceId, event: 'dependency-timeout' }],
          [nanoTimestamp(start + 60_000), 'request completed with simulated HTTP 503', { trace_id: traceId, event: 'request-failed' }],
        ],
      },
      {
        stream: { service: 'checkout-api', environment: 'argus-demo', level: 'error', source: 'argus-aiops-showcase' },
        values: [
          [nanoTimestamp(start + 25_000), 'checkout latency exceeded the SLO threshold', { trace_id: checkoutTraceId, event: 'latency-threshold' }],
          [nanoTimestamp(start + 48_000), 'payment-provider-timeout while authorizing checkout', { trace_id: checkoutTraceId, event: 'payment-provider-timeout' }],
          [nanoTimestamp(start + 62_000), 'checkout request completed with HTTP 504', { trace_id: checkoutTraceId, event: 'request-failed' }],
        ],
      },
    ],
  }),
  signal: AbortSignal.timeout(10_000),
});
if (!logResponse.ok) throw new Error(`Loki seed failed: HTTP ${logResponse.status} ${await logResponse.text()}`);

const traceResponse = await fetch(`${jaegerOtlpUrl}/v1/traces`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [
        { key: 'service.name', value: { stringValue: 'argus-core' } },
        { key: 'deployment.environment', value: { stringValue: 'local-demo' } },
      ] },
      scopeSpans: [{
        scope: { name: 'argus-aiops-demo', version: '1.0.0' },
        spans: [
          {
            traceId, spanId: rootSpanId, name: 'POST /api/agents/:id/chat', kind: 2,
            startTimeUnixNano: nanoTimestamp(start), endTimeUnixNano: nanoTimestamp(start + 65_000),
            attributes: [{ key: 'http.response.status_code', value: { intValue: '503' } }],
            status: { code: 2, message: 'simulated dependency timeout' },
          },
          {
            traceId, spanId: childSpanId, parentSpanId: rootSpanId, name: 'postgres.query', kind: 3,
            startTimeUnixNano: nanoTimestamp(start + 10_000), endTimeUnixNano: nanoTimestamp(start + 55_000),
            attributes: [{ key: 'db.system', value: { stringValue: 'postgresql' } }],
            status: { code: 2, message: 'simulated timeout' },
          },
        ],
      }],
    }, {
      resource: { attributes: [
        { key: 'service.name', value: { stringValue: 'checkout-api' } },
        { key: 'deployment.environment', value: { stringValue: 'argus-demo' } },
      ] },
      scopeSpans: [{
        scope: { name: 'argus-aiops-showcase', version: '1.0.0' },
        spans: [
          {
            traceId: checkoutTraceId, spanId: checkoutRootSpanId, name: 'POST /checkout', kind: 2,
            startTimeUnixNano: nanoTimestamp(start + 5_000), endTimeUnixNano: nanoTimestamp(start + 64_000),
            attributes: [{ key: 'http.response.status_code', value: { intValue: '504' } }],
            status: { code: 2, message: 'payment-provider-timeout' },
          },
          {
            traceId: checkoutTraceId, spanId: checkoutChildSpanId, parentSpanId: checkoutRootSpanId, name: 'POST /payment/authorize', kind: 3,
            startTimeUnixNano: nanoTimestamp(start + 12_000), endTimeUnixNano: nanoTimestamp(start + 58_000),
            attributes: [{ key: 'peer.service', value: { stringValue: 'demo-bank' } }],
            status: { code: 2, message: 'payment-provider-timeout' },
          },
        ],
      }],
    }],
  }),
  signal: AbortSignal.timeout(10_000),
});
if (!traceResponse.ok) throw new Error(`Jaeger OTLP seed failed: HTTP ${traceResponse.status} ${await traceResponse.text()}`);

process.stdout.write(`${JSON.stringify({ ok: true, signals: [
  { service: 'argus-core', environment: 'local-demo', traceId },
  { service: 'checkout-api', environment: 'argus-demo', traceId: checkoutTraceId },
] })}\n`);
