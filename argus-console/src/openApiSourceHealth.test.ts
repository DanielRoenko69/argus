import { describe, expect, it } from 'vitest';
import type { OpenApiCapabilitySource } from './types';
import {
  countOpenApiSourceHealth,
  filterOpenApiSources,
  formatOpenApiSourceAuth,
  shortSourceDigest,
} from './openApiSourceHealth';

function source(overrides: Partial<OpenApiCapabilitySource> = {}): OpenApiCapabilitySource {
  return {
    id: 1,
    name: 'Catalog API',
    prefix: 'catalog',
    backendId: 10,
    backendEnabled: true,
    source: { kind: 'url', url: 'https://example.test/openapi.json', canCheck: true, baseUrlOverride: null },
    status: 'current',
    importedAt: '2026-07-30T08:00:00.000Z',
    checkedAt: '2026-07-31T08:00:00.000Z',
    baseline: { specDigest: 'abc', manifestDigest: 'def', operationCount: 4 },
    lastCheck: null,
    ...overrides,
  };
}

describe('OpenAPI source health helpers', () => {
  it('counts attention states without treating unchecked sources as unavailable', () => {
    const sources = [
      source(),
      source({ id: 2, status: 'drifted' }),
      source({ id: 3, status: 'error' }),
      source({ id: 4, status: 'unchecked' }),
    ];
    expect(countOpenApiSourceHealth(sources)).toEqual({
      total: 4,
      current: 1,
      drifted: 1,
      error: 1,
      unchecked: 1,
      attention: 2,
    });
  });

  it('filters by source health and searches source URLs case-insensitively', () => {
    const sources = [
      source({ id: 1, name: 'Stable API' }),
      source({ id: 2, name: 'Drift API', status: 'drifted', source: { kind: 'url', url: 'https://CHANGED.example/spec', canCheck: true, baseUrlOverride: null } }),
      source({ id: 3, name: 'Broken API', status: 'error' }),
    ];
    expect(filterOpenApiSources(sources, ' changed.EXAMPLE ', 'drifted').map(item => item.id)).toEqual([2]);
    expect(filterOpenApiSources(sources, '', 'all').map(item => item.id)).toEqual([2, 3, 1]);
  });

  it('formats the final auth contract and shortens long digests', () => {
    expect(formatOpenApiSourceAuth({ type: 'header', headerName: 'X-Api-Key' })).toBe('API key · X-Api-Key');
    expect(formatOpenApiSourceAuth({ type: 'bearer', headerName: null })).toBe('Bearer token');
    expect(formatOpenApiSourceAuth(null)).toBe('None');
    expect(shortSourceDigest('1234567890abcdefghijk')).toBe('1234567…ghijk');
  });
});
