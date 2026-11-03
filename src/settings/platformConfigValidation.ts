import type { VaultConfig } from '../lib/secrets.js';
import type {
  HydeConfig,
  K8sImpersonationConfig,
  OtelConfig,
  UpstreamTokenExchangeConfig,
} from '../lib/platformConfig.js';

export class PlatformConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformConfigValidationError';
  }
}

type UnknownRecord = Record<string, unknown>;

function record(raw: unknown, label: string): UnknownRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlatformConfigValidationError(`${label} must be a JSON object.`);
  }
  return raw as UnknownRecord;
}

function text(raw: unknown, label: string, max = 2_000): string {
  if (typeof raw !== 'string') throw new PlatformConfigValidationError(`${label} must be a string.`);
  const value = raw.trim();
  if (value.length > max) throw new PlatformConfigValidationError(`${label} is too long.`);
  return value;
}

function optionalText(raw: unknown, label: string, max = 2_000): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return text(raw, label, max) || undefined;
}

function stringMap(raw: unknown, label: string, maxEntries = 100): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  const value = record(raw, label);
  const entries = Object.entries(value);
  if (entries.length > maxEntries) throw new PlatformConfigValidationError(`${label} has too many entries.`);
  const result: Record<string, string> = {};
  for (const [key, entry] of entries) {
    const cleanKey = key.trim();
    if (!cleanKey || cleanKey.length > 160 || typeof entry !== 'string' || !entry.trim() || entry.length > 2_000) {
      throw new PlatformConfigValidationError(`${label} must contain non-empty string keys and values.`);
    }
    result[cleanKey] = entry.trim();
  }
  return result;
}

function optionalUrl(raw: unknown, label: string): string | undefined {
  const value = optionalText(raw, label, 2_000);
  if (!value) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new PlatformConfigValidationError(`${label} must be a valid URL.`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new PlatformConfigValidationError(`${label} must use HTTP or HTTPS.`);
  }
  return value.replace(/\/$/, '');
}

function secret(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 16_000) {
    throw new PlatformConfigValidationError(`${label} is invalid.`);
  }
  return raw;
}

export interface SafeVaultConfig extends Omit<VaultConfig, 'azureClientSecret' | 'hashicorpToken'> {
  azureClientSecretConfigured: boolean;
  hashicorpTokenConfigured: boolean;
}

export interface SafePlatformConfig {
  vault: SafeVaultConfig;
  otel: OtelConfig;
  hyde: HydeConfig;
  k8s_impersonation: K8sImpersonationConfig;
  upstream_token_exchange: UpstreamTokenExchangeConfig;
}

export function safeVaultConfig(config: VaultConfig): SafeVaultConfig {
  const { azureClientSecret: _azureSecret, hashicorpToken: _hashicorpToken, ...safe } = config;
  return {
    ...safe,
    azureClientSecretConfigured: Boolean(config.azureClientSecret),
    hashicorpTokenConfigured: Boolean(config.hashicorpToken),
  };
}

