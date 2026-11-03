import { describe, expect, it } from '@jest/globals';
import { resolveFabricProfileCorrelation } from '../fabricProfileTelemetry.js';

describe('Fabric profile telemetry correlation', () => {
  it('prefers the active OTEL child span', () => {
    expect(resolveFabricProfileCorrelation(
      '00-11111111111111111111111111111111-2222222222222222-01',
      { traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: 'bbbbbbbbbbbbbbbb' },
    )).toEqual({ traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: 'bbbbbbbbbbbbbbbb' });
  });

  it('uses a valid W3C parent as a correlation fallback when OTEL is disabled', () => {
    expect(resolveFabricProfileCorrelation(
      '00-11111111111111111111111111111111-2222222222222222-01',
      { traceId: null, spanId: null },
    )).toEqual({ traceId: '11111111111111111111111111111111', spanId: '2222222222222222' });
  });

  it('rejects malformed and all-zero trace parents', () => {
    expect(resolveFabricProfileCorrelation('invalid', { traceId: null, spanId: null }))
      .toEqual({ traceId: null, spanId: null });
    expect(resolveFabricProfileCorrelation(
      '00-00000000000000000000000000000000-0000000000000000-01',
      { traceId: null, spanId: null },
    )).toEqual({ traceId: null, spanId: null });
  });
});
