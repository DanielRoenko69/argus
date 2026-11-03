/**
 * secrets.ts — Vault-aware secret resolver.
 *
 * Argus's bisher: alle Secrets aus process.env. Probleme:
 *   - Rotation only via Container-Restart
 *   - Audit (wer hat den Key wann ausgetauscht?) fehlt
 *   - GDPR: Klartext-Keys in .env-File
 *
 * Diese Abstraktion schiebt eine optionale Vault-Schicht davor:
 *   1. Vault-Lookup wenn aktiviert AND mapping für secret-name existiert
 *   2. Fallback auf process.env[name]
 *
 * Vault-Type 'none' (Default) = env-only, kein Bruch mit bestehender Logik.
 *
 * Unterstützt heute:
 *   - 'none'         — env-only (Default, kein Vault konfiguriert)
 *   - 'azure-kv'     — Azure Key Vault via REST + DefaultAzureCredential
 *   - 'hashicorp'    — HashiCorp Vault KV-V2 + Token-Auth
 *
 * Cache: 5 Minuten (Rotation propagiert maximal in 5 min). Cache-Bust via
 * resetVaultCache() (durch Settings-Update-Hook).
 */

import { logger } from './logger.js';
import type pg from 'pg';

export type VaultType = 'none' | 'azure-kv' | 'hashicorp';

export interface VaultConfig {
  type: VaultType;
  /** Azure Key Vault: vault-URI (https://<name>.vault.azure.net) */
  azureKvUri?: string;
  /** Azure auth — 'workload-identity' (default in AKS) | 'client-secret' */
  azureAuth?: 'workload-identity' | 'client-secret';
  /** Azure SP client-id (nur bei client-secret) */
  azureClientId?: string;
  /** Azure SP client-secret (nur bei client-secret) */
  azureClientSecret?: string;
  /** Azure tenant-id (nur bei client-secret) */
  azureTenantId?: string;

  /** HashiCorp: Vault URL */
  hashicorpUrl?: string;
  /** HashiCorp: KV-mount-path (default: 'secret') */
  hashicorpMount?: string;
  /** HashiCorp: Token (nur dev — prod use AppRole oder K8s-Auth) */
  hashicorpToken?: string;
  /** Optional Namespace (Vault Enterprise) */
  hashicorpNamespace?: string;

  /**
   * Mapping: Argus-secret-name → Vault-secret-name. z.B.
   *   { "ANTHROPIC_API_KEY": "argus/prod/anthropic", "SECRET_KEY": "argus/prod/encryption-key" }
   * Wenn ein name nicht im Mapping ist → Fallback auf env, NICHT Vault.
   */
  mappings?: Record<string, string>;
}

