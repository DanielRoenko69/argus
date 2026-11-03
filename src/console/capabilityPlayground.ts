import type pg from 'pg';
import {
  assertCustomBackendTargetSafe,
  executeCustomBackendStructured,
  getCustomBackendResponseLimit,
  resolveCustomBackendTarget,
  type CustomBackendResponse,
  type CustomBackendRow,
} from '../backends/customBackends.js';
import {
  parseHttpRequestSpec,
  renderTemplate,
  type ToolParameter,
} from '../tools/dynamic/index.js';

const MAX_INPUT_BYTES = 128 * 1_024;
const MAX_STRING_PARAMETER_BYTES = 64 * 1_024;
const SENSITIVE_NAME_PATTERN = /(?:authorization|cookie|password|passwd|passphrase|session|jwt|secret|token|credential|api[-_]?key|private[-_]?key|access[-_]?key)/i;

interface CapabilityRow {
  id: number;
  name: string;
  backend: string;
  query_template: string | null;
  parameters: ToolParameter[] | string | null;
  enabled: boolean;
  tool_type: 'dynamic' | 'builtin';
  is_write: boolean;
  risk_level: 'low' | 'medium' | 'high';
  required_auth_mode: 'service-account' | 'permissive' | 'strict' | null;
}

export interface CapabilityPlaygroundInput {
  parameters?: unknown;
  execute?: unknown;
  confirmWrite?: unknown;
}

export interface CapabilityPlaygroundResult {
  capability: {
    id: string;
    name: string;
    enabled: boolean;
    isWrite: boolean;
    riskLevel: 'low' | 'medium' | 'high';
  };
  request: {
    method: string;
    target: string;
    headers: Record<string, string>;
    body: string | null;
  };
  executed: boolean;
  response?: CustomBackendResponse;
}

export class CapabilityPlaygroundError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 = 400) {
    super(message);
    this.name = 'CapabilityPlaygroundError';
  }
}

function parseManagedId(rawId: string): number {
  const match = rawId.match(/^(?:managed:)?([1-9]\d*)$/);
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id) || id > 2_147_483_647) {
    throw new CapabilityPlaygroundError('Capability-ID ist ungültig');
  }
  return id;
}

function normalizeInput(input: CapabilityPlaygroundInput): {
  parameters: Record<string, unknown>;
  execute: boolean;
  confirmWrite: boolean;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CapabilityPlaygroundError('Playground-Daten fehlen');
  }
  const unknownField = Object.keys(input).find(key => !['parameters', 'execute', 'confirmWrite'].includes(key));
  if (unknownField) throw new CapabilityPlaygroundError(`Unbekanntes Playground-Feld: ${unknownField}`);
  if (input.parameters == null || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) {
    throw new CapabilityPlaygroundError('Parameter müssen als Objekt übergeben werden');
  }
  if (input.execute != null && typeof input.execute !== 'boolean') {
    throw new CapabilityPlaygroundError('Execute muss ein Boolean sein');
  }
  if (input.confirmWrite != null && typeof input.confirmWrite !== 'boolean') {
    throw new CapabilityPlaygroundError('Write-Bestätigung muss ein Boolean sein');
  }
  let inputBytes: number;
  try {
    inputBytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  } catch {
    throw new CapabilityPlaygroundError('Playground-Daten sind nicht serialisierbar');
  }
  if (inputBytes > MAX_INPUT_BYTES) throw new CapabilityPlaygroundError('Playground-Daten überschreiten 128 KB');
  return {
    parameters: input.parameters as Record<string, unknown>,
    execute: input.execute === true,
    confirmWrite: input.confirmWrite === true,
  };
}

