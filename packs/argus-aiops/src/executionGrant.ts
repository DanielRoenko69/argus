export interface PackExecutionGrant {
  token: string;
  claims: {
    jti: string;
    bundleIds: number[];
    toolNames?: string[];
    coreAgentIds: number[];
    coreAgents: Array<{ name: string; id: number }>;
    principalKind: 'user' | 'api_key' | 'service';
    principalId: string;
    messageId: string;
    rootTraceId: string;
    resourceScope?: PackExecutionResourceScope;
    aiopsServiceContext?: {
      profileId: number;
      revision: number;
      profileSha256: string;
      resolvedContextSha256: string;
    };
    iat: number;
    exp: number;
  };
}

export interface PackExecutionResourceScope {
  kind: 'kubernetes';
  backendId: number;
  targetId: string;
  cluster: string;
  namespace: string;
  environment: string;
}

export class PackExecutionGrantError extends Error {}

function positiveIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 128
    && value.every(item => Number.isInteger(item) && Number(item) > 0);
}

function coreAgentBindings(value: unknown, allowedIds: number[]): value is Array<{ name: string; id: number }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) return false;
  const names = new Set<string>();
  const ids = new Set<number>();
  const allowed = new Set(allowedIds);
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const binding = item as Record<string, unknown>;
    if (typeof binding['name'] !== 'string' || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(binding['name'])
      || !Number.isInteger(binding['id']) || Number(binding['id']) <= 0 || !allowed.has(Number(binding['id']))
      || names.has(binding['name']) || ids.has(Number(binding['id']))) return false;
    names.add(binding['name']);
    ids.add(Number(binding['id']));
  }
  return true;
}

function executionResourceScope(value: unknown): value is PackExecutionResourceScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return scope['kind'] === 'kubernetes'
    && Number.isInteger(scope['backendId']) && Number(scope['backendId']) > 0
    && typeof scope['targetId'] === 'string' && /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(scope['targetId'])
    && typeof scope['cluster'] === 'string' && scope['cluster'].length > 0 && scope['cluster'].length <= 200
    && typeof scope['namespace'] === 'string' && scope['namespace'].length <= 63
    && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(scope['namespace'])
    && typeof scope['environment'] === 'string' && scope['environment'].length > 0 && scope['environment'].length <= 120;
}

function aiopsServiceContext(value: unknown): value is NonNullable<PackExecutionGrant['claims']['aiopsServiceContext']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return Number.isInteger(context['profileId']) && Number(context['profileId']) > 0
    && Number.isInteger(context['revision']) && Number(context['revision']) > 0
    && typeof context['profileSha256'] === 'string' && /^[a-f0-9]{64}$/.test(context['profileSha256'])
    && typeof context['resolvedContextSha256'] === 'string' && /^[a-f0-9]{64}$/.test(context['resolvedContextSha256']);
}

/**
 * Decode only enough claims to bind Pack state to the Core-issued grant. The
 * Pack cannot mint or widen grants; privileged callbacks must send the compact
 * token back to Core, where signature and active-state checks are authoritative.
 */
export function decodePackExecutionGrant(
  token: string,
  expected: { packId: string; agentId: string; messageId: string; rootTraceId: string },
  nowMs = Date.now(),
): PackExecutionGrant {
  if (token.length > 16_384) throw new PackExecutionGrantError('execution grant is too large');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'eg_v1' || !parts[1] || !parts[2]) {
    throw new PackExecutionGrantError('execution grant format is invalid');
  }
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    raw = parsed as Record<string, unknown>;
  } catch {
    throw new PackExecutionGrantError('execution grant payload is invalid');
  }
  const principalKind = raw['principalKind'];
  const coreAgentIds = positiveIds(raw['coreAgentIds']) ? raw['coreAgentIds'] : [];
  if (raw['v'] !== 1 || raw['iss'] !== 'argus.core'
    || raw['aud'] !== expected.packId || raw['agent'] !== expected.agentId
    || raw['messageId'] !== expected.messageId || raw['rootTraceId'] !== expected.rootTraceId
    || typeof raw['jti'] !== 'string' || typeof raw['principalId'] !== 'string'
    || !['user', 'api_key', 'service'].includes(String(principalKind))
    || !positiveIds(raw['bundleIds']) || !positiveIds(raw['coreAgentIds'])
    || !coreAgentBindings(raw['coreAgents'], coreAgentIds)
    || raw['resourceScope'] !== undefined && !executionResourceScope(raw['resourceScope'])
    || raw['toolNames'] !== undefined && (!Array.isArray(raw['toolNames']) || raw['toolNames'].length > 256
      || raw['toolNames'].some(name => typeof name !== 'string' || name.length < 1 || name.length > 200))
    || raw['aiopsServiceContext'] !== undefined && !aiopsServiceContext(raw['aiopsServiceContext'])
    || raw['aiopsServiceContext'] !== undefined && raw['toolNames'] === undefined
    || typeof raw['iat'] !== 'number' || typeof raw['exp'] !== 'number') {
    throw new PackExecutionGrantError('execution grant is not bound to this Pack task');
  }
  const now = Math.floor(nowMs / 1000);
  if (raw['iat'] > now + 30 || raw['exp'] <= now || raw['exp'] - raw['iat'] > 3600) {
    throw new PackExecutionGrantError('execution grant is expired or has an invalid lifetime');
  }
  return {
    token,
    claims: {
      jti: raw['jti'],
      bundleIds: [...new Set(raw['bundleIds'])],
      ...(raw['toolNames'] !== undefined ? { toolNames: [...new Set(raw['toolNames'] as string[])] } : {}),
      coreAgentIds: [...new Set(raw['coreAgentIds'])],
      coreAgents: raw['coreAgents'].map(binding => ({ ...binding })),
      principalKind: principalKind as PackExecutionGrant['claims']['principalKind'],
      principalId: raw['principalId'],
      messageId: raw['messageId'],
      rootTraceId: raw['rootTraceId'],
      ...(raw['resourceScope'] !== undefined ? { resourceScope: { ...(raw['resourceScope'] as PackExecutionResourceScope) } } : {}),
      ...(raw['aiopsServiceContext'] !== undefined ? { aiopsServiceContext: { ...(raw['aiopsServiceContext'] as NonNullable<PackExecutionGrant['claims']['aiopsServiceContext']>) } } : {}),
      iat: raw['iat'],
      exp: raw['exp'],
    },
  };
}