/** In-memory snapshot of the current Vault-config. Reloaded after every settings update. */
let currentConfig: VaultConfig = { type: 'none' };
const cache = new Map<string, { value: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function setVaultConfig(cfg: VaultConfig): void {
  currentConfig = cfg;
  cache.clear();
  logger.info({ type: cfg.type, mappingCount: Object.keys(cfg.mappings ?? {}).length }, 'vault config updated');
}

export function getVaultConfig(): VaultConfig {
  return currentConfig;
}

export function resetVaultCache(): void {
  cache.clear();
}

/**
 * Resolve a secret by NAME. Returns the secret value or undefined.
 * Resolution order:
 *   1. If Vault enabled AND name has a Vault-mapping → fetch from Vault
 *      (cached 5 min). On Vault-error: fallback to env, log warning.
 *   2. Otherwise: process.env[name]
 *
 * Callers MUST handle undefined (= secret not configured anywhere).
 */
export async function getSecret(name: string): Promise<string | undefined> {
  const cfg = currentConfig;

  // Cache hit?
  const cached = cache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // Vault path
  if (cfg.type !== 'none' && cfg.mappings?.[name]) {
    try {
      const value = await fetchFromVault(name, cfg);
      if (value !== undefined) {
        cache.set(name, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        return value;
      }
      logger.warn({ secretName: name, vaultPath: cfg.mappings[name] }, 'vault returned no value, falling back to env');
    } catch (err) {
      logger.warn({ err: String(err), secretName: name }, 'vault fetch failed, falling back to env');
    }
  }

  // Env fallback
  return process.env[name];
}

async function fetchFromVault(name: string, cfg: VaultConfig): Promise<string | undefined> {
  const vaultPath = cfg.mappings?.[name];
  if (!vaultPath) return undefined;

  if (cfg.type === 'azure-kv') {
    return fetchAzureKvSecret(vaultPath, cfg);
  }
  if (cfg.type === 'hashicorp') {
    return fetchHashicorpSecret(vaultPath, cfg);
  }
  return undefined;
}

async function fetchAzureKvSecret(secretName: string, cfg: VaultConfig): Promise<string | undefined> {
  if (!cfg.azureKvUri) throw new Error('azureKvUri not configured');

  const token = await getAzureAccessToken(cfg);
  const url = `${cfg.azureKvUri.replace(/\/$/, '')}/secrets/${encodeURIComponent(secretName)}?api-version=7.4`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Azure KV ${res.status}: ${await res.text().catch(() => '')}`);
  const body = await res.json() as { value?: string };
  return body.value;
}

async function getAzureAccessToken(cfg: VaultConfig): Promise<string> {
  // Workload-Identity: rely on AKS-pod-injected env-vars from azwi-mutator
  if (cfg.azureAuth === 'workload-identity' || !cfg.azureAuth) {
    const fedTokenFile = process.env['AZURE_FEDERATED_TOKEN_FILE'];
    const clientId     = process.env['AZURE_CLIENT_ID']     ?? cfg.azureClientId;
    const tenantId     = process.env['AZURE_TENANT_ID']     ?? cfg.azureTenantId;
    if (!fedTokenFile || !clientId || !tenantId) {
      throw new Error('Workload Identity not configured (need AZURE_FEDERATED_TOKEN_FILE + AZURE_CLIENT_ID + AZURE_TENANT_ID)');
    }
    const { readFile } = await import('node:fs/promises');
    const assertion = (await readFile(fedTokenFile, 'utf8')).trim();
    const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: 'client_credentials',
        scope: 'https://vault.azure.net/.default',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      }),
    });
    if (!tokenRes.ok) throw new Error(`AAD token: ${tokenRes.status}`);
    return (await tokenRes.json() as { access_token: string }).access_token;
  }

  // Client-secret fallback
  if (!cfg.azureClientId || !cfg.azureClientSecret || !cfg.azureTenantId) {
    throw new Error('Azure client-secret auth requires clientId+clientSecret+tenantId');
  }
  const tokenRes = await fetch(`https://login.microsoftonline.com/${cfg.azureTenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.azureClientId,
      client_secret: cfg.azureClientSecret,
      grant_type: 'client_credentials',
      scope: 'https://vault.azure.net/.default',
    }),
  });
  if (!tokenRes.ok) throw new Error(`AAD token: ${tokenRes.status}`);
  return (await tokenRes.json() as { access_token: string }).access_token;
}

async function fetchHashicorpSecret(path: string, cfg: VaultConfig): Promise<string | undefined> {
  if (!cfg.hashicorpUrl || !cfg.hashicorpToken) throw new Error('hashicorp Vault config incomplete');
  const mount = cfg.hashicorpMount ?? 'secret';
  // KV-V2 path-layout: <mount>/data/<path>
  const url = `${cfg.hashicorpUrl.replace(/\/$/, '')}/v1/${mount}/data/${path}`;
  const headers: Record<string, string> = { 'X-Vault-Token': cfg.hashicorpToken };
  if (cfg.hashicorpNamespace) headers['X-Vault-Namespace'] = cfg.hashicorpNamespace;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Hashicorp ${res.status}`);
  const body = await res.json() as { data?: { data?: Record<string, string> } };
  // KV-V2 wraps: data.data.<key> — we expect 'value' as the field name by convention
  return body.data?.data?.value;
}

/**
 * Test-connection helper for the admin UI. Tries to fetch a sentinel
 * secret-path and reports success/error.
 */
export async function testVaultConnection(cfg: VaultConfig, samplePath?: string): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  const start = Date.now();
  try {
    if (cfg.type === 'none') return { ok: true, latencyMs: 0 };
    // Use first mapping or provided sample
    const path = samplePath ?? Object.values(cfg.mappings ?? {})[0];
    if (!path) return { ok: false, error: 'No secret mapping configured — add at least one and retry' };
    await fetchFromVault('__test__', { ...cfg, mappings: { __test__: path } });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }
}

// Reload from persisted platform settings on startup.
export async function loadVaultConfigFromSettings(pool: pg.Pool): Promise<void> {
  try {
    const result = await pool.query<{ value: string }>(
      `SELECT value FROM mcp_platform_settings WHERE category = 'vault' AND key = 'config'`,
    );
    const raw = result.rows[0]?.value;
    if (!raw) return;
    const parsed = JSON.parse(raw) as VaultConfig;
    setVaultConfig(parsed);
  } catch (err) {
    logger.warn({ err: String(err) }, 'vault.config in mcp_platform_settings is invalid JSON');
  }
}
