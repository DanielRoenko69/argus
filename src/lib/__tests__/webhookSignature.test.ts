import { createHmac } from 'crypto';
import { verifyWebhookSignature, verifyWebhookToken } from '../webhookSignature.js';

interface MockReq {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
  path: string;
}

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function makeReq(headers: Record<string, string>, body: object): MockReq {
  const raw = Buffer.from(JSON.stringify(body));
  return { rawBody: raw, headers, path: '/wh' };
}

function sign(body: object, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

async function runMiddleware(
  middleware: ReturnType<typeof verifyWebhookSignature>,
  req: MockReq,
): Promise<{ res: MockRes; nextCalled: boolean }> {
  const res = makeRes();
  let nextCalled = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await new Promise<void>(resolve => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    middleware(req as any, res as any, () => { nextCalled = true; resolve(); });
    // If response was sent (status/json called), resolve next tick
    setImmediate(resolve);
  });
  return { res, nextCalled };
}

describe('verifyWebhookSignature', () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env['NODE_ENV'];
    delete process.env['TEST_HOOK_SECRET'];
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = savedNodeEnv;
    delete process.env['TEST_HOOK_SECRET'];
  });

  const mw = verifyWebhookSignature({ secretEnvVar: 'TEST_HOOK_SECRET' });

  it('rejects in production when secret missing (503)', async () => {
    process.env['NODE_ENV'] = 'production';
    const { res, nextCalled } = await runMiddleware(mw, makeReq({}, { a: 1 }));
    expect(res.statusCode).toBe(503);
    expect(nextCalled).toBe(false);
  });

  it('passes through in dev when secret missing', async () => {
    process.env['NODE_ENV'] = 'development';
    const { nextCalled } = await runMiddleware(mw, makeReq({}, { a: 1 }));
    expect(nextCalled).toBe(true);
  });

  it('rejects request without signature header (401)', async () => {
    process.env['TEST_HOOK_SECRET'] = 'topsecret';
    const { res, nextCalled } = await runMiddleware(mw, makeReq({}, { a: 1 }));
    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it('rejects invalid signature (403)', async () => {
    process.env['TEST_HOOK_SECRET'] = 'topsecret';
    const { res } = await runMiddleware(mw, makeReq({ 'x-argus-signature': 'sha256=deadbeef' }, { a: 1 }));
    expect(res.statusCode).toBe(403);
  });

  it('rejects malformed (non-hex) signature (403)', async () => {
    process.env['TEST_HOOK_SECRET'] = 'topsecret';
    const { res } = await runMiddleware(mw, makeReq({ 'x-argus-signature': 'sha256=not-hex!!!' }, { a: 1 }));
    expect(res.statusCode).toBe(403);
  });

  it('accepts valid HMAC-SHA256 signature', async () => {
    process.env['TEST_HOOK_SECRET'] = 'topsecret';
    const body = { ticket_id: 'ARGUS-1', comment: 'ERROR IN NEW IMAGE' };
    const { nextCalled, res } = await runMiddleware(
      mw,
      makeReq({ 'x-argus-signature': sign(body, 'topsecret') }, body),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('rejects when signed with wrong secret', async () => {
    process.env['TEST_HOOK_SECRET'] = 'real-secret';
    const body = { a: 1 };
    const { res } = await runMiddleware(
      mw,
      makeReq({ 'x-argus-signature': sign(body, 'attacker-guess') }, body),
    );
    expect(res.statusCode).toBe(403);
  });

  it('returns 500 when rawBody is missing (wiring bug)', async () => {
    process.env['TEST_HOOK_SECRET'] = 'topsecret';
    const req: MockReq = { headers: { 'x-argus-signature': 'sha256=xx' }, path: '/wh' };
    const { res } = await runMiddleware(mw, req);
    expect(res.statusCode).toBe(500);
  });
});

describe('verifyWebhookToken', () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env['NODE_ENV'];
    delete process.env['TEST_HOOK_TOKEN'];
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = savedNodeEnv;
    delete process.env['TEST_HOOK_TOKEN'];
  });

  it('accepts a valid provider token and rejects a wrong one', async () => {
    process.env['TEST_HOOK_TOKEN'] = 'gitlab-secret';
    const mw = verifyWebhookToken({ secretEnvVar: 'TEST_HOOK_TOKEN', headerName: 'x-gitlab-token' });
    const accepted = await runMiddleware(mw, makeReq({ 'x-gitlab-token': 'gitlab-secret' }, { object_attributes: { status: 'success' } }));
    expect(accepted.nextCalled).toBe(true);
    const rejected = await runMiddleware(mw, makeReq({ 'x-gitlab-token': 'wrong' }, { object_attributes: { status: 'success' } }));
    expect(rejected.res.statusCode).toBe(403);
    expect(rejected.nextCalled).toBe(false);
  });

  it('fails closed in production when the provider token is not configured', async () => {
    process.env['NODE_ENV'] = 'production';
    const mw = verifyWebhookToken({ secretEnvVar: 'TEST_HOOK_TOKEN' });
    const result = await runMiddleware(mw, makeReq({ 'x-argus-webhook-token': 'anything' }, { ok: true }));
    expect(result.res.statusCode).toBe(503);
    expect(result.nextCalled).toBe(false);
  });
});
