import { describe, expect, it } from '@jest/globals';
import {
  canonicalAuditDigest,
  redactCanonicalAuditPayload,
  stableAuditJson,
} from '../canonicalAuditRedaction.js';

describe('canonical audit redaction', () => {
  it('redacts secrets, prompts and common personal data without retaining values', () => {
    const redacted = redactCanonicalAuditPayload({
      authorization: 'Bearer this-must-never-survive',
      apiKey: 'sk-thisisasecretvalue123456',
      prompt: 'private customer request',
      email: 'person@example.test',
      requesterIp: '203.0.113.10',
      nested: {
        safe: 'visible', token: 'secret-token',
        description: 'Contact hidden.person@example.test from 203.0.113.10 or +49 170 1234567',
      },
    });
    const encoded = stableAuditJson(redacted);
    expect(encoded).toContain('visible');
    for (const secret of [
      'this-must-never-survive', 'thisisasecretvalue123456', 'private customer request',
      'person@example.test', 'hidden.person@example.test', '203.0.113.10', '+49 170 1234567', 'secret-token',
    ]) expect(encoded).not.toContain(secret);
  });

  it('produces stable JSON and digests regardless of object insertion order', () => {
    const left = redactCanonicalAuditPayload({ z: 3, nested: { b: 2, a: 1 } });
    const right = redactCanonicalAuditPayload({ nested: { a: 1, b: 2 }, z: 3 });
    expect(stableAuditJson(left)).toBe(stableAuditJson(right));
    expect(canonicalAuditDigest(left)).toBe(canonicalAuditDigest(right));
  });

  it('bounds circular, deep, long and oversized array values', () => {
    const circular: Record<string, unknown> = { safe: 'x'.repeat(2_000) };
    circular.self = circular;
    circular.items = Array.from({ length: 80 }, (_, index) => index);
    const encoded = stableAuditJson(redactCanonicalAuditPayload(circular));
    expect(encoded).toContain('[CIRCULAR]');
    expect(encoded).toContain('TRUNCATED_30_ITEMS');
    expect(encoded).not.toContain('x'.repeat(1_025));
  });
});
