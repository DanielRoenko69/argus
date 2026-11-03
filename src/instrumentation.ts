/**
 * OpenTelemetry instrumentation setup.
 *
 * This file is loaded via --import BEFORE the main entry point,
 * ensuring http/express/pg are patched before any application
 * code imports them. In ESM, static imports are resolved before
 * code execution, so this must be a separate entry point.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

// Enable OTel diagnostic logging in debug mode
const otelLogLevel = process.env.OTEL_LOG_LEVEL?.toLowerCase();
if (otelLogLevel === 'debug') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
} else if (otelLogLevel === 'info') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

// Span names that are high-volume noise with no operational value
const SKIP_SPAN_NAMES = new Set([
  'pg-pool.connect',             // connection pool acquisition events
  'pg-pool.connect.wait',        // pool wait events
]);

/**
 * Wraps an exporter and drops spans whose names are in SKIP_SPAN_NAMES
 * before they reach the collector. Keeps SigNoz clean.
 */
class FilteringExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], cb: (result: ExportResult) => void): void {
    const keep = spans.filter(s => !SKIP_SPAN_NAMES.has(s.name));
    if (keep.length === 0) {
      cb({ code: 0 /* SUCCESS */ });
      return;
    }
    this.inner.export(keep, cb);
  }

  shutdown(): Promise<void> { return this.inner.shutdown(); }
  forceFlush(): Promise<void> {
    return (this.inner as { forceFlush?: () => Promise<void> }).forceFlush?.() ?? Promise.resolve();
  }
}

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (otlpEndpoint) {
  const serviceName = process.env.OTEL_SERVICE_NAME || 'argus-core';
  const serviceVersion = process.env.npm_package_version || '1.0.0';
  const environment = process.env.NODE_ENV || 'development';

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    'deployment.environment': environment,
  });

  const rawTraceExporter = new OTLPTraceExporter({ url: otlpEndpoint });
  const metricExporter   = new OTLPMetricExporter({ url: otlpEndpoint });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60000,
  });

  const sdk = new NodeSDK({
    resource,
    // Use BatchSpanProcessor with FilteringExporter to drop pg-pool.connect noise
    spanProcessors: [new BatchSpanProcessor(new FilteringExporter(rawTraceExporter))],
    metricReader: metricReader as never,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          const url = req.url ?? '';
          return url === '/health' || url === '/metrics';
        },
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation({
        enhancedDatabaseReporting: true,
        requestHook: (span, queryInfo) => {
          const sql: string = (queryInfo as { text?: string }).text ?? '';
          span.setAttribute('db.statement', sql.slice(0, 300));
        },
      }),
    ],
  });

  sdk.start();
  const redactedEndpoint = (() => {
    try { const u = new URL(otlpEndpoint); return `${u.protocol}//${u.host}`; }
    catch { return '(invalid)'; }
  })();
  console.log(`[otel] SDK initialized: service=${serviceName} endpoint=${redactedEndpoint}`);

  const shutdown = () => {
    sdk.shutdown()
      .then(() => console.log('[otel] SDK shut down'))
      .catch((err) => console.error('[otel] Shutdown error:', err));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
