import { describe, it, expect } from '@jest/globals';
import { mapSecurity } from '../map.js';

describe('mapSecurity', () => {
  it('maps apiKey-in-header', () => {
    const r = mapSecurity({ openapi: '3.0.0', paths: {}, security: [{ k: [] }], components: { securitySchemes: { k: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } } });
    expect(r).toEqual({ auth_type: 'header', headerName: 'X-API-Key' });
  });
  it('maps http bearer', () => {
    expect(mapSecurity({ openapi: '3.0.0', paths: {}, security: [{ b: [] }], components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } } }).auth_type).toBe('bearer');
  });
  it('maps http basic', () => {
    expect(mapSecurity({ openapi: '3.0.0', paths: {}, security: [{ b: [] }], components: { securitySchemes: { b: { type: 'http', scheme: 'basic' } } } }).auth_type).toBe('basic');
  });
  it('returns none + note for an unsupported scheme (oauth2 / apiKey-query)', () => {
    const r = mapSecurity({ openapi: '3.0.0', paths: {}, security: [{ o: [] }], components: { securitySchemes: { o: { type: 'oauth2', flows: {} } } } });
    expect(r.auth_type).toBe('none');
    expect(r.note).toMatch(/manual/i);
  });
  it('does not activate an unreferenced scheme that is only declared in components', () => {
    expect(mapSecurity({
      openapi: '3.0.0',
      paths: { '/health': { get: {} } },
      components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } },
    })).toEqual({ auth_type: 'none' });
  });
  it('reads operation-level requirements and flags incompatible mixed schemes', () => {
    const result = mapSecurity({
      openapi: '3.0.0',
      paths: {
        '/one': { get: { security: [{ bearer: [] }] } },
        '/two': { post: { security: [{ apiKey: [] }] } },
      },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer' },
          apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
    });
    expect(result.auth_type).toBe('bearer');
    expect(result.note).toMatch(/one backend credential/i);
  });
  it('honors an operation-level security opt-out', () => {
    expect(mapSecurity({
      openapi: '3.0.0',
      security: [{ bearer: [] }],
      paths: { '/health': { get: { security: [] } } },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    })).toEqual({ auth_type: 'none' });
  });
  it('returns none when no securitySchemes', () => {
    expect(mapSecurity({ openapi: '3.0.0', paths: {} }).auth_type).toBe('none');
  });
});
