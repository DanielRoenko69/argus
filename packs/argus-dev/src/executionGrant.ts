import { parseCodegenAuthority } from './codeGenerationContract.js';
export interface PackExecutionGrantClaims {
  jti: string;
  aud: string;
  agent: string;
  principalKind: 'user' | 'api_key' | 'service';
  principalId: string;
  bundleIds: number[];
  coreAgentIds: number[];
  runtimeProfileOverrides?: Array<{
    agentId: number;
    runtimeProfileId: number;
    runtimeType: 'argus' | 'codex' | 'claude-code' | 'hermes';
    runtimeProfileName: string;
  }>;
  messageId: string;
  rootTraceId: string;
  workspaceRoot?: string;
  testEnvironmentPolicy?: 'general-stack-v1' | 'workspace-session-v1';
  codeGeneration?: { version: 1; allowedPaths: string[] };
  iat: number;
  exp: number;
}

export interface PackExecutionGrant {
  token: string;
  claims: PackExecutionGrantClaims;
}

export class PackExecutionGrantError extends Error {}

function positiveIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 128
    && value.every(item => Number.isInteger(item) && Number(item) > 0);
}

function runtimeProfileOverrides(value: unknown, coreAgentIds: number[]): value is NonNullable<PackExecutionGrantClaims['runtimeProfileOverrides']> {
  if (!Array.isArray(value) || value.length > 16) return false;
  const seen = new Set<number>();
  return value.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    const agentId = record['agentId'];
    const profileId = record['runtimeProfileId'];
    const runtimeType = record['runtimeType'];
    const profileName = record['runtimeProfileName'];
    if (!Number.isInteger(agentId) || Number(agentId) <= 0 || seen.has(Number(agentId))
      || !coreAgentIds.includes(Number(agentId))
      || !Number.isInteger(profileId) || Number(profileId) <= 0
      || !['argus', 'codex', 'claude-code', 'hermes'].includes(String(runtimeType))
      || typeof profileName !== 'string' || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(profileName)) return false;
    seen.add(Number(agentId));
    return true;
  });
}

/**
 * Routing hint from an opaque Core grant. It is never authorization: the
 * selected Core endpoint verifies the signature and exact profile binding.
 */
export function runtimeOverrideFromExecutionGrant(
  token: string,
  agentId: number,
): NonNullable<PackExecutionGrantClaims['runtimeProfileOverrides']>[number] | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const coreAgentIds = positiveIds(raw['coreAgentIds']) ? raw['coreAgentIds'] : [];
    if (!runtimeProfileOverrides(raw['runtimeProfileOverrides'], coreAgentIds)) return null;
    return raw['runtimeProfileOverrides'].find(item => item.agentId === agentId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Parses the Core-signed grant only to bind Pack runtime state. Argus Dev does
 * not possess the Core signing secret and therefore cannot mint or widen a
 * grant. Every privileged callback sends the original compact token to Core,
 * where signature, expiry, active-state and exact scope are authoritative.
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
  let codeGeneration: PackExecutionGrantClaims['codeGeneration'];
  if (raw['codeGeneration'] !== undefined) {
    try {
      codeGeneration = parseCodegenAuthority(raw['codeGeneration']);
      if (!['general-stack-v1', 'workspace-session-v1'].includes(String(raw['testEnvironmentPolicy'])) || raw['executionSurface'] === 'runtime_mcp') throw Error();
    } catch { throw new PackExecutionGrantError('Invalid code-generation authority'); }
  }
  if (raw['v'] !== 1 || raw['iss'] !== 'argus.core'
    || raw['aud'] !== expected.packId || raw['agent'] !== expected.agentId
    || raw['messageId'] !== expected.messageId || raw['rootTraceId'] !== expected.rootTraceId
    || typeof raw['jti'] !== 'string' || typeof raw['principalId'] !== 'string'
    || !['user', 'api_key', 'service'].includes(String(principalKind))
    || !positiveIds(raw['bundleIds']) || !positiveIds(raw['coreAgentIds'])
    || (raw['testEnvironmentPolicy'] !== undefined && (!['general-stack-v1', 'workspace-session-v1'].includes(String(raw['testEnvironmentPolicy']))
      || raw['aud'] !== 'argus.dev' || raw['agent'] !== 'coding-orchestrator' || !raw['workspaceRoot']))
    || (raw['runtimeProfileOverrides'] !== undefined
      && !runtimeProfileOverrides(raw['runtimeProfileOverrides'], raw['coreAgentIds'] as number[]))
    || (raw['workspaceRoot'] !== undefined
      && (typeof raw['workspaceRoot'] !== 'string'
        || !/^\/workspace\/[A-Za-z0-9-]+$/.test(raw['workspaceRoot'])))
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
      aud: raw['aud'],
      agent: raw['agent'],
      principalKind: principalKind as PackExecutionGrantClaims['principalKind'],
      principalId: raw['principalId'],
      bundleIds: [...new Set(raw['bundleIds'])],
      coreAgentIds: [...new Set(raw['coreAgentIds'])],
      ...(raw['runtimeProfileOverrides'] !== undefined
        ? { runtimeProfileOverrides: raw['runtimeProfileOverrides'] as NonNullable<PackExecutionGrantClaims['runtimeProfileOverrides']> }
        : {}),
      messageId: raw['messageId'],
      rootTraceId: raw['rootTraceId'],
      ...(typeof raw['workspaceRoot'] === 'string' ? { workspaceRoot: raw['workspaceRoot'] } : {}),
      ...(raw['testEnvironmentPolicy'] !== undefined ? { testEnvironmentPolicy: raw['testEnvironmentPolicy'] as NonNullable<PackExecutionGrantClaims['testEnvironmentPolicy']> } : {}),
      ...(codeGeneration ? { codeGeneration } : {}),
      iat: raw['iat'],
      exp: raw['exp'],
    },
  };
}
