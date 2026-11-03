import type { LlmProvider, LlmTarget } from './types.js';

type ProviderOverrides = Record<string, LlmProvider>;

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function versionedBase(value: string): string {
  const base = trimSlash(value);
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

function providerOverrides(): ProviderOverrides {
  const raw = process.env['LLM_PROVIDER_OVERRIDES'];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, LlmProvider] =>
        entry[1] === 'openai' || entry[1] === 'anthropic' || entry[1] === 'openai-compatible',
      ),
    );
  } catch {
    throw new Error('LLM_PROVIDER_OVERRIDES must be a JSON object of model names/prefixes to providers');
  }
}

export function inferLlmProvider(model: string): LlmProvider {
  const overrides = providerOverrides();
  if (overrides[model]) return overrides[model];

  const prefix = Object.entries(overrides)
    .filter(([key]) => key.endsWith('*') && model.startsWith(key.slice(0, -1)))
    .sort(([a], [b]) => b.length - a.length)[0];
  if (prefix) return prefix[1];

  return /^claude(?:-|$)/i.test(model) ? 'anthropic' : 'openai';
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function directAgentKey(apiKeyOverride?: string | null): string | undefined {
  if (process.env['DIRECT_AGENT_API_KEYS'] !== 'true') return undefined;
  const key = apiKeyOverride?.trim();
  return key || undefined;
}

export function resolveLlmTarget(model: string, apiKeyOverride?: string | null): LlmTarget {
  const timeoutMs = positiveInt(process.env['LLM_REQUEST_TIMEOUT_MS'], 120_000);

  const provider = inferLlmProvider(model);
  const agentKey = directAgentKey(apiKeyOverride);

  if (provider === 'anthropic') {
    return {
      provider,
      baseUrl: versionedBase(process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com'),
      apiKey: agentKey ?? process.env['ANTHROPIC_API_KEY'] ?? '',
      authType: 'api-key',
      model,
      timeoutMs,
    };
  }

  if (provider === 'openai-compatible') {
    const base = process.env['OPENAI_COMPAT_BASE_URL'] ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com';
    return {
      provider,
      baseUrl: versionedBase(base),
      apiKey: agentKey ?? process.env['OPENAI_COMPAT_API_KEY'] ?? process.env['OPENAI_API_KEY'] ?? '',
      authType: 'bearer',
      model,
      timeoutMs,
    };
  }

  return {
    provider,
    baseUrl: versionedBase(process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com'),
    apiKey: agentKey ?? process.env['OPENAI_API_KEY'] ?? '',
    authType: 'bearer',
    model,
    timeoutMs,
  };
}

export function assertLlmTargetConfigured(target: LlmTarget): void {
  if (target.apiKey) return;
  if (target.provider === 'openai-compatible' && process.env['ALLOW_EMPTY_OPENAI_COMPAT_API_KEY'] === 'true') return;

  const envName = target.provider === 'anthropic'
    ? 'ANTHROPIC_API_KEY'
    : target.provider === 'openai'
      ? 'OPENAI_API_KEY'
      : 'OPENAI_COMPAT_API_KEY';
  throw new Error(`No API key configured for ${target.provider} model "${target.model}" (set ${envName})`);
}

export function hasLlmCredentials(model: string): boolean {
  try {
    assertLlmTargetConfigured(resolveLlmTarget(model));
    return true;
  } catch {
    return false;
  }
}
