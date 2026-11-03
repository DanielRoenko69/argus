import { describe, it, expect } from '@jest/globals';
import { resolveLocalRefs } from '../refs.js';

describe('resolveLocalRefs', () => {
  it('inlines a local #/components ref', () => {
    const doc = {
      openapi: '3.0.0', paths: {},
      components: { parameters: { PetId: { name: 'petId', in: 'path', required: true, schema: { type: 'string' } } } },
      _t: { $ref: '#/components/parameters/PetId' },
    };
    const out = resolveLocalRefs(doc) as any;
    expect(out._t.name).toBe('petId');
    expect(out._t.$ref).toBeUndefined();
  });
  it('throws on an external ref', () => {
    expect(() => resolveLocalRefs({ openapi: '3.0.0', paths: {}, x: { $ref: 'https://evil/x.json#/a' } }))
      .toThrow(/external/i);
  });
  it('is cycle-safe (self-referential schema)', () => {
    const doc: any = { openapi: '3.0.0', paths: {}, components: { schemas: { Node: { type: 'object', properties: {} } } } };
    doc.components.schemas.Node.properties.next = { $ref: '#/components/schemas/Node' };
    const out = resolveLocalRefs(doc) as any;
    expect(out.components.schemas.Node.properties.next.type).toBe('object');
  });
  it('rejects a direct $ref→$ref cycle with a clear error (not a stack overflow)', () => {
    const doc = { openapi: '3.0.0', paths: {}, components: { schemas: { A: { $ref: '#/components/schemas/A' } } }, x: { $ref: '#/components/schemas/A' } };
    expect(() => resolveLocalRefs(doc)).toThrow(/circular \$ref/i);
  });
  it('rejects a mutual $ref↔$ref cycle', () => {
    const doc = { openapi: '3.0.0', paths: {}, components: { schemas: { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' } } }, x: { $ref: '#/components/schemas/A' } };
    expect(() => resolveLocalRefs(doc)).toThrow(/circular \$ref/i);
  });
});
