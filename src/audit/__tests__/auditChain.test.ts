import { describe, it, expect } from '@jest/globals';
import { canonicalizeAuditFields, computeChainHash, verifyAuditChainRows } from '../immutableAudit.js';

const row = (over: Record<string, unknown> = {}) => ({
  id: 1, event_type: 'request_success', request_id: 'r1', api_key_prefix: 'ak_x',
  user_id: null, end_user: null, model: 'gpt-5.1', provider: 'openai', deployment_id: 3,
  input_tokens: 10, output_tokens: 20, cost: 0.0023, duration_ms: 100, is_error: false,
  error_type: null, requester_ip: null, session_id: null, team_id: null, org_id: null,
  risk_level: 'low', created_at: '2026-06-18T10:00:00.000Z', prev_hash: '', row_hash: '',
  ...over,
});

describe('audit chain hashing', () => {
  it('canonicalization is deterministic + order-stable', () => {
    expect(canonicalizeAuditFields(row())).toBe(canonicalizeAuditFields(row()));
  });
  it('changing any field changes the canonical string', () => {
    expect(canonicalizeAuditFields(row())).not.toBe(canonicalizeAuditFields(row({ cost: 0.0024 })));
  });
  it('cost round-trip (number vs NUMERIC string) canonicalizes equal', () => {
    expect(canonicalizeAuditFields(row({ cost: 0.0023 }))).toBe(canonicalizeAuditFields(row({ cost: '0.00230000' })));
  });
  it('computeChainHash links to prev (different prev → different hash)', () => {
    const c = canonicalizeAuditFields(row());
    expect(computeChainHash('A', c)).not.toBe(computeChainHash('B', c));
    expect(computeChainHash('A', c)).toBe(computeChainHash('A', c));
  });
});

describe('verifyAuditChainRows', () => {
  const build = () => {
    const rows = [row({ id: 1 }), row({ id: 2, request_id: 'r2' }), row({ id: 3, request_id: 'r3' })];
    let prev = '';
    for (const r of rows) {
      r.prev_hash = prev;
      r.row_hash = computeChainHash(prev, canonicalizeAuditFields(r));
      prev = r.row_hash;
    }
    return rows;
  };
  it('accepts an intact chain', () => {
    expect(verifyAuditChainRows(build())).toEqual({ ok: true, checked: 3, firstBreakId: null });
  });
  it('detects a tampered field', () => {
    const rows = build();
    rows[1].cost = 999; // mutate without re-hashing
    expect(verifyAuditChainRows(rows)).toMatchObject({ ok: false, firstBreakId: 2 });
  });
  it('detects a deleted row (broken prev link)', () => {
    const rows = build();
    rows.splice(1, 1); // remove id=2
    expect(verifyAuditChainRows(rows)).toMatchObject({ ok: false });
  });
});