export function validateVaultConfig(raw: unknown, current: VaultConfig): VaultConfig {
  const input = record(raw, 'Vault configuration');
  const type = input.type;
  if (!['none', 'azure-kv', 'hashicorp'].includes(String(type))) {
    throw new PlatformConfigValidationError('Unknown Vault provider.');
  }
  const mappings = stringMap(input.mappings, 'Secret mappings');
  if (type === 'none') return { type: 'none', mappings };

  if (type === 'azure-kv') {
    const azureKvUri = optionalUrl(input.azureKvUri, 'Azure Key Vault URI');
    if (!azureKvUri || !azureKvUri.startsWith('https://')) {
      throw new PlatformConfigValidationError('Azure Key Vault URI must use HTTPS.');
    }
    const azureAuth = input.azureAuth ?? 'workload-identity';
    if (!['workload-identity', 'client-secret'].includes(String(azureAuth))) {
      throw new PlatformConfigValidationError('Unknown Azure authentication method.');
    }
    const next: VaultConfig = {
      type: 'azure-kv',
      azureKvUri,
      azureAuth: azureAuth as 'workload-identity' | 'client-secret',
      azureTenantId: optionalText(input.azureTenantId, 'Azure tenant ID', 200),
      azureClientId: optionalText(input.azureClientId, 'Azure client ID', 200),
      mappings,
    };
    if (azureAuth === 'client-secret') {
      const supplied = secret(input.azureClientSecret, 'Azure client secret');
      const existing = current.type === 'azure-kv' ? current.azureClientSecret : undefined;
      if (input.clearAzureClientSecret !== true) next.azureClientSecret = supplied ?? existing;
      if (!next.azureTenantId || !next.azureClientId || !next.azureClientSecret) {
        throw new PlatformConfigValidationError('Client-secret authentication requires tenant ID, client ID and client secret.');
      }
    }
    return next;
  }

  const hashicorpUrl = optionalUrl(input.hashicorpUrl, 'HashiCorp Vault URL');
  if (!hashicorpUrl) throw new PlatformConfigValidationError('HashiCorp Vault URL is required.');
  const next: VaultConfig = {
    type: 'hashicorp',
    hashicorpUrl,
    hashicorpMount: optionalText(input.hashicorpMount, 'KV mount', 160) ?? 'secret',
    hashicorpNamespace: optionalText(input.hashicorpNamespace, 'Vault namespace', 500),
    mappings,
  };
  const supplied = secret(input.hashicorpToken, 'HashiCorp token');
  const existing = current.type === 'hashicorp' ? current.hashicorpToken : undefined;
  if (input.clearHashicorpToken !== true) next.hashicorpToken = supplied ?? existing;
  if (!next.hashicorpToken) throw new PlatformConfigValidationError('HashiCorp Vault token is required.');
  return next;
}

export function validateOtelConfig(raw: unknown): OtelConfig {
  const input = record(raw, 'OpenTelemetry configuration');
  const sampling = Number(input.sampling);
  if (!Number.isFinite(sampling) || sampling < 0 || sampling > 1) {
    throw new PlatformConfigValidationError('Sampling rate must be between 0 and 1.');
  }
  return {
    endpoint: optionalUrl(input.endpoint, 'OTLP endpoint') ?? '',
    sampling,
    serviceName: optionalText(input.serviceName, 'Service name', 200) ?? 'argus-mcp-server',
    headers: stringMap(input.headers, 'OTLP headers', 50),
  };
}

export function validateHydeConfig(raw: unknown): HydeConfig {
  const input = record(raw, 'HyDE configuration');
  const model = text(input.model, 'HyDE model', 300);
  const prompt = text(input.prompt, 'HyDE prompt', 20_000);
  const maxTokens = Number(input.maxTokens);
  if (!model) throw new PlatformConfigValidationError('HyDE model is required.');
  if (!Number.isInteger(maxTokens) || maxTokens < 50 || maxTokens > 500) {
    throw new PlatformConfigValidationError('HyDE max tokens must be an integer between 50 and 500.');
  }
  if (!prompt.includes('{query}')) {
    throw new PlatformConfigValidationError('HyDE prompt must contain the {query} placeholder.');
  }
  return { model, maxTokens, prompt };
}

export function validateK8sImpersonationConfig(raw: unknown): K8sImpersonationConfig {
  const input = record(raw, 'Kubernetes impersonation configuration');
  if (typeof input.enabled !== 'boolean') throw new PlatformConfigValidationError('enabled must be a boolean.');
  if (!['username', 'email', 'custom'].includes(String(input.userSource))) {
    throw new PlatformConfigValidationError('Unknown Kubernetes user source.');
  }
  const userSource = input.userSource as K8sImpersonationConfig['userSource'];
  const userHeader = optionalText(input.userHeader, 'Custom user header', 200);
  if (userSource === 'custom' && !userHeader) {
    throw new PlatformConfigValidationError('A custom user header is required for the custom source.');
  }
  return {
    enabled: input.enabled,
    userSource,
    userHeader,
    defaultGroup: optionalText(input.defaultGroup, 'Default Kubernetes group', 300),
    groupMap: stringMap(input.groupMap, 'Kubernetes group mapping', 50),
  };
}

export function validateUpstreamTokenExchangeConfig(raw: unknown): UpstreamTokenExchangeConfig {
  const input = record(raw, 'Upstream token exchange configuration');
  if (typeof input.enabled !== 'boolean') throw new PlatformConfigValidationError('enabled must be a boolean.');
  return { enabled: input.enabled };
}
