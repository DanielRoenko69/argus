import type pg from 'pg';
import { decrypt, encrypt } from '../lib/encryption.js';
import { getSecret } from '../lib/secrets.js';
import type { LlmProvider } from './types.js';

export type CredentialBudgetMode = 'observe' | 'alert' | 'block';

export interface LlmCredentialProfileInput {
  name: string;
  label: string;
  description: string;
  providerType: LlmProvider;
  secretName: string | null;
  apiKey?: string | null;
  department: string | null;
  costCenter: string | null;
  monthlyBudgetUsd: number | null;
  budgetMode: CredentialBudgetMode;
  enabled: boolean;
  expiresAt: string | null;
}

export interface LlmCredentialProfileRecord extends Omit<LlmCredentialProfileInput, 'apiKey'> {
  id: number;
  credentialConfigured: boolean;
  inlineCredentialConfigured: boolean;
  assignedAgents: number;
  assignedProviders: number;
  currentMonthSpendUsd: number;
  budgetUsedPercent: number | null;
  expired: boolean;
  lastRotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CredentialRow extends pg.QueryResultRow {
  id: number;
  name: string;
  label: string;
  description: string;
  provider_type: LlmProvider;
  api_key: string | null;
  secret_name: string | null;
  department: string | null;
  cost_center: string | null;
  monthly_budget_usd: number | string | null;
  budget_mode: CredentialBudgetMode;
  enabled: boolean;
  expires_at: string | null;
  last_rotated_at: string | null;
  created_at: string;
  updated_at: string;
  assigned_agents: number | string;
  assigned_providers: number | string;
  current_month_spend_usd: number | string;
}

const PROVIDER_TYPES = new Set<LlmProvider>(['openai', 'anthropic', 'openai-compatible']);
const BUDGET_MODES = new Set<CredentialBudgetMode>(['observe', 'alert', 'block']);

const CREDENTIAL_SELECT = `
  SELECT profile.*,
         (SELECT count(*) FROM mcp_agents agent
           WHERE agent.llm_credential_profile_id=profile.id)::int AS assigned_agents,
         (SELECT count(*) FROM mcp_llm_providers provider
           WHERE provider.credential_profile_id=profile.id)::int AS assigned_providers,
         COALESCE((
           SELECT sum(trace.total_cost_usd)
             FROM mcp_observability_traces trace
            WHERE trace.started_at >= date_trunc('month', now())
              AND trace.metadata->>'credential_profile_id'=profile.id::text
         ), 0) AS current_month_spend_usd
    FROM mcp_llm_credential_profiles profile`;

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} ist erforderlich`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${label} ist zu lang`);
  return normalized;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null || value === '') return null;
  return requiredText(value, label, max);
}

function optionalPositiveNumber(value: unknown, label: string): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} muss größer als 0 sein`);
  return parsed;
}

function optionalDate(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Ablaufdatum ist ungültig');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Ablaufdatum ist ungültig');
  return parsed.toISOString();
}

export function normalizeLlmCredentialProfileInput(value: unknown): LlmCredentialProfileInput {
  const input = value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const name = requiredText(input['name'], 'Technischer Name', 96).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error('Technischer Name darf nur a-z, 0-9, _ und - enthalten');
  const providerType = input['providerType'] as LlmProvider;
  if (!PROVIDER_TYPES.has(providerType)) throw new Error('Provider-Typ ist ungültig');
  const budgetMode = input['budgetMode'] as CredentialBudgetMode;
  if (!BUDGET_MODES.has(budgetMode)) throw new Error('Budget-Modus ist ungültig');
  if (typeof input['enabled'] !== 'boolean') throw new Error('Enabled-Status ist ungültig');
  const secretName = optionalText(input['secretName'], 'Secret-Name', 160);
  if (secretName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretName)) {
    throw new Error('Secret-Name muss ein gültiger Environment-/Vault-Name sein');
  }
  const apiKey = input['apiKey'] === undefined
    ? undefined
    : input['apiKey'] === null || input['apiKey'] === ''
      ? null
      : requiredText(input['apiKey'], 'API-Key', 8_192);
  return {
    name,
    label: requiredText(input['label'], 'Anzeigename', 160),
    description: optionalText(input['description'], 'Beschreibung', 2_000) ?? '',
    providerType,
    secretName,
    ...(apiKey !== undefined ? { apiKey } : {}),
    department: optionalText(input['department'], 'Abteilung', 160),
    costCenter: optionalText(input['costCenter'], 'Kostenstelle', 96),
    monthlyBudgetUsd: optionalPositiveNumber(input['monthlyBudgetUsd'], 'Monatsbudget'),
    budgetMode,
    enabled: input['enabled'] as boolean,
    expiresAt: optionalDate(input['expiresAt']),
  };
}

function mapCredential(row: CredentialRow): LlmCredentialProfileRecord {
  const spend = Number(row.current_month_spend_usd ?? 0);
  const budget = row.monthly_budget_usd == null ? null : Number(row.monthly_budget_usd);
  return {
    id: Number(row.id),
    name: row.name,
    label: row.label,
    description: row.description,
    providerType: row.provider_type,
    secretName: row.secret_name,
    department: row.department,
    costCenter: row.cost_center,
    monthlyBudgetUsd: budget,
    budgetMode: row.budget_mode,
    enabled: row.enabled,
    expiresAt: row.expires_at,
    credentialConfigured: Boolean(row.api_key || row.secret_name),
    inlineCredentialConfigured: Boolean(row.api_key),
    assignedAgents: Number(row.assigned_agents ?? 0),
    assignedProviders: Number(row.assigned_providers ?? 0),
    currentMonthSpendUsd: spend,
    budgetUsedPercent: budget == null ? null : Math.round((spend / budget) * 10_000) / 100,
    expired: row.expires_at != null && new Date(row.expires_at).getTime() <= Date.now(),
    lastRotatedAt: row.last_rotated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listLlmCredentialProfiles(pool: pg.Pool): Promise<LlmCredentialProfileRecord[]> {
  const { rows } = await pool.query<CredentialRow>(
    `${CREDENTIAL_SELECT} ORDER BY profile.enabled DESC, profile.department NULLS LAST, profile.label, profile.id`,
  );
  return rows.map(mapCredential);
}

export async function createLlmCredentialProfile(
  pool: pg.Pool,
  input: LlmCredentialProfileInput,
  createdBy: number | null,
): Promise<LlmCredentialProfileRecord> {
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO mcp_llm_credential_profiles
       (name, label, description, provider_type, api_key, secret_name, department,
        cost_center, monthly_budget_usd, budget_mode, enabled, expires_at,
        last_rotated_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,$13)
     RETURNING id`,
    [input.name, input.label, input.description, input.providerType, encrypt(input.apiKey ?? null),
      input.secretName, input.department, input.costCenter, input.monthlyBudgetUsd,
      input.budgetMode, input.enabled, input.expiresAt, createdBy],
  );
  return (await getLlmCredentialProfile(pool, inserted.rows[0]!.id))!;
}

