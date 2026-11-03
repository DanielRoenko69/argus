import { describe, it, expect } from '@jest/globals';
import { detectPiiMl, type PiiMlOpts, type PiiFetch } from '../piiMl.js';

const opts = (over: Partial<PiiMlOpts> = {}): PiiMlOpts => ({
  enabled: true, url: 'http://presidio:3000', threshold: 0.6, entities: [], language: 'en', ...over,
});

// Fake fetch returning a Presidio /analyze payload.
const fakeFetch = (entities: unknown, ok = true): PiiFetch =>
  (async () => ({ ok, json: async () => entities })) as unknown as PiiFetch;

const throwingFetch: PiiFetch = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as PiiFetch;

describe('detectPiiMl', () => {
  it('returns [] when disabled (never calls Presidio)', async () => {
    let called = false;
    const spy: PiiFetch = (async () => { called = true; return { ok: true, json: async () => [] }; }) as unknown as PiiFetch;
    expect(await detectPiiMl('a@b.com', opts({ enabled: false }), spy)).toEqual([]);
    expect(called).toBe(false);
  });

  it('returns [] for empty text', async () => {
    expect(await detectPiiMl('', opts(), throwingFetch)).toEqual([]);
  });

  it('returns distinct entity types at/above threshold', async () => {
    const f = fakeFetch([
      { entity_type: 'PERSON', score: 0.85, start: 0, end: 4 },
      { entity_type: 'EMAIL_ADDRESS', score: 0.99, start: 5, end: 15 },
      { entity_type: 'PERSON', score: 0.9, start: 20, end: 24 },
    ]);
    const found = await detectPiiMl('some text', opts(), f);
    expect(found.sort()).toEqual(['EMAIL_ADDRESS', 'PERSON']);
  });

  it('excludes entities below the threshold', async () => {
    const f = fakeFetch([
      { entity_type: 'PERSON', score: 0.4, start: 0, end: 4 },
      { entity_type: 'CREDIT_CARD', score: 0.95, start: 5, end: 20 },
    ]);
    expect(await detectPiiMl('x', opts({ threshold: 0.6 }), f)).toEqual(['CREDIT_CARD']);
  });

  it('honours the entities allowlist when set', async () => {
    const f = fakeFetch([
      { entity_type: 'PERSON', score: 0.9, start: 0, end: 4 },
      { entity_type: 'LOCATION', score: 0.9, start: 5, end: 10 },
    ]);
    expect(await detectPiiMl('x', opts({ entities: ['PERSON'] }), f)).toEqual(['PERSON']);
  });

  it('degrades to [] on fetch error (PII-service outage never blocks)', async () => {
    expect(await detectPiiMl('a@b.com', opts(), throwingFetch)).toEqual([]);
  });

  it('degrades to [] on non-OK response', async () => {
    expect(await detectPiiMl('x', opts(), fakeFetch([], false))).toEqual([]);
  });

  it('degrades to [] on a non-array response body', async () => {
    expect(await detectPiiMl('x', opts(), fakeFetch({ error: 'bad' }))).toEqual([]);
  });
});
