import type pg from 'pg';
import { API_MODEL_ASSIGNMENT_SQL, deleteModelInTransaction } from './modelAssignments.js';
import { decrypt, encrypt } from '../lib/encryption.js';
import { getSecret } from '../lib/secrets.js';
import { assertLlmTargetConfigured, resolveLlmTarget } from './targets.js';
import type { LlmProvider, LlmTarget } from './types.js';
import {
  listLlmCredentialProfiles,
  resolveLlmCredentialProfile,
  type LlmCredentialProfileRecord,
} from './credentialProfiles.js';

export type LlmProviderType = LlmProvider;
export type LlmProviderAuthType = 'bearer' | 'api-key' | 'none';

export interface LlmProviderInput {
  name: string;
  label: string;
  providerType: LlmProviderType;
  baseUrl: string;
  authType: LlmProviderAuthType;
  secretName: string | null;
  apiKey?: string | null;
  credentialProfileId: number | null;
  enabled: boolean;
}

export interface LlmProviderRecord extends Omit<LlmProviderInput, 'apiKey'> {
  id: number;
  credentialConfigured: boolean;
  inlineCredentialConfigured: boolean;
  credentialProfileLabel: string | null;
  lastTestStatus: 'healthy' | 'failed' | null;
  lastTestedAt: string | null;
  lastTestError: string | null;
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LlmModelInput {
  modelName: string;
  displayName: string;
  providerId: number;
  upstreamModelName: string;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  inputCostPer1k: number | null;
  outputCostPer1k: number | null;
}

export interface LlmModelRecord extends LlmModelInput {
  id: number;
  providerLabel: string;
  providerType: LlmProviderType;
  providerEnabled: boolean;
  assignedAgents: number;
  createdAt: string;
  updatedAt: string;
}

export interface LlmCatalog {
  providers: LlmProviderRecord[];
  models: LlmModelRecord[];
  credentialProfiles: LlmCredentialProfileRecord[];
  summary: {
    enabledProviders: number;
    enabledModels: number;
    healthyProviders: number;
    configuredCredentials: number;
  };
}

/**
 * Safe, role-independent catalog used by the Home onboarding flow.
 * Provider credentials and secret references deliberately never leave the
 * server through this shape.
 */
export interface LlmOnboardingProvider {
  id: number;
  name: string;
  label: string;
  providerType: LlmProviderType;
  baseUrl: string;
  authType: LlmProviderAuthType;
  enabled: boolean;
  credentialConfigured: boolean;
  lastTestStatus: 'healthy' | 'failed' | null;
  modelCount: number;
  canTest: boolean;
}

export interface LlmOnboardingModel {
  id: number;
  modelName: string;
  displayName: string;
  providerId: number;
  providerLabel: string;
  providerType: LlmProviderType;
  enabled: boolean;
  providerEnabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
}

export interface LlmOnboardingCatalog {
  providers: LlmOnboardingProvider[];
  models: LlmOnboardingModel[];
}

interface ProviderRow extends pg.QueryResultRow {
  id: number;
  name: string;
  label: string;
  provider_type: LlmProviderType;
  base_url: string;
  auth_type: LlmProviderAuthType;
  api_key: string | null;
  secret_name: string | null;
  credential_profile_id: number | null;
  credential_profile_label: string | null;
  credential_profile_configured: boolean;
  enabled: boolean;
  last_test_status: 'healthy' | 'failed' | null;
  last_tested_at: string | null;
  last_test_error: string | null;
  config: Record<string, unknown> | null;
  model_count: number | string;
  created_at: string;
  updated_at: string;
}

interface ModelRow extends pg.QueryResultRow {
  id: number;
  model_name: string;
  display_name: string | null;
  provider_id: number;
  upstream_model_name: string | null;
  enabled: boolean;
  supports_vision: boolean;
  supports_tools: boolean;
  supports_reasoning: boolean;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  input_cost_per_1k: number | string | null;
  output_cost_per_1k: number | string | null;
  provider_label: string;
  provider_type: LlmProviderType;
  provider_enabled: boolean;
  assigned_agents: number | string;
  created_at: string;
  updated_at: string;
}

const PROVIDER_TYPES = new Set<LlmProviderType>(['openai', 'anthropic', 'openai-compatible']);
const AUTH_TYPES = new Set<LlmProviderAuthType>(['bearer', 'api-key', 'none']);

function cleanText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} ist erforderlich`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${label} ist zu lang`);
  return result;
}

