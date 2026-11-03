import { describe, expect, it } from '@jest/globals';
import { readTrustedNativeTraceEnvelope, safeSecretEqual } from '../internalTraceContext.js';

const ROOT = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const SPAN = '33333333-3333-4333-8333-333333333333';

describe('internal native trace correlation', () => {
  it('accepts a valid envelope only with the shared secret', () => {
    expect(readTrustedNativeTraceEnvelope({
      'x-workspace-secret': 'internal-secret',
      'x-argus-root-trace-id': ROOT,
      'x-argus-parent-trace-id': PARENT,
      'x-argus-parent-span-id': SPAN,
    }, 'internal-secret')).toEqual({ rootTraceId: ROOT, parentTraceId: PARENT, parentSpanId: SPAN });
  });

  it('defaults the parent trace to the root and rejects forged or malformed input', () => {
    expect(readTrustedNativeTraceEnvelope({
      'x-workspace-secret': 'internal-secret',
      'x-argus-root-trace-id': ROOT,
    }, 'internal-secret')).toEqual({ rootTraceId: ROOT, parentTraceId: ROOT, parentSpanId: null });
    expect(readTrustedNativeTraceEnvelope({
      'x-workspace-secret': 'wrong-secret',
      'x-argus-root-trace-id': ROOT,
    }, 'internal-secret')).toBeNull();
    expect(readTrustedNativeTraceEnvelope({
      'x-workspace-secret': 'internal-secret',
      'x-argus-root-trace-id': 'not-a-uuid',
    }, 'internal-secret')).toBeNull();
  });

  it('uses constant-length-safe secret comparison semantics', () => {
    expect(safeSecretEqual('same', 'same')).toBe(true);
    expect(safeSecretEqual('short', 'much-longer')).toBe(false);
    expect(safeSecretEqual('', '')).toBe(false);
  });
});
