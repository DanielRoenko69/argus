import type { Express, Request } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { verifyWebhookSignature } from '../lib/webhookSignature.js';
import {
  AiOpsProviderSignalError,
  ingestAiOpsProviderSignals,
  type AiOpsProviderSignalIngestionResult,
} from './aiopsProviderSignals.js';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export interface AiOpsProviderSignalRouteDependencies {
  ingest(
    pool: pg.Pool,
    provider: string,
    body: unknown,
    rawBody: Buffer,
  ): Promise<{
    provider: string;
    results: AiOpsProviderSignalIngestionResult[];
    dispatchRequested: boolean;
  }>;
  dispatch(): Promise<unknown>;
}

const DEFAULT_DEPENDENCIES: AiOpsProviderSignalRouteDependencies = {
  ingest: ingestAiOpsProviderSignals,
  dispatch: async () => undefined,
};

export function registerAiOpsProviderSignalRoutes(
  app: Express,
  pool: pg.Pool,
  dependencies: Partial<AiOpsProviderSignalRouteDependencies> = {},
): void {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  app.post(
    '/api/observability/aiops/provider-signals/:provider',
    verifyWebhookSignature({
      secretEnvVar: 'AIOPS_PROVIDER_WEBHOOK_SECRET',
      allowMissingInDevelopment: false,
    }),
    async (req, res) => {
      try {
        const rawBody = (req as RawBodyRequest).rawBody;
        if (!rawBody) {
          res.status(500).json({ error: 'Provider signal raw body is unavailable', code: 'raw_body_unavailable' });
          return;
        }
        const result = await deps.ingest(pool, String(req.params['provider'] ?? ''), req.body, rawBody);
        if (result.dispatchRequested) {
          void deps.dispatch().catch(error => {
            logger.warn({ err: error, provider: result.provider }, 'AIOps provider signal dispatch deferred');
          });
        }
        res.status(result.dispatchRequested ? 202 : 200).json({
          schemaVersion: 1,
          kind: 'aiops-provider-signal-ingestion',
          provider: result.provider,
          accepted: result.results.length,
          dispatchRequested: result.dispatchRequested,
          results: result.results,
        });
      } catch (error) {
        if (error instanceof AiOpsProviderSignalError) {
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        logger.error({ err: error, provider: req.params['provider'] }, 'AIOps provider signal ingestion failed');
        res.status(500).json({ error: 'AIOps provider signal ingestion failed', code: 'provider_ingestion_failed' });
      }
    },
  );
}
