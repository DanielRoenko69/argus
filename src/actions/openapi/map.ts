import type { OpenApiDoc } from './parse.js';

export interface ToolParameter { name: string; type: 'string' | 'number' | 'boolean'; description: string; required: boolean; default?: string }
export interface MappedOp {
  name: string;
  description: string;
  queryTemplate: string;
  parameters: ToolParameter[];
  isWrite: boolean;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  tags: string[];
  warnings: string[];
  supported: boolean;
}
export interface MappedSecurity { auth_type: 'none' | 'bearer' | 'basic' | 'header'; headerName?: string; note?: string }

/** Map the effective OpenAPI security requirements to one backend credential shape. */
export function mapSecurity(doc: OpenApiDoc): MappedSecurity {
  const schemes = (doc.components?.securitySchemes ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const globalRequirements = Array.isArray(doc.security) ? doc.security : undefined;
  const effectiveRequirements: unknown[] = [];
  let hasSecurityDeclaration = globalRequirements !== undefined;
  let operationCount = 0;
  const paths = (doc.paths ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const item of Object.values(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = (item as Record<string, any>)[method]; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!operation || typeof operation !== 'object') continue;
      operationCount++;
      const requirements = Array.isArray(operation.security) ? operation.security : globalRequirements;
      if (requirements !== undefined) {
        hasSecurityDeclaration = true;
        effectiveRequirements.push(...requirements);
      }
    }
  }
  if (operationCount === 0 && globalRequirements) effectiveRequirements.push(...globalRequirements);
  if (!hasSecurityDeclaration) return { auth_type: 'none' };

  const requirementNames: string[] = [];
  let hasCompositeRequirement = false;
  for (const requirement of effectiveRequirements) {
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) continue;
    const names = Object.keys(requirement as Record<string, unknown>);
    if (names.length > 1) hasCompositeRequirement = true;
    requirementNames.push(...names);
  }
  const referencedNames = [...new Set(requirementNames)];
  if (referencedNames.length === 0) return { auth_type: 'none' };
  const ambiguous = hasCompositeRequirement || referencedNames.length > 1;
  const ambiguityNote = 'Multiple or combined security requirements cannot be represented by one backend credential; configure authentication manually.';

  for (const name of referencedNames) {
    const s = schemes[name];
    if (s?.type === 'apiKey' && s.in === 'header' && typeof s.name === 'string') {
      if (s.name.length > 128 || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(s.name) || RESERVED_HEADERS.has(s.name.toLowerCase())) {
        return { auth_type: 'none', note: `Unsupported or reserved API key header: ${s.name}` };
      }
      return { auth_type: 'header', headerName: s.name, ...(ambiguous ? { note: ambiguityNote } : {}) };
    }
    if (s?.type === 'http' && String(s.scheme).toLowerCase() === 'bearer') {
      return { auth_type: 'bearer', ...(ambiguous ? { note: ambiguityNote } : {}) };
    }
    if (s?.type === 'http' && String(s.scheme).toLowerCase() === 'basic') {
      return { auth_type: 'basic', ...(ambiguous ? { note: ambiguityNote } : {}) };
    }
  }
  return { auth_type: 'none', note: 'Unsupported or missing securityScheme (oauth2/apiKey-query) — set auth manually on the backend.' };
}

