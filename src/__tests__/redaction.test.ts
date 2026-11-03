/**
 * Tests for src/lib/redaction.ts — PII redaction engine v1.
 *
 * Strategy:
 * - Each detector gets at least one positive + one allowlist-protected case
 * - Allowlist short-circuit verified (ticket IDs, model names, test fixtures)
 * - Recursive JSON walk verified
 * - Detector subset (e.g. email-only) verified
 * - Pathological inputs (empty, null, very long) don't break
 */

import { redact, redactJson, mergeFoundCounters, summarizeFound, _setRedactionCacheForTest, listDetectors } from '../lib/redaction.js';

beforeAll(() => {
  // Force redaction ON with all detectors active, regardless of env
  _setRedactionCacheForTest({ enabled: true });
});

// ───────────────────────────────────────────────────────────────────

describe('redact — detectors', () => {
  test('email', () => {
    const r = redact('Schreib mir an maintainer@example.com bitte');
    expect(r.text).toBe('Schreib mir an [EMAIL] bitte');
    expect(r.found.email).toBe(1);
  });

  test('k8s_token (JWT-style)', () => {
    const tok = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJrdWJlcm5ldGVzIn0.signature123abc';
    const r = redact(`token: ${tok}`);
    expect(r.text).toBe('token: [K8S_TOKEN]');
    expect(r.found.k8s_token).toBe(1);
  });

  test('git_token', () => {
    const r = redact('Auth: ghp_abcdef1234567890abcdef1234567890abcd');
    expect(r.text).toBe('Auth: [GIT_TOKEN]');
    expect(r.found.git_token).toBe(1);
  });

  test('aws_key', () => {
    const r = redact('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    expect(r.text).toBe('AWS_ACCESS_KEY_ID=[AWS_KEY]');
  });

  test('argus_key', () => {
    const r = redact('use ak_abc123def456ghi789jkl as the key');
    expect(r.text).toBe('use [ARGUS_KEY] as the key');
  });

  test('bearer token', () => {
    const r = redact('Authorization: Bearer ZXlKaGJHY2lPaUpTVXpJMU5pSXNJblI1Y0NJNklr');
    expect(r.text).toMatch(/Bearer \[REDACTED\]/);
  });

  test('iban', () => {
    const r = redact('IBAN: DE89370400440532013000 ist meins');
    expect(r.text).toBe('IBAN: [IBAN] ist meins');
  });

  test('credit card (Luhn-validated)', () => {
    const r = redact('Karte: 4532015112830366'); // valid Luhn
    expect(r.text).toBe('Karte: [CC]');
  });

  test('credit card (Luhn rejects random 16 digits)', () => {
    const r = redact('Nicht-Karte: 1234567890123456'); // invalid Luhn
    expect(r.text).toBe('Nicht-Karte: 1234567890123456');
    expect(r.found.cc).toBeUndefined();
  });

  test('password assignment', () => {
    const r = redact('config: password=hunter2 timeout=30');
    expect(r.text).toMatch(/password=\[REDACTED\]/);
    expect(r.text).toContain('timeout=30');
  });

  test('phone (German)', () => {
    const r = redact('Ruf an: +49 30 1234567 oder 0179 9876543');
    expect(r.text).not.toMatch(/\d{6,}/);
    expect(r.found.phone).toBeGreaterThanOrEqual(1);
  });

  test('empid', () => {
    const r = redact('User: TEST123 hat angemeldet');
    expect(r.text).toBe('User: [EMPID] hat angemeldet');
  });
});

// ───────────────────────────────────────────────────────────────────

describe('redact — allowlist', () => {
  test('ticket IDs not redacted', () => {
    const r = redact('Implementing ARGUS-4943 — see ARGUS-123');
    expect(r.text).toBe('Implementing ARGUS-4943 — see ARGUS-123');
  });

  test('workspace paths not redacted', () => {
    const r = redact('cd /workspace/ARGUS-4943 && git status');
    expect(r.text).toBe('cd /workspace/ARGUS-4943 && git status');
  });

  test('model IDs not mis-redacted as empid', () => {
    // claude-haiku-4-5 has 4 letters + 3 digits if we strip dashes — must NOT match empid
    const r = redact('using model claude-haiku-4-5 and gpt-5.1');
    expect(r.text).toBe('using model claude-haiku-4-5 and gpt-5.1');
  });

  test('test fixtures not redacted', () => {
    const r = redact('curl -H "Authorization: Bearer test-api-key-12345678" url');
    // The "Bearer test-api-key-..." should be allowlisted (test fixture)
    expect(r.text).toContain('test-api-key-12345678');
  });

  test('URLs preserved', () => {
    const r = redact('Fetch https://api.example.com/users/me');
    expect(r.text).toBe('Fetch https://api.example.com/users/me');
  });

  test('operational UUIDs stay linkable without disabling phone redaction', () => {
    const taskId = 'cac69299-c831-492e-9d83-51600376f1c0';
    const r = redact(`Task ${taskId}; call +49 30 1234567 for support`);
    expect(r.text).toBe(`Task ${taskId}; call [PHONE] for support`);
    expect(r.found.phone).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────

describe('redact — combinations', () => {
  test('multiple distinct PII in one string', () => {
    const r = redact(
      'User TEST123 (user@example.com) used token eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig on AKIAIOSFODNN7EXAMPLE',
    );
    expect(r.text).toBe('User [EMPID] ([EMAIL]) used token [K8S_TOKEN] on [AWS_KEY]');
    expect(r.found.email).toBe(1);
    expect(r.found.empid).toBe(1);
    expect(r.found.k8s_token).toBe(1);
    expect(r.found.aws_key).toBe(1);
  });

  test('repeated same-detector matches counted', () => {
    const r = redact('a@x.de, b@y.de, c@z.de');
    expect(r.text).toBe('[EMAIL], [EMAIL], [EMAIL]');
    expect(r.found.email).toBe(3);
  });
});

// ───────────────────────────────────────────────────────────────────

describe('redactJson', () => {
  test('nested object → leaves redacted, keys preserved', () => {
    const input = {
      user: 'TEST123',
      message: 'Schreib an user@example.com',
      meta: {
        ticket: 'ARGUS-4943',
        tags: ['admin', 'TEST123-action'],
      },
    };
    const out = redactJson(input);
    expect(out.value).toEqual({
      user: '[EMPID]',
      message: 'Schreib an [EMAIL]',
      meta: {
        ticket: 'ARGUS-4943',           // allowlist
        tags: ['admin', '[EMPID]-action'],
      },
    });
    expect(out.found.empid).toBe(2);
    expect(out.found.email).toBe(1);
  });

  test('array of strings', () => {
    const out = redactJson(['a@x.de', 'no-pii', 'b@y.de']);
    expect(out.value).toEqual(['[EMAIL]', 'no-pii', '[EMAIL]']);
    expect(out.found.email).toBe(2);
  });

  test('null + undefined preserved', () => {
    const out = redactJson({ a: null, b: undefined, c: 'x@y.de' });
    expect(out.value).toEqual({ a: null, b: undefined, c: '[EMAIL]' });
  });

  test('non-string leaves preserved', () => {
    const out = redactJson({ count: 42, ok: true, nested: { ratio: 0.7 } });
    expect(out.value).toEqual({ count: 42, ok: true, nested: { ratio: 0.7 } });
    expect(Object.keys(out.found).length).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────

describe('redact — detector subset', () => {
  test('only email detector active', () => {
    const r = redact(
      'User TEST123 has email alex@x.de and token eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
      { detectors: new Set(['email']) },
    );
    expect(r.text).toContain('[EMAIL]');
    expect(r.text).toContain('TEST123');                                 // empid NOT redacted
    expect(r.text).toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');   // k8s_token NOT redacted
  });

  test('empty detector set = no redaction', () => {
    const r = redact('email is a@b.de', { detectors: new Set() });
    expect(r.text).toBe('email is a@b.de');
  });
});

// ───────────────────────────────────────────────────────────────────

describe('redact — disabled', () => {
  test('forceEnabled=false preserves input verbatim', () => {
    const input = 'email a@b.de empid TEST123';
    const r = redact(input, { forceEnabled: false });
    expect(r.text).toBe(input);
    expect(Object.keys(r.found).length).toBe(0);
  });

  test('runtime-cache disabled preserves input', () => {
    _setRedactionCacheForTest({ enabled: false });
    const r = redact('a@b.de');
    expect(r.text).toBe('a@b.de');
    _setRedactionCacheForTest({ enabled: true });   // reset
  });
});

// ───────────────────────────────────────────────────────────────────

describe('mergeFoundCounters / summarizeFound', () => {
  test('merge sums per detector', () => {
    const a = { email: 2, k8s_token: 1 } as const;
    const b = { email: 3, password: 1 } as const;
    expect(mergeFoundCounters(a, b)).toEqual({ email: 5, k8s_token: 1, password: 1 });
  });

  test('summarizeFound returns null when empty', () => {
    expect(summarizeFound({})).toBeNull();
  });

  test('summarizeFound aggregates total', () => {
    const s = summarizeFound({ email: 2, empid: 1 });
    expect(s).not.toBeNull();
    expect(s!.total).toBe(3);
    expect(s!.byDetector).toEqual({ email: 2, empid: 1 });
  });
});

// ───────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  test('empty string', () => {
    expect(redact('')).toEqual({ text: '', found: {} });
  });

  test('non-string input (defensive)', () => {
    expect(redact(null as unknown as string).text).toBe('');
    expect(redact(undefined as unknown as string).text).toBe('');
  });

  test('very long string (10KB) — perf bench', () => {
    const big = ('User TEST123 email a@b.de. '.repeat(400));    // ~10KB
    const t0 = Date.now();
    const r = redact(big);
    const dt = Date.now() - t0;
    expect(r.found.email).toBe(400);
    expect(r.found.empid).toBe(400);
    expect(dt).toBeLessThan(50);                                 // budget: 50ms for 10KB
  });

  test('listDetectors returns the catalogue', () => {
    const list = listDetectors();
    expect(list.length).toBeGreaterThanOrEqual(12);
    expect(list).toContain('email');
    expect(list).toContain('iban');
  });
});