function parseParameterDefinitions(raw: CapabilityRow['parameters']): ToolParameter[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); }
    catch { throw new CapabilityPlaygroundError('Capability-Parameter sind beschädigt', 409); }
  }
  if (!Array.isArray(value) || value.length > 50) {
    throw new CapabilityPlaygroundError('Capability-Parameter sind beschädigt', 409);
  }
  const names = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new CapabilityPlaygroundError('Capability-Parameter sind beschädigt', 409);
    const parameter = entry as Partial<ToolParameter>;
    if (typeof parameter.name !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(parameter.name)
      || names.has(parameter.name)
      || !['string', 'number', 'boolean'].includes(String(parameter.type))
      || typeof parameter.required !== 'boolean') {
      throw new CapabilityPlaygroundError('Capability-Parameter sind beschädigt', 409);
    }
    names.add(parameter.name);
    return {
      name: parameter.name,
      type: parameter.type as ToolParameter['type'],
      description: typeof parameter.description === 'string' ? parameter.description : '',
      required: parameter.required,
      ...(typeof parameter.default === 'string' ? { default: parameter.default } : {}),
    };
  });
}

function validateParameters(
  values: Record<string, unknown>,
  definitions: ToolParameter[],
): { values: Record<string, unknown>; sensitiveValues: string[] } {
  const byName = new Map(definitions.map(parameter => [parameter.name, parameter]));
  const unknownName = Object.keys(values).find(name => !byName.has(name));
  if (unknownName) throw new CapabilityPlaygroundError(`Unbekannter Parameter: ${unknownName}`);
  const normalized: Record<string, unknown> = {};
  const sensitiveValues: string[] = [];
  for (const definition of definitions) {
    const supplied = Object.prototype.hasOwnProperty.call(values, definition.name);
    let value = supplied ? values[definition.name] : definition.default;
    if (!supplied && definition.default != null) {
      if (definition.type === 'number') {
        value = Number(definition.default);
        if (!Number.isFinite(value)) {
          throw new CapabilityPlaygroundError(`Default von Parameter ${definition.name} ist ungültig`, 409);
        }
      } else if (definition.type === 'boolean') {
        if (definition.default !== 'true' && definition.default !== 'false') {
          throw new CapabilityPlaygroundError(`Default von Parameter ${definition.name} ist ungültig`, 409);
        }
        value = definition.default === 'true';
      }
    }
    if (value == null || value === '') {
      if (definition.required && definition.default == null) {
        throw new CapabilityPlaygroundError(`Pflichtparameter fehlt: ${definition.name}`);
      }
      continue;
    }
    if (definition.type === 'string') {
      if (typeof value !== 'string') throw new CapabilityPlaygroundError(`Parameter ${definition.name} muss Text sein`);
      if (Buffer.byteLength(value, 'utf8') > MAX_STRING_PARAMETER_BYTES) {
        throw new CapabilityPlaygroundError(`Parameter ${definition.name} überschreitet 64 KB`);
      }
    } else if (definition.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CapabilityPlaygroundError(`Parameter ${definition.name} muss eine endliche Zahl sein`);
      }
    } else if (typeof value !== 'boolean') {
      throw new CapabilityPlaygroundError(`Parameter ${definition.name} muss ein Boolean sein`);
    }
    normalized[definition.name] = value;
    if (SENSITIVE_NAME_PATTERN.test(definition.name)) sensitiveValues.push(String(value));
  }
  return { values: normalized, sensitiveValues };
}

function replaceSensitiveValues(value: string, sensitiveValues: string[]): string {
  let output = value;
  for (const secret of [...new Set(sensitiveValues)].sort((left, right) => right.length - left.length)) {
    if (secret.length < 4) continue;
    output = output.replaceAll(secret, '[REDACTED]');
    try { output = output.replaceAll(encodeURIComponent(secret), '[REDACTED]'); }
    catch { /* strings are already validated */ }
  }
  return output;
}

function redactJson(value: unknown, sensitiveValues: string[]): unknown {
  if (Array.isArray(value)) return value.map(item => redactJson(item, sensitiveValues));
  if (value && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_NAME_PATTERN.test(key)) {
        if (typeof child === 'string' || typeof child === 'number') sensitiveValues.push(String(child));
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = redactJson(child, sensitiveValues);
      }
    }
    return redacted;
  }
  if (typeof value === 'string' && sensitiveValues.includes(value)) return '[REDACTED]';
  if (typeof value === 'number' && sensitiveValues.includes(String(value))) return '[REDACTED]';
  return value;
}