export async function getLlmCredentialProfile(pool: pg.Pool, id: number): Promise<LlmCredentialProfileRecord | null> {
  const { rows } = await pool.query<CredentialRow>(`${CREDENTIAL_SELECT} WHERE profile.id=$1`, [id]);
  return rows[0] ? mapCredential(rows[0]) : null;
}

export async function updateLlmCredentialProfile(
  pool: pg.Pool,
  id: number,
  input: LlmCredentialProfileInput,
): Promise<LlmCredentialProfileRecord | null> {
  const existing = await pool.query<{ api_key: string | null; last_rotated_at: string | null }>(
    'SELECT api_key, last_rotated_at FROM mcp_llm_credential_profiles WHERE id=$1',
    [id],
  );
  if (!existing.rows[0]) return null;
  const keyChanged = input.apiKey !== undefined;
  const nextKey = keyChanged ? encrypt(input.apiKey) : existing.rows[0].api_key;
  await pool.query(
    `UPDATE mcp_llm_credential_profiles
        SET name=$2, label=$3, description=$4, provider_type=$5, api_key=$6,
            secret_name=$7, department=$8, cost_center=$9, monthly_budget_usd=$10,
            budget_mode=$11, enabled=$12, expires_at=$13,
            last_rotated_at=CASE WHEN $14::boolean AND $6::text IS NOT NULL THEN now()
                                 WHEN $14::boolean THEN NULL ELSE last_rotated_at END
      WHERE id=$1`,
    [id, input.name, input.label, input.description, input.providerType, nextKey,
      input.secretName, input.department, input.costCenter, input.monthlyBudgetUsd,
      input.budgetMode, input.enabled, input.expiresAt, keyChanged],
  );
  return getLlmCredentialProfile(pool, id);
}

export async function deleteLlmCredentialProfile(pool: pg.Pool, id: number): Promise<boolean> {
  const profile = await getLlmCredentialProfile(pool, id);
  if (!profile) return false;
  if (profile.assignedAgents + profile.assignedProviders > 0) {
    throw new Error('Credential Profile kann nicht gelöscht werden, solange Agents oder Provider zugeordnet sind');
  }
  return (await pool.query('DELETE FROM mcp_llm_credential_profiles WHERE id=$1', [id])).rowCount === 1;
}

export interface ResolvedLlmCredential {
  apiKey: string;
  profile: LlmCredentialProfileRecord;
}

export async function resolveLlmCredentialProfile(
  pool: pg.Pool,
  id: number,
  expectedProvider: LlmProvider,
): Promise<ResolvedLlmCredential> {
  const result = await pool.query<CredentialRow>(`${CREDENTIAL_SELECT} WHERE profile.id=$1`, [id]);
  const row = result.rows[0];
  if (!row) throw new Error('Assigned LLM credential profile does not exist');
  const profile = mapCredential(row);
  if (profile.providerType !== expectedProvider) {
    throw new Error(`Credential profile “${profile.label}” is for ${profile.providerType}, not ${expectedProvider}`);
  }
  if (!profile.enabled) throw new Error(`Credential profile “${profile.label}” is disabled`);
  if (profile.expired) throw new Error(`Credential profile “${profile.label}” has expired`);
  if (profile.monthlyBudgetUsd != null && profile.budgetMode === 'block' && profile.currentMonthSpendUsd >= profile.monthlyBudgetUsd) {
    throw new Error(`Monthly budget for credential profile “${profile.label}” is exhausted`);
  }
  const apiKey = decrypt(row.api_key) || (row.secret_name ? await getSecret(row.secret_name) ?? '' : '');
  if (!apiKey) throw new Error(`Credential profile “${profile.label}” has no configured secret`);
  return { apiKey, profile };
}
