import { describe, it, expect } from '@jest/globals';
import { mapOperations } from '../map.js';
import { renderTemplate } from '../../../tools/dynamic/index.js';

const doc = {
  openapi: '3.0.0', info: { title: 'Pets' }, paths: {
    '/pets/{petId}': {
      get: { operationId: 'getPet', summary: 'Get a pet',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
                     { name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } }] },
    },
    '/pets': {
      // name required, age OPTIONAL → must NOT flatten (an omitted "age" would render invalid JSON)
      post: { operationId: 'createPet', summary: 'Create',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'],
          properties: { name: { type: 'string' }, age: { type: 'integer' } } } } } } },
    },
    '/tags': {
      // ALL props required scalar → flatten
      post: { operationId: 'createTag',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['label', 'weight'],
          properties: { label: { type: 'string' }, weight: { type: 'integer' } } } } } } },
    },
  },
};

describe('mapOperations', () => {
  it('maps a GET to a read tool with path + query params', () => {
    const ops = mapOperations(doc, 'pets');
    const get = ops.find((o) => o.name === 'pets__getpet')!;
    expect(get.isWrite).toBe(false);
    expect(get.queryTemplate).toBe('GET /pets/{{petId}}?verbose={{verbose}}');
    expect(get.parameters.map((p) => p.name).sort()).toEqual(['petId', 'verbose']);
    expect(get.parameters.find((p) => p.name === 'petId')!.required).toBe(true);
  });

  it('uses a single body param when the body has an OPTIONAL scalar (avoids invalid-JSON render)', () => {
    const post = mapOperations(doc, 'pets').find((o) => o.name === 'pets__createpet')!;
    expect(post.isWrite).toBe(true);
    expect(post.parameters.map((p) => p.name)).toEqual(['body']);
    expect(post.queryTemplate).toBe('POST /pets\n\n{{body}}');
  });

  it('flattens a body when EVERY scalar prop is required', () => {
    const post = mapOperations(doc, 'pets').find((o) => o.name === 'pets__createtag')!;
    expect(post.parameters.map((p) => p.name).sort()).toEqual(['label', 'weight']);
    expect(post.parameters.find((p) => p.name === 'weight')!.type).toBe('number');
    expect(post.queryTemplate).toBe('POST /tags\n\n{"label":"{{label}}","weight":{{weight}}}');
  });

  it('JSON-escapes upstream property names in flattened body templates', () => {
    const operation = mapOperations({
      openapi: '3.0.0',
      paths: {
        '/items': {
          post: {
            operationId: 'create',
            requestBody: { required: true, content: { 'application/json': { schema: {
              type: 'object', required: ['display"name'],
              properties: { 'display"name': { type: 'string' } },
            } } } },
          },
        },
      },
    }, 'svc')[0]!;
    expect(operation.queryTemplate).toBe('POST /items\n\n{"display\\"name":"{{display_name}}"}');
    expect(() => renderTemplate(operation.queryTemplate, { display_name: 'Ada' }, operation.parameters)).not.toThrow();
  });

  it('sanitizes placeholder names (dotted path / bracketed query / dotted body key) to match the param def, keeping the raw name on the wire', () => {
    const d = {
      openapi: '3.0.0', paths: {
        '/items/{item.id}': {
          post: {
            operationId: 'doItem',
            parameters: [
              { name: 'item.id', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'filter[status]', in: 'query', required: true, schema: { type: 'string' } },
            ],
            requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['user.name'],
              properties: { 'user.name': { type: 'string' } } } } } },
          },
        },
      },
    };
    const op = mapOperations(d, 'svc')[0];
    // param defs use sanitized names (matching how registerDynamicTool sanitizes + renderTemplate
    // substitutes): 'filter[status]' → 'filter_status_' (both brackets → '_'), 'item.id' → 'item_id'.
    expect(op.parameters.map((p) => p.name).sort()).toEqual(['filter_status_', 'item_id', 'user_name']);
    // path value substituted by sanitized placeholder; query/body KEYS keep the raw spec name
    expect(op.queryTemplate).toBe('POST /items/{{item_id}}?filter%5Bstatus%5D={{filter_status_}}\n\n{"user.name":"{{user_name}}"}');
  });

  it('dedups colliding generated names so distinct ops yield distinct tools', () => {
    const d = {
      openapi: '3.0.0', paths: {
        '/a': { get: { operationId: 'get.user' } },
        '/b': { get: { operationId: 'get_user' } }, // both sanitize to svc__get_user
      },
    };
    const names = mapOperations(d, 'svc').map((o) => o.name);
    expect(new Set(names).size).toBe(2);          // no collision-drop
    expect(names).toContain('svc__get_user');
    expect(names.some((n) => /svc__get_user_2$/.test(n))).toBe(true);
  });

  it('falls back to method_path when no operationId', () => {
    const ops = mapOperations({ openapi: '3.0.0', paths: { '/a/b': { get: {} } } }, 'x');
    expect(ops[0].name).toBe('x__get_a_b');
  });

  it('deduplicates colliding 64-character names without looping or exceeding the limit', () => {
    const long = 'a'.repeat(80);
    const operations = mapOperations({
      openapi: '3.0.0',
      paths: {
        '/one': { get: { operationId: `${long}x` } },
        '/two': { get: { operationId: `${long}y` } },
      },
    }, 'prefix');
    expect(operations).toHaveLength(2);
    expect(operations[0]!.name).toHaveLength(64);
    expect(operations[1]!.name).toHaveLength(64);
    expect(operations[1]!.name).toMatch(/_2$/);
    expect(new Set(operations.map(operation => operation.name)).size).toBe(2);
  });

  it('merges path-level parameters and renders safe per-operation headers', () => {
    const operation = mapOperations({
      openapi: '3.0.0',
      paths: {
        '/tenants/{tenantId}/items': {
          parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
          get: {
            parameters: [{ name: 'X-Trace-Id', in: 'header', required: true, schema: { type: 'string' } }],
          },
        },
      },
    }, 'svc')[0]!;
    expect(operation.queryTemplate).toBe('GET /tenants/{{tenantId}}/items\nX-Trace-Id: {{X_Trace_Id}}');
    expect(operation.parameters.map(parameter => parameter.name).sort()).toEqual(['X_Trace_Id', 'tenantId']);
  });

  it('does not import operations that require blocked header or cookie parameters', () => {
    const operations = mapOperations({
      openapi: '3.0.0',
      paths: {
        '/header': { get: { parameters: [{ name: 'Authorization', in: 'header', required: true, schema: { type: 'string' } }] } },
        '/cookie': { get: { parameters: [{ name: 'session', in: 'cookie', required: true, schema: { type: 'string' } }] } },
        '/optional': { get: { parameters: [{ name: 'Cookie', in: 'header', required: false, schema: { type: 'string' } }] } },
      },
    }, 'svc');
    expect(operations.find(operation => operation.path === '/header')).toMatchObject({ supported: false });
    expect(operations.find(operation => operation.path === '/cookie')).toMatchObject({ supported: false });
    expect(operations.find(operation => operation.path === '/optional')).toMatchObject({ supported: true });
  });

  it('bounds upstream-controlled paths, wire names, tags and descriptions', () => {
    const longName = 'q'.repeat(129);
    const operations = mapOperations({
      openapi: '3.0.0',
      paths: {
        [`/${'x'.repeat(2048)}`]: { get: { operationId: 'longPath' } },
        '/parameter': {
          get: {
            operationId: 'longParameter',
            summary: 's'.repeat(900),
            tags: ['t'.repeat(100)],
            parameters: [{ name: longName, in: 'query', required: true, schema: { type: 'string' } }],
          },
        },
      },
    }, 'svc');
    expect(operations.find(operation => operation.name === 'svc__longpath')).toMatchObject({ supported: false });
    const parameter = operations.find(operation => operation.name === 'svc__longparameter')!;
    expect(parameter.supported).toBe(false);
    expect(parameter.tags[0]).toHaveLength(64);
    expect(parameter.description.length).toBeLessThanOrEqual(500);
  });

  it('keeps a generic request body as validated raw JSON end to end', () => {
    const operation = mapOperations(doc, 'pets').find((candidate) => candidate.name === 'pets__createpet')!;
    const raw = '{"name":"Ada","nested":{"active":true}}';
    expect(renderTemplate(operation.queryTemplate, { body: raw }, operation.parameters))
      .toBe(`POST /pets\n\n${raw}`);
    expect(() => renderTemplate(operation.queryTemplate, { body: '{bad json}' }, operation.parameters))
      .toThrow(/invalid JSON body/i);
  });
});
