import { describe, it, expect } from '@jest/globals';
import { OpenApiSpecParseError, parseSpec } from '../parse.js';

describe('parseSpec', () => {
  it('parses JSON', () => {
    const doc = parseSpec('{"openapi":"3.0.0","info":{"title":"T"},"paths":{}}');
    expect(doc.openapi).toBe('3.0.0');
    expect(doc.info.title).toBe('T');
  });
  it('parses YAML', () => {
    const doc = parseSpec('openapi: 3.1.0\ninfo:\n  title: Y\npaths: {}\n');
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Y');
  });
  it('throws on invalid text', () => {
    expect(() => parseSpec('not a spec: [unclosed')).toThrow(/parse/i);
  });
  it('never includes invalid YAML source snippets in parse errors', () => {
    const secret = 'super-secret-api-key';
    let thrown: unknown;
    try { parseSpec(`openapi: 3.0.3\nsecret: ${secret}\npaths: [unclosed`); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(OpenApiSpecParseError);
    expect(thrown).toMatchObject({ code: 'openapi_parse_failed' });
    expect(String((thrown as Error).message)).toBe('Failed to parse OpenAPI specification');
    expect(JSON.stringify(thrown)).not.toContain(secret);
  });
  it('throws on a non-OpenAPI-3 doc', () => {
    expect(() => parseSpec('{"swagger":"2.0","paths":{}}')).toThrow(/OpenAPI 3/i);
  });
});
