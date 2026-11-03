/**
 * Audit finding #3 + per-workflow secret (#1): the webhook trigger receiver
 * must be HMAC-authenticated and rate-limited. Verification now happens INSIDE
 * the handler (after the slug→workflow lookup) because the secret env-var can
 * be chosen per workflow via trigger_config.webhook_secret_env. These tests
 * assert the handler behaviour; the HMAC math itself is covered by
 * webhookSignature's own tests.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createHmac } from 'crypto';
import type { Express, Request, Response, RequestHandler } from 'express';
import type pg from 'pg';
import {
  buildLocalWebhookTestDelivery,
  normalizeWorkflowWebhookInputs,
  registerWebhookTriggerRoute,
  workflowWebhookEvidence,
} from '../triggerWorker.js';
import type { ToolRunner } from '../types.js';
import type { StepRunners } from '../executor.js';

const noopFactory = () => (async () => ({ content: [{ type: 'text' as const, text: '' }] })) as ToolRunner;
const noopRunners = {} as StepRunners;

/** Pool that resolves the webhook lookup to a workflow (no per-workflow secret env). */
const wfPool = {
  query: async (sql: string) => {
    if (sql.includes('trigger_config @> $1::jsonb')) {
      return { rows: [{ id: 1, name: 'deploy_wf', trigger_config: { type: 'webhook', webhook_path: '/deploy' } }] };
    }
    return { rows: [] }; // fireWorkflow's SELECT → no steps → fireWorkflow returns null (still 200)
  },
} as unknown as pg.Pool;

/** Pool that resolves NO workflow (used for the rate-limit test → 404 path). */
const emptyPool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;

function getHandler(pool: pg.Pool): RequestHandler {
  let handler: RequestHandler | undefined;
  const fakeApp = {
    post: (_path: string, ...hs: RequestHandler[]) => { handler = hs[hs.length - 1]; },
  } as unknown as Express;
  registerWebhookTriggerRoute(fakeApp, pool, noopFactory, noopRunners);
  return handler!;
}

function mockRes(): Response & { statusCode: number } {
  const res = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json() { return this; },
  };
  return res as unknown as Response & { statusCode: number };
}

function reqFor(body: object, headers: Record<string, string> = {}, slug = 'deploy'): Request {
  const rawBody = Buffer.from(JSON.stringify(body));
  return { params: { slug }, body, rawBody, headers } as unknown as Request;
}