function templateBody(template: string): string {
  const lines = template.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '') return lines.slice(index + 1).join('\n');
    if (/^\s*[{[]/.test(lines[index] ?? '')) return lines.slice(index).join('\n');
  }
  return '';
}

function maskBody(
  body: string | undefined,
  template: string,
  definitions: ToolParameter[],
  sensitiveValues: string[],
): string | null {
  if (!body) return null;
  const rawTemplateBody = templateBody(template);
  if (definitions.some(definition => SENSITIVE_NAME_PATTERN.test(definition.name)
    && rawTemplateBody.includes(`{{${definition.name}}}`))) {
    return '[REDACTED]';
  }
  try {
    return replaceSensitiveValues(JSON.stringify(redactJson(JSON.parse(body), sensitiveValues)), sensitiveValues);
  } catch {
    // Raw non-JSON request bodies may contain credentials with no key context.
    return '[REDACTED]';
  }
}

function maskTarget(target: string): string {
  const redacted = new URL(target);
  for (const key of [...redacted.searchParams.keys()]) {
    if (SENSITIVE_NAME_PATTERN.test(key)) redacted.searchParams.set(key, '[REDACTED]');
  }
  return redacted.toString();
}

function maskHeaders(
  headers: Record<string, string>,
  template: string,
  definitions: ToolParameter[],
  sensitiveValues: string[],
): Record<string, string> {
  const sensitivePlaceholders = definitions
    .filter(definition => SENSITIVE_NAME_PATTERN.test(definition.name))
    .map(definition => `{{${definition.name}}}`);
  const headerLines = template.split('\n').slice(1);
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    const templateLine = headerLines.find(line => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    const containsSensitivePlaceholder = sensitivePlaceholders.some(placeholder => templateLine?.includes(placeholder));
    return [
      name,
      SENSITIVE_NAME_PATTERN.test(name) || containsSensitivePlaceholder
        ? '[REDACTED]'
        : replaceSensitiveValues(value, sensitiveValues),
    ];
  }));
}

function maskResponse(response: CustomBackendResponse, knownSensitiveValues: string[]): CustomBackendResponse {
  const sensitiveValues = [...knownSensitiveValues];
  let body = response.body;
  try {
    body = JSON.stringify(redactJson(JSON.parse(body), sensitiveValues));
  } catch {
    body = body
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  }
  const bytes = Buffer.from(body);
  const maxResponseBytes = getCustomBackendResponseLimit();
  return {
    ...response,
    body: bytes.subarray(0, maxResponseBytes).toString('utf8'),
    truncated: response.truncated || bytes.byteLength > maxResponseBytes,
  };
}

function isExplicitReadOnlyPost(
  capability: CapabilityRow,
  backend: CustomBackendRow,
  method: string,
  target: string,
): boolean {
  if (method !== 'POST' || capability.is_write) return false;
  if (backend.config?.['credential_mode'] !== 'readonly-service-identity') return false;
  const configuredPaths = backend.config?.['read_only_post_paths'];
  if (!Array.isArray(configuredPaths) || configuredPaths.length > 100) return false;
  let pathname: string;
  try { pathname = new URL(target, 'http://argus.invalid').pathname; }
  catch { return false; }
  return configuredPaths.some(path => typeof path === 'string' && path === pathname);
}