import { sanitizeToolName, sanitizeDescription } from '../../tools/dynamic/index.js';

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const SCALAR = new Set(['string', 'number', 'integer', 'boolean']);
const MAX_WIRE_NAME_LENGTH = 128;
const MAX_OPERATION_PATH_LENGTH = 2_048;
const RESERVED_HEADERS = new Set([
  'authorization', 'connection', 'content-length', 'cookie', 'host', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function oaType(t: unknown): 'string' | 'number' | 'boolean' {
  if (t === 'integer' || t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'string';
}

/** Map every (path, method) operation to a dynamic-tool definition. Pure. */
export function mapOperations(doc: OpenApiDoc, prefix: string): MappedOp[] {
  const out: MappedOp[] = [];
  const usedNames = new Set<string>();   // dedup generated tool names within this import
  const paths = (doc.paths ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const [method, opRaw] of Object.entries(item as Record<string, any>)) {
      const lc = method.toLowerCase();
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(lc)) continue;
      const op = opRaw as Record<string, any>;
      const explicitWrite = opRaw && typeof opRaw === 'object'
        && (opRaw as Record<string, unknown>)['x-argus-write'] === true;
      const isWrite = WRITE_METHODS.has(lc) || explicitWrite;
      const methodName = lc.toUpperCase() as MappedOp['method'];
      const warnings: string[] = [];
      if (lc === 'get' && !explicitWrite && /\b(reset|rotate|revoke|purge|trigger|execute)\b/i.test(`${path} ${String((opRaw as Record<string, unknown>).operationId ?? '')}`)) {
        warnings.push('This GET operation has an action-like name; review its write classification or set x-argus-write');
      }
      const safePathSyntax = path.startsWith('/') && !/[\r\n\s?#\\]/.test(path);
      const supportedPath = safePathSyntax && path.length <= MAX_OPERATION_PATH_LENGTH;
      if (!safePathSyntax) warnings.push('Operation path is not a safe relative HTTP path');
      else if (path.length > MAX_OPERATION_PATH_LENGTH) warnings.push('Operation path exceeds 2048 characters');

      // name — dedup on collision (truncation / punctuation-equivalent operationIds) so two distinct
      // ops never collapse to one tool (mcp_tools.name is globally UNIQUE → the 2nd would be dropped).
      const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
      const base = typeof op.operationId === 'string' && op.operationId.trim()
        ? op.operationId.trim()
        : `${lc}_${slug(path)}`;
      const rawName = sanitizeToolName(`${prefix}__${base}`).toLowerCase();
      let name = rawName;
      if (usedNames.has(name)) {
        let n = 2;
        let suffix = `_${n}`;
        let cand = `${rawName.slice(0, 64 - suffix.length)}${suffix}`;
        while (usedNames.has(cand)) {
          n++;
          suffix = `_${n}`;
          cand = `${rawName.slice(0, 64 - suffix.length)}${suffix}`;
        }
        name = cand;
      }
      usedNames.add(name);

      // params (path + query + header). The {{placeholder}} uses the SANITIZED name so it matches the
      // ToolParameter.name that renderTemplate substitutes (registerDynamicTool sanitizes param names);
      // the RAW spec name stays on the wire (the query/body key the upstream API expects).
      const params: ToolParameter[] = [];
      const usedParamNames = new Set<string>();
      const allocateParamName = (raw: string): string => {
        const sanitized = raw.replace(/[^A-Za-z0-9_]/g, '_');
        const root = (/^[A-Za-z]/.test(sanitized) ? sanitized : `p_${sanitized}`).slice(0, 64) || 'value';
        let candidate = root;
        let counter = 2;
        while (usedParamNames.has(candidate)) {
          const suffix = `_${counter++}`;
          candidate = `${root.slice(0, 64 - suffix.length)}${suffix}`;
        }
        usedParamNames.add(candidate);
        return candidate;
      };
      const queryParts: string[] = [];
      const headerParts: string[] = [];
      let hasUnsupportedRequiredParameter = false;
      const mergedParameters = new Map<string, any>();
      for (const parameter of ([...(item.parameters ?? []), ...(op.parameters ?? [])] as any[])) {
        if (parameter?.name && parameter?.in) mergedParameters.set(`${parameter.in}:${parameter.name}`, parameter);
      }
      const pathParamNames = new Map<string, string>();
      for (const p of mergedParameters.values()) {
        if (!p?.name) continue;
        const wireName = String(p.name);
        if (wireName.length > MAX_WIRE_NAME_LENGTH) {
          warnings.push(`Parameter name exceeds ${MAX_WIRE_NAME_LENGTH} characters and was skipped`);
          if (p.required === true || p.in === 'path') hasUnsupportedRequiredParameter = true;
          continue;
        }
        if (p.in === 'cookie') {
          warnings.push(`Cookie parameter ${wireName} cannot be forwarded and was skipped`);
          if (p.required === true) hasUnsupportedRequiredParameter = true;
          continue;
        }
        if (!['path', 'query', 'header'].includes(p.in)) continue;
        if (p.in === 'header' && (RESERVED_HEADERS.has(wireName.toLowerCase()) || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(wireName))) {
          warnings.push(`Header parameter ${wireName} is reserved or invalid and was skipped`);
          if (p.required === true) hasUnsupportedRequiredParameter = true;
          continue;
        }
        const pname = allocateParamName(wireName);
        params.push({ name: pname, type: oaType(p.schema?.type), description: sanitizeDescription(p.description ?? '', 200), required: p.in === 'path' || p.required === true });
        if (p.in === 'path') pathParamNames.set(wireName, pname);
        if (p.in === 'query') queryParts.push(`${encodeURIComponent(wireName)}={{${pname}}}`);
        if (p.in === 'header') headerParts.push(`${wireName}: {{${pname}}}`);
      }
      const resolvedPathTemplate = path.replace(/\{([^}]+)\}/g, (_m: string, rawName: string) => {
        let parameterName = pathParamNames.get(rawName);
        if (!parameterName) {
          parameterName = allocateParamName(rawName);
          pathParamNames.set(rawName, parameterName);
          params.push({
            name: parameterName,
            type: 'string',
            description: `Path parameter ${rawName}`,
            required: true,
          });
          warnings.push(`Path placeholder ${rawName} had no parameter definition and was inferred as string`);
        }
        return `{{${parameterName}}}`;
      });
      const queryString = queryParts.length ? `?${queryParts.join('&')}` : '';

      // requestBody → flatten ONLY when every property is a REQUIRED scalar (an omitted optional
      // number/boolean would render invalid JSON like `"age":`); otherwise a single `body` JSON param.
      let bodyTemplate = '';
      const schema = op.requestBody?.content?.['application/json']?.schema as Record<string, any> | undefined;
      const hasRequestBody = op.requestBody != null;
      const supportedRequestBody = !hasRequestBody || schema != null;
      if (hasRequestBody && !schema) {
        warnings.push('Only application/json request bodies with a schema are currently supported');
      }
      if (schema) {
        const props = schema.type === 'object' ? (schema.properties ?? {}) as Record<string, any> : null;
        const propEntries = props ? Object.entries(props) : [];
        const reqd = new Set((schema.required ?? []) as string[]);
        const allRequiredScalar = props && propEntries.length > 0
          && propEntries.every(([pn, ps]: [string, any]) => pn.length <= MAX_WIRE_NAME_LENGTH
            && SCALAR.has(ps?.type) && reqd.has(pn));
        if (allRequiredScalar) {
          const pairs: string[] = [];
          for (const [pn, ps] of propEntries) {
            const t = oaType((ps as any).type);
            const bname = allocateParamName(pn);
            params.push({ name: bname, type: t, description: sanitizeDescription((ps as any).description ?? '', 200), required: true });
            const jsonKey = JSON.stringify(pn);
            pairs.push(t === 'string' ? `${jsonKey}:"{{${bname}}}"` : `${jsonKey}:{{${bname}}}`);
          }
          bodyTemplate = `\n\n{${pairs.join(',')}}`;
        } else {
          const bodyName = allocateParamName('body');
          params.push({ name: bodyName, type: 'string', description: 'Raw JSON request body (object matching the spec schema)', required: op.requestBody?.required === true });
          bodyTemplate = `\n\n{{${bodyName}}}`;
        }
      }

      const headerTemplate = headerParts.length ? `\n${headerParts.join('\n')}` : '';
      const queryTemplate = `${methodName} ${resolvedPathTemplate}${queryString}${headerTemplate}${bodyTemplate}`;
      const description = sanitizeDescription(`${op.summary ?? ''} ${op.description ?? ''}`.trim() + ` [${lc.toUpperCase()} ${path}]`, 500);
      if (params.length > 50) warnings.push('Operation exposes more than 50 parameters');
      out.push({
        name,
        description,
        queryTemplate,
        parameters: params,
        isWrite,
        method: methodName,
        path,
        tags: Array.isArray(op.tags) ? op.tags
          .filter((tag: unknown): tag is string => typeof tag === 'string')
          .slice(0, 20)
          .map((tag: string) => sanitizeDescription(tag, 64)) : [],
        warnings,
        supported: supportedPath && supportedRequestBody && !hasUnsupportedRequiredParameter && params.length <= 50,
      });
    }
  }
  return out;
}
