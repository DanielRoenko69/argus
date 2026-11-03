import { describe, expect, it } from '@jest/globals';
import type { MappedOp } from '../map.js';
import { buildOpenApiCapabilityManifest } from '../manifest.js';

const supported: MappedOp = {
  name: 'pets__list', description: 'List', queryTemplate: 'GET /pets', parameters: [],
  isWrite: false, method: 'GET', path: '/pets', tags: [], warnings: [], supported: true,
};
const unsupported: MappedOp = {
  name: 'pets__upload', description: 'Upload', queryTemplate: 'POST /upload', parameters: [],
  isWrite: true, method: 'POST', path: '/upload', tags: [], warnings: ['unsupported body'], supported: false,
};

function build(overrides: Record<string, unknown> = {}) {
  return buildOpenApiCapabilityManifest({
    prefix: 'pets', sourceKind: 'url', specUrl: 'https://spec.example.test/openapi.json',
    title: 'Pets', openapiVersion: '3.0.3', baseUrl: 'https://api.example.test/v1',
    baseUrlOverridden: false, security: { auth_type: 'none' }, specDigest: 'a'.repeat(64),
    operations: [supported, unsupported],
    ...overrides,
  });
}

describe('canonical OpenAPI source manifest', () => {
  it('persists clean URL sources and the full mapped operation set including unsupported operations', () => {
    const value = build();
    expect(value).toEqual(expect.objectContaining({
      sourceKind: 'url', sourceUrl: 'https://spec.example.test/openapi.json',
    }));
    expect(value.operations).toHaveLength(2);
    expect(value.operations.find(operation => operation.name === unsupported.name)?.supported).toBe(false);
    expect(new Set([value.authSignature, value.manifestDigest, ...value.operations.map(operation => operation.signature)]).size)
      .toBe(4);
  });

  it('never persists query-bearing or credential-bearing source URLs', () => {
    expect(build({ specUrl: 'https://spec.example.test/openapi.json?token=secret' }))
      .toEqual(expect.objectContaining({
        sourceKind: 'text', sourceUrl: null, baseUrlOverride: 'https://api.example.test/v1',
      }));
    expect(build({ specUrl: 'https://user:secret@spec.example.test/openapi.json' }))
      .toEqual(expect.objectContaining({
        sourceKind: 'text', sourceUrl: null, baseUrlOverride: 'https://api.example.test/v1',
      }));
  });

  it('pins a resolved relative server when a signed source URL degrades to manual checks', () => {
    const value = build({
      specUrl: 'https://spec.example.test/catalog/openapi.json?signature=secret',
      baseUrl: 'https://spec.example.test/v1',
      baseUrlOverridden: false,
    });
    expect(value).toEqual(expect.objectContaining({
      sourceKind: 'text',
      sourceUrl: null,
      baseUrl: 'https://spec.example.test/v1',
      baseUrlOverride: 'https://spec.example.test/v1',
    }));
  });

  it('keeps canonical manifest digest stable across raw spec formatting-only changes', () => {
    const first = build({ specDigest: 'a'.repeat(64) });
    const reformatted = build({ specDigest: 'b'.repeat(64) });
    expect(first.specDigest).not.toBe(reformatted.specDigest);
    expect(first.manifestDigest).toBe(reformatted.manifestDigest);
  });

  it('treats API key header casing as the same canonical authentication scheme', () => {
    const titleCase = build({ security: { auth_type: 'header', headerName: 'X-API-Key' } });
    const lowerCase = build({ security: { auth_type: 'header', headerName: 'x-api-key' } });
    expect(titleCase.auth.headerName).toBe('X-API-Key');
    expect(lowerCase.auth.headerName).toBe('x-api-key');
    expect(titleCase.authSignature).toBe(lowerCase.authSignature);
    expect(titleCase.manifestDigest).toBe(lowerCase.manifestDigest);
  });

  it('persists only explicit base URL pins', () => {
    expect(build().baseUrlOverride).toBeNull();
    expect(build({ baseUrlOverridden: true }).baseUrlOverride).toBe('https://api.example.test/v1');
  });
});