export async function runCapabilityPlayground(
  pool: pg.Pool,
  rawId: string,
  rawInput: CapabilityPlaygroundInput,
): Promise<CapabilityPlaygroundResult> {
  const id = parseManagedId(rawId);
  const input = normalizeInput(rawInput);
  const capability = (await pool.query<CapabilityRow>(
    `SELECT id, name, backend, query_template, parameters, enabled, tool_type,
            COALESCE(is_write, false) AS is_write,
            COALESCE(risk_level, 'low') AS risk_level,
            required_auth_mode
       FROM mcp_tools
      WHERE id = $1`,
    [id],
  )).rows[0];
  if (!capability) throw new CapabilityPlaygroundError('Capability wurde nicht gefunden', 404);
  if (capability.tool_type !== 'dynamic' || !capability.backend.startsWith('custom:') || !capability.query_template) {
    throw new CapabilityPlaygroundError('Der Playground unterstützt derzeit nur Connected-System HTTP-Capabilities');
  }

  const backendName = capability.backend.slice('custom:'.length);
  const backend = (await pool.query<CustomBackendRow>(
    `SELECT backend.*,
            COALESCE(ARRAY(
              SELECT assignment.bundle_id
                FROM mcp_backend_bundles assignment
               WHERE assignment.backend_id = backend.id
               ORDER BY assignment.bundle_id
            ), '{}')::int[] AS bundle_ids
       FROM mcp_backends backend
      WHERE backend.name = $1`,
    [backendName],
  )).rows[0];
  if (!backend || backend.backend_type !== 'http') {
    throw new CapabilityPlaygroundError('Connected-System HTTP-Backend wurde nicht gefunden', 409);
  }
  if (!backend.enabled) throw new CapabilityPlaygroundError('Die Connection ist deaktiviert und kann nicht getestet werden', 409);

  const definitions = parseParameterDefinitions(capability.parameters);
  const validated = validateParameters(input.parameters, definitions);
  let request;
  try {
    request = parseHttpRequestSpec(renderTemplate(capability.query_template, validated.values, definitions));
  } catch {
    throw new CapabilityPlaygroundError('Request konnte nicht sicher gerendert werden', 400);
  }
  const isWrite = capability.is_write
    || (request.method !== 'GET' && !isExplicitReadOnlyPost(capability, backend, request.method, request.target));
  const riskLevel = isWrite && capability.risk_level === 'low' ? 'high' : capability.risk_level;
  const previewValues = { ...validated.values };
  for (const definition of definitions) {
    if (SENSITIVE_NAME_PATTERN.test(definition.name) && Object.prototype.hasOwnProperty.call(previewValues, definition.name)) {
      previewValues[definition.name] = '[REDACTED]';
    }
  }
  let previewTarget = request.target;
  try {
    const requestLine = capability.query_template.split('\n', 1)[0] ?? '';
    previewTarget = parseHttpRequestSpec(renderTemplate(requestLine, previewValues, definitions)).target;
  } catch {
    // Structural fallback: query/body/header masking below remains fail-safe;
    // exact replacement is intentionally limited to non-trivial values.
    previewTarget = replaceSensitiveValues(request.target, validated.sensitiveValues);
  }
  try {
    await assertCustomBackendTargetSafe(backend, request.target);
  } catch {
    throw new CapabilityPlaygroundError('Request-Ziel ist nicht erlaubt');
  }
  const target = resolveCustomBackendTarget(backend, previewTarget);
  const result: CapabilityPlaygroundResult = {
    capability: {
      id: `managed:${capability.id}`,
      name: capability.name,
      enabled: capability.enabled,
      isWrite,
      riskLevel,
    },
    request: {
      method: request.method,
      target: maskTarget(target),
      headers: maskHeaders(request.headers, capability.query_template, definitions, validated.sensitiveValues),
      body: maskBody(request.body, capability.query_template, definitions, validated.sensitiveValues),
    },
    executed: false,
  };
  if (!input.execute) return result;
  if (isWrite && !input.confirmWrite) {
    throw new CapabilityPlaygroundError('Schreibende Requests benötigen eine explizite Write-Bestätigung');
  }

  try {
    const response = await executeCustomBackendStructured(
      backend,
      request.method,
      request.target,
      request.body,
      capability.required_auth_mode,
      undefined,
      request.headers,
      { maxResponseBytes: getCustomBackendResponseLimit(), redactValues: validated.sensitiveValues },
    );
    return { ...result, executed: true, response: maskResponse(response, validated.sensitiveValues) };
  } catch {
    throw new CapabilityPlaygroundError('Capability-Ausführung am Upstream fehlgeschlagen', 502);
  }
}
