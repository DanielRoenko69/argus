import { assertSsrfSafe } from '../backends/customBackends.js';

export type ToolFilterSecretAction = 'keep' | 'replace' | 'clear';

export interface NormalizedToolFilterMutation {
  name?: string;
  description?: string;
  webhookUrl?: string;
  timeoutMs?: number;
  toolPatterns?: string[];
  enabled?: boolean;
  onFailure?: 'allow' | 'deny';
  secretAction: ToolFilterSecretAction;
  hmacSecret?: string | null;
}

const NAME_PATTERN = /^[a-z0-9_-]{1,128}$/;
const TOOL_PATTERN = /^[A-Za-z0-9_.:%*?-]+$/;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} is too long`);
  return normalized;
}

function webhookUrl(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  const normalized = requiredString(value, 'Webhook URL');
  if (normalized.length > 2048) throw new Error('Webhook URL is too long');
  let url: URL;
  try { url = new URL(normalized); } catch { throw new Error('Webhook URL must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Webhook URL must use HTTP or HTTPS');
  if (url.username || url.password) throw new Error('Webhook URL must not contain credentials');
  assertSsrfSafe(url.toString());
  return url.toString();
}

function patterns(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Tool patterns must be an array');
  if (value.length > 50) throw new Error('At most 50 tool patterns are allowed');
  const normalized = [...new Set(value.map(item => {
    if (typeof item !== 'string') throw new Error('Every tool pattern must be a string');
    const pattern = item.trim();
    if (!pattern || pattern.length > 256 || !TOOL_PATTERN.test(pattern)) {
      throw new Error('Tool patterns may contain letters, numbers, . _ : % * ? and -');
    }
    if ((pattern.match(/[*%]/g) ?? []).length > 8) throw new Error('A tool pattern may contain at most 8 wildcards');
    return pattern;
  }))];
  return normalized;
}

export function normalizeToolFilterMutation(
  value: unknown,
  create: boolean,
): NormalizedToolFilterMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Policy configuration must be a JSON object');
  }
  const body = value as Record<string, unknown>;
  const result: NormalizedToolFilterMutation = {
    secretAction: body['secretAction'] === undefined
      ? (create && typeof body['hmacSecret'] === 'string' && body['hmacSecret'].trim() ? 'replace' : create ? 'clear' : 'keep')
      : body['secretAction'] as ToolFilterSecretAction,
  };

  if (!['keep', 'replace', 'clear'].includes(result.secretAction)) {
    throw new Error('Secret action must be keep, replace or clear');
  }
  if (create) {
    const name = requiredString(body['name'], 'Name');
    if (!NAME_PATTERN.test(name)) throw new Error('Name may contain lowercase letters, numbers, _ and -');
    result.name = name;
  } else if (body['name'] !== undefined) {
    throw new Error('Policy names are immutable');
  }

  const description = optionalString(body['description'], 'Description', 1000);
  if (description !== undefined) result.description = description;
  const url = webhookUrl(body['webhookUrl'], create);
  if (url !== undefined) result.webhookUrl = url;

  if (body['timeoutMs'] !== undefined) {
    const timeout = Number(body['timeoutMs']);
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) {
      throw new Error('Timeout must be an integer between 100 and 30000 ms');
    }
    result.timeoutMs = timeout;
  }
  const toolPatterns = patterns(body['toolPatterns']);
  if (toolPatterns !== undefined) result.toolPatterns = toolPatterns;
  if (body['enabled'] !== undefined) {
    if (typeof body['enabled'] !== 'boolean') throw new Error('Enabled must be a boolean');
    result.enabled = body['enabled'];
  }
  if (body['onFailure'] !== undefined) {
    if (!['allow', 'deny'].includes(String(body['onFailure']))) throw new Error('Failure mode must be allow or deny');
    result.onFailure = body['onFailure'] as 'allow' | 'deny';
  }

  if (result.secretAction === 'replace') {
    const secret = requiredString(body['hmacSecret'], 'HMAC secret');
    if (secret.length > 4096) throw new Error('HMAC secret is too long');
    result.hmacSecret = secret;
  } else if (result.secretAction === 'clear') {
    result.hmacSecret = null;
  } else if (body['hmacSecret'] !== undefined) {
    throw new Error('HMAC secret may only be sent when secretAction is replace');
  }

  if (create) {
    result.description ??= '';
    result.timeoutMs ??= 3000;
    result.toolPatterns ??= [];
    result.enabled ??= true;
    // New governance policies should fail closed unless explicitly relaxed.
    result.onFailure ??= 'deny';
  }
  return result;
}

export function normalizeToolFilterTest(value: unknown): {
  toolName: string;
  args: Record<string, unknown>;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Test payload must be a JSON object');
  }
  const body = value as Record<string, unknown>;
  const toolName = body['toolName'] === undefined ? 'test_tool' : requiredString(body['toolName'], 'Tool name');
  if (toolName.length > 256 || !/^[A-Za-z0-9_.:%-]+$/.test(toolName)) {
    throw new Error('Tool name contains unsupported characters');
  }
  const args = body['args'] ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Test args must be a JSON object');
  }
  const serialized = JSON.stringify(args);
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) throw new Error('Test args exceed 64 KiB');
  return { toolName, args: args as Record<string, unknown> };
}
