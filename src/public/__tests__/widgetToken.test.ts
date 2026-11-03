/**
 * widgetToken.test.ts — TDD for P3-4
 *
 * Uses an in-memory mock Redis implementing the two methods used by widgetToken.ts:
 *   set(key, value, 'EX', ttl, 'NX') → "OK" | null
 *   getdel(key)                       → string | null
 */

import { mintWidgetToken, verifyWidgetToken } from '../widgetToken.js';

// ── In-memory mock Redis ──────────────────────────────────────

interface StoredEntry { value: string; exp: number }

function makeMockRedis() {
  const store = new Map<string, StoredEntry>();

  return {
    store, // exposed for debugging
    async set(
      key: string,
      value: string,
      exToken: 'EX',
      ttlSec: number,
      nxToken: 'NX',
    ): Promise<'OK' | null> {
      const now = Date.now();
      const existing = store.get(key);
      // Evict expired entries
      if (existing && existing.exp <= now) store.delete(key);
      // NX: only set if key does not exist
      if (store.has(key)) return null;
      store.set(key, { value, exp: now + ttlSec * 1000 });
      return 'OK';
    },
    async getdel(key: string): Promise<string | null> {
      const now = Date.now();
      const entry = store.get(key);
      if (!entry) return null;
      store.delete(key);
      if (entry.exp <= now) return null; // expired
      return entry.value;
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────

const SECRET = 'test-secret-min-length-32-bytes!!';
const TTL    = 1800;
const PARAMS = { slug: 'my-widget', agentId: 42, origin: 'https://example.com' };

// ── Tests ─────────────────────────────────────────────────────

describe('mintWidgetToken + verifyWidgetToken', () => {

  test('mint → verify succeeds on first use', async () => {
    const redis = makeMockRedis();
    const token = await mintWidgetToken(redis as never, SECRET, TTL, PARAMS);
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(2);

    const result = await verifyWidgetToken(redis as never, SECRET, token, PARAMS.origin);
    expect(result.ok).toBe(true);
    expect(result.payload?.slug).toBe('my-widget');
    expect(result.payload?.agentId).toBe(42);
    expect(result.payload?.origin).toBe('https://example.com');
    expect(result.reason).toBeUndefined();
  });

  test('replay: second verify on same token → ok:false reason:replay-or-expired', async () => {
    const redis = makeMockRedis();
    const token = await mintWidgetToken(redis as never, SECRET, TTL, PARAMS);

    const first  = await verifyWidgetToken(redis as never, SECRET, token, PARAMS.origin);
    expect(first.ok).toBe(true);

    const second = await verifyWidgetToken(redis as never, SECRET, token, PARAMS.origin);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('replay-or-expired');
  });

  test('wrong origin → ok:false reason:origin-mismatch', async () => {
    const redis = makeMockRedis();
    const token = await mintWidgetToken(redis as never, SECRET, TTL, PARAMS);

    const result = await verifyWidgetToken(redis as never, SECRET, token, 'https://evil.com');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('origin-mismatch');
  });

  test('tampered signature → ok:false reason:bad-signature', async () => {
    const redis = makeMockRedis();
    const token = await mintWidgetToken(redis as never, SECRET, TTL, PARAMS);
    const [payload] = token.split('.');
    const tamperedToken = payload + '.invalidsignatureXXXX';

    const result = await verifyWidgetToken(redis as never, SECRET, tamperedToken, PARAMS.origin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-signature');
  });

  test('expired token (ttl=0 → already expired) → ok:false reason:expired', async () => {
    const redis = makeMockRedis();
    // Mint with ttl=0: exp = now + 0 = now, so exp < now+1ms when we verify
    const token = await mintWidgetToken(redis as never, SECRET, 0, PARAMS);

    // Wait 1ms to ensure exp is definitely in the past
    await new Promise(r => setTimeout(r, 1));

    const result = await verifyWidgetToken(redis as never, SECRET, token, PARAMS.origin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  test('completely malformed token → ok:false (no throw)', async () => {
    const redis = makeMockRedis();
    const result = await verifyWidgetToken(redis as never, SECRET, 'not.a.valid.token', PARAMS.origin);
    expect(result.ok).toBe(false);
  });

  test('empty token string → ok:false (no throw)', async () => {
    const redis = makeMockRedis();
    const result = await verifyWidgetToken(redis as never, SECRET, '', PARAMS.origin);
    expect(result.ok).toBe(false);
  });

  test('origin normalisation: trailing slash stripped before mint+verify', async () => {
    const redis = makeMockRedis();
    const token = await mintWidgetToken(redis as never, SECRET, TTL, {
      ...PARAMS,
      origin: 'https://example.com/',  // trailing slash on mint
    });
    // Verify with no trailing slash — should match after both sides normalise
    const result = await verifyWidgetToken(redis as never, SECRET, token, 'https://example.com');
    expect(result.ok).toBe(true);
  });

  test('origin normalisation: uppercase host → case-insensitive match', async () => {
    const redis = makeMockRedis();
    const token = await mintWidgetToken(redis as never, SECRET, TTL, {
      ...PARAMS,
      origin: 'https://Example.COM',
    });
    const result = await verifyWidgetToken(redis as never, SECRET, token, 'https://example.com');
    expect(result.ok).toBe(true);
  });

  test('different secret on verify → ok:false reason:bad-signature', async () => {
    const redis = makeMockRedis();
    const token = await mintWidgetToken(redis as never, SECRET, TTL, PARAMS);
    const result = await verifyWidgetToken(redis as never, 'a-completely-different-secret!!!!', token, PARAMS.origin);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-signature');
  });
});