function optionalNumber(value: unknown, label: string, options: { integer?: boolean; min?: number } = {}): number | null {
  if (value == null || value === '') return null;
  const result = Number(value);
  if (!Number.isFinite(result) || (options.integer && !Number.isInteger(result)) || (options.min != null && result < options.min)) {
    throw new Error(`${label} ist ungültig`);
  }
  return result;
}

function normalizedBaseUrl(value: unknown): string {
  const raw = cleanText(value, 'Base URL', 2_048).replace(/\/+$/, '');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('Base URL ist ungültig'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Base URL muss HTTP oder HTTPS verwenden');
  if (parsed.username || parsed.password) throw new Error('Credentials dürfen nicht in der Base URL stehen');
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

export function normalizeLlmProviderInput(value: unknown): LlmProviderInput {
  const input = value != null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const name = cleanText(input['name'], 'Technischer Name', 96).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error('Technischer Name darf nur a-z, 0-9, _ und - enthalten');
  const providerType = input['providerType'] as LlmProviderType;
  if (!PROVIDER_TYPES.has(providerType)) throw new Error('Provider-Typ ist ungültig');
  const authType = input['authType'] as LlmProviderAuthType;
  if (!AUTH_TYPES.has(authType)) throw new Error('Auth-Typ ist ungültig');
  const secretName = input['secretName'] == null || input['secretName'] === ''
    ? null
    : cleanText(input['secretName'], 'Secret-Name', 160);
  if (secretName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretName)) {
    throw new Error('Secret-Name muss ein gültiger Environment-/Vault-Name sein');
  }
  if (typeof input['enabled'] !== 'boolean') throw new Error('Enabled-Status ist ungültig');
  const apiKey = input['apiKey'] === undefined
    ? undefined
    : input['apiKey'] === null || input['apiKey'] === ''
      ? null
      : cleanText(input['apiKey'], 'API-Key', 8_192);
  const credentialProfileId = input['credentialProfileId'] == null || input['credentialProfileId'] === ''
    ? null
    : Number(input['credentialProfileId']);
  if (credentialProfileId != null && (!Number.isSafeInteger(credentialProfileId) || credentialProfileId <= 0)) {
    throw new Error('Credential Profile ist ungültig');
  }
  return {
    name,
    label: cleanText(input['label'], 'Anzeigename', 160),
    providerType,
    baseUrl: normalizedBaseUrl(input['baseUrl']),
    authType,
    secretName,
    ...(apiKey !== undefined ? { apiKey } : {}),
    credentialProfileId,
    enabled: input['enabled'] as boolean,
  };
}

export function normalizeLlmModelInput(value: unknown): LlmModelInput {
  const input = value != null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const providerId = Number(input['providerId']);
  if (!Number.isSafeInteger(providerId) || providerId <= 0) throw new Error('Provider ist ungültig');
  for (const key of ['enabled', 'supportsVision', 'supportsTools', 'supportsReasoning'] as const) {
    if (typeof input[key] !== 'boolean') throw new Error(`${key} ist ungültig`);
  }
  return {
    modelName: cleanText(input['modelName'], 'Modell-Alias', 128),
    displayName: cleanText(input['displayName'], 'Anzeigename', 160),
    providerId,
    upstreamModelName: cleanText(input['upstreamModelName'], 'Upstream-Modellname', 160),
    enabled: input['enabled'] as boolean,
    supportsVision: input['supportsVision'] as boolean,
    supportsTools: input['supportsTools'] as boolean,
    supportsReasoning: input['supportsReasoning'] as boolean,
    maxInputTokens: optionalNumber(input['maxInputTokens'], 'Kontextfenster', { integer: true, min: 1 }),
    maxOutputTokens: optionalNumber(input['maxOutputTokens'], 'Max Output Tokens', { integer: true, min: 1 }),
    inputCostPer1k: optionalNumber(input['inputCostPer1k'], 'Input-Kosten', { min: 0 }),
    outputCostPer1k: optionalNumber(input['outputCostPer1k'], 'Output-Kosten', { min: 0 }),
  };
}

function mapProvider(row: ProviderRow): LlmProviderRecord {
  return {
    id: Number(row.id),
    name: row.name,
    label: row.label,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    authType: row.auth_type,
    secretName: row.secret_name,
    credentialProfileId: row.credential_profile_id ?? null,
    enabled: row.enabled,
    credentialConfigured: row.auth_type === 'none' || Boolean(row.api_key || row.secret_name || row.credential_profile_configured),
    inlineCredentialConfigured: Boolean(row.api_key),
    credentialProfileLabel: row.credential_profile_label ?? null,
    lastTestStatus: row.last_test_status,
    lastTestedAt: row.last_tested_at,
    lastTestError: row.last_test_error,
    modelCount: Number(row.model_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapModel(row: ModelRow): LlmModelRecord {
  return {
    id: Number(row.id),
    modelName: row.model_name,
    displayName: row.display_name || row.model_name,
    providerId: Number(row.provider_id),
    upstreamModelName: row.upstream_model_name || row.model_name,
    enabled: row.enabled,
    supportsVision: row.supports_vision,
    supportsTools: row.supports_tools,
    supportsReasoning: row.supports_reasoning,
    maxInputTokens: row.max_input_tokens == null ? null : Number(row.max_input_tokens),
    maxOutputTokens: row.max_output_tokens == null ? null : Number(row.max_output_tokens),
    inputCostPer1k: row.input_cost_per_1k == null ? null : Number(row.input_cost_per_1k),
    outputCostPer1k: row.output_cost_per_1k == null ? null : Number(row.output_cost_per_1k),
    providerLabel: row.provider_label,
    providerType: row.provider_type,
    providerEnabled: row.provider_enabled,
    assignedAgents: Number(row.assigned_agents),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROVIDER_SELECT = `
  SELECT provider.*,
         credential_profile.label AS credential_profile_label,
         COALESCE(credential_profile.api_key IS NOT NULL OR credential_profile.secret_name IS NOT NULL, false)
           AS credential_profile_configured,
         (SELECT count(*) FROM mcp_models model WHERE model.provider_id=provider.id)::int AS model_count
    FROM mcp_llm_providers provider
    LEFT JOIN mcp_llm_credential_profiles credential_profile
      ON credential_profile.id=provider.credential_profile_id`;

const MODEL_SELECT = `
  SELECT model.id, model.model_name, model.display_name, model.provider_id,
         model.upstream_model_name, model.enabled, model.supports_vision,
         model.supports_tools, model.supports_reasoning, model.max_input_tokens,
         model.max_output_tokens, model.input_cost_per_1k, model.output_cost_per_1k,
         model.created_at, model.updated_at, provider.label AS provider_label,
         provider.provider_type, provider.enabled AS provider_enabled,
         (SELECT count(*) FROM mcp_agents agent WHERE agent.model=model.model_name
            AND ${API_MODEL_ASSIGNMENT_SQL})::int AS assigned_agents
    FROM mcp_models model
    JOIN mcp_llm_providers provider ON provider.id=model.provider_id`;

export async function listLlmOnboardingCatalog(
  pool: pg.Pool,
  user?: { id: number; role?: string | null },
): Promise<LlmOnboardingCatalog> {
  const isPlatformAdmin = user?.role === 'platform_admin' || user?.role === 'admin';
  const providerVisibility = user && !isPlatformAdmin
    ? 'WHERE provider.created_by IS NULL OR creator.role IN (\'platform_admin\', \'admin\') OR provider.created_by=$1'
    : '';
  const providerParams = user && !isPlatformAdmin ? [user.id] : [];
  const modelVisibility = user && !isPlatformAdmin
    ? 'WHERE provider.created_by IS NULL OR creator.role IN (\'platform_admin\', \'admin\') OR provider.created_by=$1'
    : '';
  const [providers, models] = await Promise.all([
    pool.query<{
      id: number;
      name: string;
      label: string;
      provider_type: LlmProviderType;
      base_url: string;
      auth_type: LlmProviderAuthType;
      enabled: boolean;
      credential_configured: boolean;
      last_test_status: 'healthy' | 'failed' | null;
      model_count: number | string;
      can_test: boolean;
    }>(`
      SELECT provider.id, provider.name, provider.label, provider.provider_type,
             provider.base_url, provider.auth_type, provider.enabled,
             (provider.auth_type = 'none'
               OR provider.api_key IS NOT NULL
               OR provider.secret_name IS NOT NULL
               OR provider.credential_profile_id IS NOT NULL) AS credential_configured,
             provider.last_test_status,
             (SELECT count(*) FROM mcp_models model WHERE model.provider_id=provider.id)::int AS model_count,
             provider.enabled AS can_test
        FROM mcp_llm_providers provider
        LEFT JOIN mcp_users creator ON creator.id=provider.created_by
       ${providerVisibility}
       ORDER BY provider.enabled DESC, provider.label, provider.id`,
      providerParams,
    ),
    pool.query<{
      id: number;
      model_name: string;
      display_name: string | null;
      provider_id: number;
      provider_label: string;
      provider_type: LlmProviderType;
      enabled: boolean;
      provider_enabled: boolean;
      supports_vision: boolean;
      supports_tools: boolean;
      supports_reasoning: boolean;
    }>(`
      SELECT model.id, model.model_name, model.display_name, model.provider_id,
             provider.label AS provider_label, provider.provider_type,
             model.enabled, provider.enabled AS provider_enabled,
             model.supports_vision, model.supports_tools, model.supports_reasoning
        FROM mcp_models model
        JOIN mcp_llm_providers provider ON provider.id=model.provider_id
        LEFT JOIN mcp_users creator ON creator.id=provider.created_by
       ${modelVisibility}
       ORDER BY model.enabled DESC, provider.label, model."order", model.model_name`),
      providerParams,
  ]);

  return {
    providers: providers.rows.map(row => ({
      id: Number(row.id),
      name: row.name,
      label: row.label,
      providerType: row.provider_type,
      baseUrl: row.base_url,
      authType: row.auth_type,
      enabled: row.enabled,
      credentialConfigured: Boolean(row.credential_configured),
      lastTestStatus: row.last_test_status,
      modelCount: Number(row.model_count),
      canTest: Boolean(row.can_test),
    })),
    models: models.rows.map(row => ({
      id: Number(row.id),
      modelName: row.model_name,
      displayName: row.display_name || row.model_name,
      providerId: Number(row.provider_id),
      providerLabel: row.provider_label,
      providerType: row.provider_type,
      enabled: row.enabled,
      providerEnabled: row.provider_enabled,
      supportsVision: row.supports_vision,
      supportsTools: row.supports_tools,
      supportsReasoning: row.supports_reasoning,
    })),
  };
}

export async function listLlmCatalog(pool: pg.Pool): Promise<LlmCatalog> {
  const [providerResult, modelResult, credentialProfiles] = await Promise.all([
    pool.query<ProviderRow>(`${PROVIDER_SELECT} ORDER BY provider.enabled DESC, provider.label, provider.id`),
    pool.query<ModelRow>(`${MODEL_SELECT} ORDER BY model.enabled DESC, provider.label, model."order", model.model_name`),
    listLlmCredentialProfiles(pool),
  ]);
  const providers = providerResult.rows.map(mapProvider);
  const models = modelResult.rows.map(mapModel);
  return {
    providers,
    models,
    credentialProfiles,
    summary: {
      enabledProviders: providers.filter(item => item.enabled).length,
      enabledModels: models.filter(item => item.enabled && item.providerEnabled).length,
      healthyProviders: providers.filter(item => item.lastTestStatus === 'healthy').length,
      configuredCredentials: credentialProfiles.filter(item => item.credentialConfigured).length
        + providers.filter(item => item.credentialConfigured && item.credentialProfileId == null).length,
    },
  };
}

async function assertProviderCredentialProfile(
  pool: pg.Pool,
  profileId: number | null,
  providerType: LlmProviderType,
): Promise<void> {
  if (profileId == null) return;
  const result = await pool.query<{ provider_type: LlmProviderType }>(
    'SELECT provider_type FROM mcp_llm_credential_profiles WHERE id=$1',
    [profileId],
  );
  if (!result.rows[0]) throw new Error('Credential Profile wurde nicht gefunden');
  if (result.rows[0].provider_type !== providerType) {
    throw new Error('Credential Profile und Provider verwenden unterschiedliche Protokolle');
  }
}

export async function createLlmProvider(pool: pg.Pool, input: LlmProviderInput, createdBy: number | null): Promise<LlmProviderRecord> {
  await assertProviderCredentialProfile(pool, input.credentialProfileId, input.providerType);
  const result = await pool.query<{ id: number }>(
    `INSERT INTO mcp_llm_providers
       (name, label, provider_type, base_url, auth_type, api_key, secret_name,
        credential_profile_id, enabled, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [input.name, input.label, input.providerType, input.baseUrl, input.authType,
      encrypt(input.apiKey ?? null), input.secretName, input.credentialProfileId, input.enabled, createdBy],
  );
  const created = await pool.query<ProviderRow>(`${PROVIDER_SELECT} WHERE provider.id=$1`, [result.rows[0]!.id]);
  return mapProvider(created.rows[0]!);
}

export async function updateLlmProvider(pool: pg.Pool, id: number, input: LlmProviderInput): Promise<LlmProviderRecord | null> {
  const existing = await pool.query<ProviderRow>(`${PROVIDER_SELECT} WHERE provider.id=$1`, [id]);
  if (!existing.rows[0]) return null;
  await assertProviderCredentialProfile(pool, input.credentialProfileId, input.providerType);
  const nextKey = input.apiKey === undefined ? existing.rows[0].api_key : encrypt(input.apiKey);
  await pool.query(
    `UPDATE mcp_llm_providers
        SET name=$2, label=$3, provider_type=$4, base_url=$5, auth_type=$6,
            api_key=$7, secret_name=$8, credential_profile_id=$9, enabled=$10,
            last_test_status=NULL, last_tested_at=NULL, last_test_error=NULL
      WHERE id=$1
      `,
    [id, input.name, input.label, input.providerType, input.baseUrl, input.authType,
      nextKey, input.secretName, input.credentialProfileId, input.enabled],
  );
  const result = await pool.query<ProviderRow>(`${PROVIDER_SELECT} WHERE provider.id=$1`, [id]);
  return result.rows[0] ? mapProvider(result.rows[0]) : null;
}

export async function deleteLlmProvider(pool: pg.Pool, id: number): Promise<boolean> {
  const assigned = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM mcp_models WHERE provider_id=$1', [id]);
  if (Number(assigned.rows[0]?.count ?? 0) > 0) throw new Error('Provider kann nicht gelöscht werden, solange Modelle zugeordnet sind');
  return (await pool.query('DELETE FROM mcp_llm_providers WHERE id=$1', [id])).rowCount === 1;
}

async function ensureUniqueModelAlias(pool: pg.Pool, modelName: string, exceptId?: number): Promise<void> {
  const result = await pool.query(
    `SELECT 1 FROM mcp_models WHERE lower(model_name)=lower($1)${exceptId ? ' AND id<>$2' : ''} LIMIT 1`,
    exceptId ? [modelName, exceptId] : [modelName],
  );
  if (result.rows.length > 0) throw new Error('Dieser Modell-Alias existiert bereits');
}

export async function createLlmModel(pool: pg.Pool, input: LlmModelInput): Promise<LlmModelRecord> {
  await ensureUniqueModelAlias(pool, input.modelName);
  const provider = await pool.query<{ provider_type: LlmProviderType }>('SELECT provider_type FROM mcp_llm_providers WHERE id=$1', [input.providerId]);
  if (!provider.rows[0]) throw new Error('Provider nicht gefunden');
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO mcp_models
       (model_name, display_name, provider_id, upstream_model_name, provider, deployment_name,
        enabled, supports_vision, supports_tools, supports_reasoning, max_input_tokens,
        max_output_tokens, input_cost_per_1k, output_cost_per_1k)
     VALUES ($1,$2,$3,$4,$5,$4,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [input.modelName, input.displayName, input.providerId, input.upstreamModelName,
      provider.rows[0].provider_type, input.enabled, input.supportsVision, input.supportsTools,
      input.supportsReasoning, input.maxInputTokens, input.maxOutputTokens,
      input.inputCostPer1k, input.outputCostPer1k],
  );
  const result = await pool.query<ModelRow>(`${MODEL_SELECT} WHERE model.id=$1`, [inserted.rows[0]!.id]);
  return mapModel(result.rows[0]!);
}

export async function updateLlmModel(pool: pg.Pool, id: number, input: LlmModelInput): Promise<LlmModelRecord | null> {
  await ensureUniqueModelAlias(pool, input.modelName, id);
  const existing = await pool.query<{ model_name: string }>('SELECT model_name FROM mcp_models WHERE id=$1', [id]);
  if (!existing.rows[0]) return null;
  const provider = await pool.query<{ provider_type: LlmProviderType }>('SELECT provider_type FROM mcp_llm_providers WHERE id=$1', [input.providerId]);
  if (!provider.rows[0]) throw new Error('Provider nicht gefunden');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE mcp_models
          SET model_name=$2, display_name=$3, provider_id=$4, upstream_model_name=$5,
              provider=$6, deployment_name=$5, enabled=$7, supports_vision=$8,
              supports_tools=$9, supports_reasoning=$10, max_input_tokens=$11,
              max_output_tokens=$12, input_cost_per_1k=$13, output_cost_per_1k=$14
        WHERE id=$1`,
      [id, input.modelName, input.displayName, input.providerId, input.upstreamModelName,
        provider.rows[0].provider_type, input.enabled, input.supportsVision, input.supportsTools,
        input.supportsReasoning, input.maxInputTokens, input.maxOutputTokens,
        input.inputCostPer1k, input.outputCostPer1k],
    );
    if (existing.rows[0].model_name !== input.modelName) {
      await client.query('UPDATE mcp_agents SET model=$1 WHERE model=$2', [input.modelName, existing.rows[0].model_name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const result = await pool.query<ModelRow>(`${MODEL_SELECT} WHERE model.id=$1`, [id]);
  return mapModel(result.rows[0]!);
}

export async function deleteLlmModel(pool: pg.Pool, id: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await deleteModelInTransaction(client, id);
    await client.query('COMMIT');
    return deleted;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function providerCredential(
  pool: pg.Pool,
  row: ProviderRow,
  perAgentKey?: string | null,
  agentCredentialProfileId?: number | null,
): Promise<{ apiKey: string; credentialProfile?: LlmCredentialProfileRecord }> {
  if (agentCredentialProfileId != null) {
    const resolved = await resolveLlmCredentialProfile(pool, agentCredentialProfileId, row.provider_type);
    return { apiKey: resolved.apiKey, credentialProfile: resolved.profile };
  }
  if (process.env['DIRECT_AGENT_API_KEYS'] === 'true' && perAgentKey?.trim()) return { apiKey: perAgentKey.trim() };
  if (row.credential_profile_id != null) {
    const resolved = await resolveLlmCredentialProfile(pool, row.credential_profile_id, row.provider_type);
    return { apiKey: resolved.apiKey, credentialProfile: resolved.profile };
  }
  const inline = decrypt(row.api_key);
  if (inline) return { apiKey: inline };
  if (row.secret_name) return { apiKey: await getSecret(row.secret_name) ?? '' };
  return { apiKey: '' };
}

function targetConfigured(target: LlmTarget): void {
  if (target.authType === 'none') return;
  assertLlmTargetConfigured(target);
}

export async function resolveRegisteredLlmTarget(
  pool: pg.Pool,
  modelAlias: string,
  perAgentKey?: string | null,
  agentCredentialProfileId?: number | null,
  requireRegistered = false,
): Promise<LlmTarget> {
  const result = await pool.query<ProviderRow & {
    model_enabled: boolean;
    upstream_model_name: string | null;
    supports_reasoning: boolean;
  }>(
    `SELECT provider.*, model.enabled AS model_enabled, model.upstream_model_name,
            model.supports_reasoning
       FROM mcp_models model
       JOIN mcp_llm_providers provider ON provider.id=model.provider_id
      WHERE model.model_name=$1
      ORDER BY model.id
      LIMIT 1`,
    [modelAlias],
  );
  const row = result.rows[0];
  if (!row) {
    if (requireRegistered) throw new Error('Registered LLM model is unavailable');
    return resolveLlmTarget(modelAlias, perAgentKey);
  }
  if (!row.enabled) throw new Error(`LLM provider "${row.label}" is disabled`);
  if (!row.model_enabled) throw new Error(`LLM model "${modelAlias}" is disabled`);
  const credential = await providerCredential(pool, row, perAgentKey, agentCredentialProfileId);
  const target: LlmTarget = {
    provider: row.provider_type,
    baseUrl: row.base_url.replace(/\/+$/, ''),
    apiKey: credential.apiKey,
    authType: row.auth_type,
    model: row.upstream_model_name || modelAlias,
    timeoutMs: Number((row.config as Record<string, unknown> | undefined)?.['timeoutMs'] ?? process.env['LLM_REQUEST_TIMEOUT_MS'] ?? 120_000),
    supportsReasoning: row.supports_reasoning,
    ...(credential.credentialProfile ? {
      credentialProfileId: credential.credentialProfile.id,
      credentialProfileName: credential.credentialProfile.name,
    } : {}),
  };
  targetConfigured(target);
  return target;
}

export interface LlmProviderTestResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
  error?: string;
}

export async function testLlmProvider(pool: pg.Pool, id: number): Promise<LlmProviderTestResult | null> {
  const result = await pool.query<ProviderRow>(`${PROVIDER_SELECT} WHERE provider.id=$1`, [id]);
  const row = result.rows[0];
  if (!row) return null;
  const started = Date.now();
  let outcome: LlmProviderTestResult;
  try {
    const { apiKey } = await providerCredential(pool, row);
    if (row.auth_type !== 'none' && !apiKey) throw new Error(`Credential ${row.secret_name || 'API key'} is not configured`);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (row.auth_type === 'bearer' && apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (row.auth_type === 'api-key' && apiKey) {
      if (row.provider_type === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else headers['api-key'] = apiKey;
    }
    // Redirects are not followed: the SSRF check validated base_url, not
    // whatever host a redirect would point the credentialed request at.
    const response = await fetch(`${row.base_url.replace(/\/+$/, '')}/models`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`HTTP ${response.status}: provider redirected; configure the final base URL instead`);
    }
    const raw = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 240)}`);
    let data: unknown;
    try { data = JSON.parse(raw); } catch { data = {}; }
    const entries = Array.isArray((data as Record<string, unknown>)['data'])
      ? (data as Record<string, unknown>)['data'] as unknown[]
      : Array.isArray((data as Record<string, unknown>)['models'])
        ? (data as Record<string, unknown>)['models'] as unknown[]
        : [];
    const models = [...new Set(entries.flatMap(item => {
      if (typeof item === 'string') return [item];
      if (item && typeof item === 'object') {
        const idValue = (item as Record<string, unknown>)['id'] ?? (item as Record<string, unknown>)['name'];
        if (typeof idValue === 'string' && idValue) return [idValue];
      }
      return [];
    }))].sort().slice(0, 200);
    outcome = { ok: true, latencyMs: Date.now() - started, models };
  } catch (error) {
    outcome = { ok: false, latencyMs: Date.now() - started, models: [], error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
  await pool.query(
    `UPDATE mcp_llm_providers
        SET last_test_status=$2, last_tested_at=now(), last_test_error=$3
      WHERE id=$1`,
    [id, outcome.ok ? 'healthy' : 'failed', outcome.error ?? null],
  );
  return outcome;
}
