/**
 * platformConfig.ts — runtime-overridable configuration for Phase-2 features.
 *
 * Settings werden in mcp_platform_settings (category='otel'/'rag_hyde'/'k8s_impersonation', key='config')
 * als JSON-string persisted. loadAll() lädt sie beim Startup, setters
 * mutieren in-memory + persistieren in DB.
 */

import type pg from 'pg';
import { logger } from './logger.js';

// ── OTel-Config ────────────────────────────────────────────────────

export interface OtelConfig {
  endpoint: string;     // OTLP HTTP endpoint
  sampling: number;     // 0.0 – 1.0
  serviceName: string;
  headers: Record<string, string>;
}

let otelConfig: OtelConfig = {
  endpoint:    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '',
  sampling:    parseFloat(process.env['OTEL_TRACES_SAMPLER_ARG'] ?? '1.0'),
  serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'argus-mcp-server',
  headers:     {},
};

export function getOtelConfig(): OtelConfig { return otelConfig; }
export function setOtelConfig(cfg: Partial<OtelConfig>): void {
  otelConfig = { ...otelConfig, ...cfg, headers: cfg.headers ?? otelConfig.headers };
  logger.info({ endpoint: otelConfig.endpoint, sampling: otelConfig.sampling }, 'OTel config updated');
}

// ── HyDE-Config ────────────────────────────────────────────────────

export interface HydeConfig {
  model:      string;
  maxTokens:  number;
  prompt:     string;   // template with {query} placeholder
}

const DEFAULT_HYDE_PROMPT = `Schreibe eine kurze, plausibel klingende Antwort (max. 3 Sätze) auf folgende Frage, als ob du sie aus einem internen Dokument zitieren würdest. Erfinde keine konkreten Zahlen, aber strukturiere die Antwort so wie sie in einer Confluence-Seite stehen würde.

Frage: {query}

Antwort:`;

let hydeConfig: HydeConfig = {
  model:     'gpt-4o-mini',
  maxTokens: 200,
  prompt:    DEFAULT_HYDE_PROMPT,
};

export function getHydeConfig(): HydeConfig { return hydeConfig; }
export function setHydeConfig(cfg: Partial<HydeConfig>): void {
  hydeConfig = { ...hydeConfig, ...cfg };
}

// ── K8s-Impersonation-Config ───────────────────────────────────────

export interface K8sImpersonationConfig {
  enabled:       boolean;
  userSource:    'username' | 'email' | 'custom';
  userHeader?:   string;       // when userSource='custom'
  defaultGroup?: string;
  groupMap?:     Record<string, string>;  // argus-role → k8s-group
}

let k8sConfig: K8sImpersonationConfig = {
  enabled:    false,
  userSource: 'username',
};

export function getK8sImpersonationConfig(): K8sImpersonationConfig { return k8sConfig; }
export function setK8sImpersonationConfig(cfg: Partial<K8sImpersonationConfig>): void {
  k8sConfig = { ...k8sConfig, ...cfg };
  logger.info({ enabled: k8sConfig.enabled, userSource: k8sConfig.userSource }, 'K8s impersonation config updated');
}

/**
 * Build the K8s impersonation headers for a given calling user.
 * Returns empty object when disabled or no user identity available.
 */
export function buildImpersonationHeaders(callingUser?: {
  username?: string;
  email?: string;
  role?: string;
  custom?: Record<string, string>;
}): Record<string, string> {
  const cfg = k8sConfig;
  if (!cfg.enabled || !callingUser) return {};

  let user: string | undefined;
  if (cfg.userSource === 'username') user = callingUser.username;
  else if (cfg.userSource === 'email') user = callingUser.email;
  else if (cfg.userSource === 'custom' && cfg.userHeader) {
    user = callingUser.custom?.[cfg.userHeader];
  }
  if (!user) return {};

  const headers: Record<string, string> = { 'Impersonate-User': user };

  // Group resolution: role-specific override > default
  const group = (callingUser.role && cfg.groupMap?.[callingUser.role]) || cfg.defaultGroup;
  if (group) headers['Impersonate-Group'] = group;

  return headers;
}

// ── Upstream-Token-Exchange (Master-Switch) ────────────────────────

export interface UpstreamTokenExchangeConfig {
  /** Master-Switch — wenn false, alle Pfade fallen auf Service-Account-Verhalten zurück. Default: false. */
  enabled: boolean;
}

let upstreamConfig: UpstreamTokenExchangeConfig = { enabled: false };

export function getUpstreamTokenExchangeConfig(): UpstreamTokenExchangeConfig {
  return upstreamConfig;
}

export function setUpstreamTokenExchangeConfig(cfg: Partial<UpstreamTokenExchangeConfig>): void {
  upstreamConfig = { ...upstreamConfig, ...cfg };
  logger.info({ enabled: upstreamConfig.enabled }, 'upstream-token-exchange config updated');
}

// ── DB-Loading + Persistence ───────────────────────────────────────

async function readSetting(pool: pg.Pool, category: string, key: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ value: unknown }>(
      `SELECT value FROM mcp_platform_settings WHERE category=$1 AND key=$2`,
      [category, key],
    );
    const value = rows[0]?.value;
    // PostgreSQL JSONB is already decoded by pg. Legacy/text fixtures may still
    // return a JSON string. Normalize both without silently dropping saved config
    // when JSON.parse receives an object after a process restart.
    if (value == null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return null;
  }
}

async function writeSetting(pool: pg.Pool, category: string, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO mcp_platform_settings (category, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (category, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [category, key, value],
  );
}

export async function loadAllPlatformConfigs(pool: pg.Pool): Promise<void> {
  // Vault is loaded by src/lib/secrets.ts itself
  const otelRaw = await readSetting(pool, 'otel', 'config');
  if (otelRaw) { try { setOtelConfig(JSON.parse(otelRaw)); } catch { /* invalid JSON, ignore */ } }

  const hydeRaw = await readSetting(pool, 'rag_hyde', 'config');
  if (hydeRaw) { try { setHydeConfig(JSON.parse(hydeRaw)); } catch { /* invalid */ } }

  const k8sRaw = await readSetting(pool, 'k8s_impersonation', 'config');
  if (k8sRaw) { try { setK8sImpersonationConfig(JSON.parse(k8sRaw)); } catch { /* invalid */ } }

  const upstreamRaw = await readSetting(pool, 'upstream_token_exchange', 'config');
  if (upstreamRaw) { try { setUpstreamTokenExchangeConfig(JSON.parse(upstreamRaw)); } catch { /* invalid */ } }

  logger.info('platform configs loaded from DB');
}

export async function persistPlatformConfig(
  pool: pg.Pool,
  category: 'vault' | 'otel' | 'rag_hyde' | 'k8s_impersonation' | 'upstream_token_exchange',
  config: object,
): Promise<void> {
  await writeSetting(pool, category, 'config', JSON.stringify(config));
}