function sign(rawBody: Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

describe('webhook trigger security (finding #3 + per-workflow secret #1)', () => {
  let savedEnv: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['ARGUS_WEBHOOK_SECRET'];
    savedNodeEnv = process.env['NODE_ENV'];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env['ARGUS_WEBHOOK_SECRET'];
    else process.env['ARGUS_WEBHOOK_SECRET'] = savedEnv;
    if (savedNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = savedNodeEnv;
  });

  it('registers the local Builder test only behind the supplied session guard', () => {
    const routes = new Map<string, RequestHandler[]>();
    const fakeApp = {
      post: (path: string, ...handlers: RequestHandler[]) => { routes.set(path, handlers); },
    } as unknown as Express;
    const requireAuth: RequestHandler = (_req, _res, next) => next();

    registerWebhookTriggerRoute(fakeApp, wfPool, noopFactory, noopRunners, requireAuth);

    expect(routes.get('/webhooks/wf/:slug')).toHaveLength(1);
    expect(routes.get('/api/workflows/:id/test-webhook')).toEqual([
      requireAuth,
      expect.any(Function),
    ]);
  });

  it('rejects an unsigned request when a secret is configured (401)', async () => {
    process.env['NODE_ENV'] = 'development';
    process.env['ARGUS_WEBHOOK_SECRET'] = 'topsecret';
    const handler = getHandler(wfPool);
    const res = mockRes();
    await handler(reqFor({ a: 1 }), res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid signature (403)', async () => {
    process.env['NODE_ENV'] = 'development';
    process.env['ARGUS_WEBHOOK_SECRET'] = 'topsecret';
    const handler = getHandler(wfPool);
    const res = mockRes();
    await handler(reqFor({ a: 1 }, { 'x-argus-signature': 'sha256=deadbeef' }), res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it('accepts a valid HMAC signature (passes auth → not 401/403)', async () => {
    process.env['NODE_ENV'] = 'development';
    process.env['ARGUS_WEBHOOK_SECRET'] = 'topsecret';
    const handler = getHandler(wfPool);
    const body = { deploy: true };
    const req = reqFor(body, { 'x-argus-signature': sign(Buffer.from(JSON.stringify(body)), 'topsecret') });
    const res = mockRes();
    await handler(req, res, () => {});
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(429);
  });

  it('accepts the native GitHub X-Hub-Signature-256 header', async () => {
    process.env['NODE_ENV'] = 'development';
    process.env['ARGUS_WEBHOOK_SECRET'] = 'topsecret';
    const handler = getHandler(wfPool);
    const body = { action: 'opened' };
    const req = reqFor(body, {
      'x-hub-signature-256': sign(Buffer.from(JSON.stringify(body)), 'topsecret'),
      'x-github-event': 'issues',
      'x-github-delivery': 'delivery-native-github',
    });
    const res = mockRes();
    await handler(req, res, () => {});
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it('fails CLOSED in production when the chosen secret is unset (503)', async () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['ARGUS_WEBHOOK_SECRET'];
    const handler = getHandler(wfPool);
    const res = mockRes();
    await handler(reqFor({ a: 1 }), res, () => {});
    expect(res.statusCode).toBe(503);
  });

  it('rate-limits a slug after 30 requests in the window (429)', async () => {
    process.env['NODE_ENV'] = 'development';
    const handler = getHandler(emptyPool);
    const call = async () => {
      const res = mockRes();
      await handler(reqFor({}, {}, 'rl-test-slug'), res, () => {});
      return res.statusCode;
    };
    // First 30 pass the limiter (then 404 since emptyPool resolves no workflow).
    for (let i = 0; i < 30; i++) {
      const code = await call();
      expect(code).not.toBe(429);
    }
    expect(await call()).toBe(429);
  });

  it('normalizes GitHub delivery evidence into a stable idempotency identity', () => {
    const body = Buffer.from(JSON.stringify({ action: 'opened', issue: { number: 42 } }));
    const evidence = workflowWebhookEvidence({
      headers: {
        'x-github-event': 'issues',
        'x-github-delivery': '56f0e9f0-1234-4cab-8abc-123456789abc',
      },
      rawBody: body,
      path: '/webhooks/wf/github-issues',
      receivedAt: new Date('2026-08-22T12:00:00.000Z'),
    });

    expect(evidence).toMatchObject({
      source: 'github',
      event_id: '56f0e9f0-1234-4cab-8abc-123456789abc',
      event_type: 'issues',
      event_id_source: 'x-github-delivery',
      received_at: '2026-08-22T12:00:00.000Z',
      path: '/webhooks/wf/github-issues',
    });
    expect(evidence.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('falls back to the payload fingerprint for generic webhook deduplication', () => {
    const input = {
      headers: { 'x-argus-event-source': 'local-test' },
      rawBody: Buffer.from('{"ticket":123}'),
      path: '/webhooks/wf/local-test',
    };
    const first = workflowWebhookEvidence(input);
    const second = workflowWebhookEvidence(input);

    expect(first.event_id).toBe(`sha256:${first.payload_sha256}`);
    expect(second.event_id).toBe(first.event_id);
    expect(first.source).toBe('local-test');
  });

  it('maps a native GitHub issue payload to bounded workflow inputs and applies static config', () => {
    const body = {
      action: 'opened',
      issue: {
        number: 42,
        title: 'Webhook integration',
        body: 'Please route this issue through Argus.',
        html_url: 'https://github.example/argus/core/issues/42',
      },
      repository: {
        name: 'argus_core',
        full_name: 'argus-project/argus_core',
        owner: { login: 'argus-project' },
      },
      sender: { login: 'octocat' },
    };
    const evidence = workflowWebhookEvidence({
      headers: { 'x-github-event': 'issues', 'x-github-delivery': 'delivery-42' },
      body,
      path: '/webhooks/wf/github-issues',
    });
    const inputs = normalizeWorkflowWebhookInputs(body, evidence, {
      provider: 'github',
      static_inputs: { notification_channel: 'C123' },
    });

    expect(evidence.event_type).toBe('issues.opened');
    expect(inputs).toEqual({
      repository_owner: 'argus-project',
      repository_name: 'argus_core',
      issue_number: 42,
      issue_title: 'Webhook integration',
      issue_body: 'Please route this issue through Argus.',
      issue_url: 'https://github.example/argus/core/issues/42',
      issue_action: 'opened',
      sender_login: 'octocat',
      notification_channel: 'C123',
    });
  });

  it('builds a native GitHub fixture for an authenticated local Builder test', () => {
    const delivery = buildLocalWebhookTestDelivery({
      provider: 'github',
      event: 'issues',
      action: 'opened',
      path: '/webhooks/wf/github-issues',
      deliveryId: 'local-delivery-42',
      receivedAt: new Date('2026-08-22T13:00:00.000Z'),
    });

    expect(delivery.evidence).toMatchObject({
      source: 'github',
      event_id: 'local-delivery-42',
      event_type: 'issues.opened',
      event_id_source: 'local-test',
      mode: 'local_test',
      path: '/webhooks/wf/github-issues',
    });
    expect(delivery.payload).toMatchObject({
      action: 'opened',
      issue: { number: 1 },
      repository: { name: 'demo-repository', owner: { login: 'argus-local' } },
    });
    expect(normalizeWorkflowWebhookInputs(delivery.payload, delivery.evidence, {
      provider: 'github',
      static_inputs: { notification_channel: 'C123' },
    })).toMatchObject({
      repository_owner: 'argus-local',
      repository_name: 'demo-repository',
      issue_number: 1,
      issue_action: 'opened',
      notification_channel: 'C123',
    });
  });
});
