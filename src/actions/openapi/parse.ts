import yaml from 'js-yaml';

export type OpenApiDoc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const MAX_OPENAPI_SPEC_BYTES = 2 * 1024 * 1024;

export class OpenApiSpecParseError extends Error {
  readonly code = 'openapi_parse_failed';

  constructor() {
    super('Failed to parse OpenAPI specification');
    this.name = 'OpenApiSpecParseError';
  }
}

/** Parse an OpenAPI 3.x spec from JSON or YAML text. Throws on invalid or non-3.x input. */
export function parseSpec(text: string): OpenApiDoc {
  if (Buffer.byteLength(text, 'utf8') > MAX_OPENAPI_SPEC_BYTES) {
    throw new Error(`OpenAPI spec exceeds the ${MAX_OPENAPI_SPEC_BYTES / 1024 / 1024} MB limit`);
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error('OpenAPI spec is empty');
  let doc: unknown;
  try {
    doc = trimmed.startsWith('{') ? JSON.parse(trimmed) : yaml.load(trimmed, { schema: yaml.JSON_SCHEMA });
  } catch {
    // js-yaml error messages include source marks and line snippets. Never
    // propagate them: specifications can contain credentials and private data.
    throw new OpenApiSpecParseError();
  }
  if (!doc || typeof doc !== 'object') throw new Error('Spec is not an object');
  const d = doc as OpenApiDoc;
  if (typeof d.openapi !== 'string' || !/^3\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/.test(d.openapi)) {
    throw new Error('Only OpenAPI 3.x specs are supported (Swagger 2.0 is out of scope)');
  }
  if (!d.paths || typeof d.paths !== 'object' || Array.isArray(d.paths)) throw new Error('Spec has no valid paths object');
  return d;
}
