import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  AgentTemplateInstallError,
  listAgentTemplates,
  previewAgentTemplateDefinition,
  type AgentTemplate,
  type AgentTemplateConfig,
  type AgentTemplateInstallInput,
  type AgentTemplatePreflight,
  type AgentTemplatePreflightOptions,
} from './agentTemplates.js';

export interface AgentTemplateDraftInput {
  name: string;
  label: string;
  description: string;
  category: string;
  agentMode: AgentTemplate['agentMode'];
  config: AgentTemplateConfig;
  compositeName: string | null;
  skillNames: string[];
  recommendedCapabilities: string[];
  requiredBy: string[];
  requiredToolPatterns: string[];
  minimumBundleCount: number;
}

export interface AgentTemplateDraft {
  name: string;
  definition: AgentTemplateDraftInput;
  baseVersion: number;
  targetVersion: number;
  existingTemplate: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DraftRow extends pg.QueryResultRow {
  name: string;
  definition: AgentTemplateDraftInput;
  base_version: number | string;
  published_version: number | string | null;
  preflight_definition_sha256: string | null;
  preflight_evidence: AgentTemplatePreflight | null;
  preflight_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

const PREFLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const DRAFT_SELECT = `
  SELECT draft.*,
         template.version AS published_version
    FROM mcp_agent_template_drafts draft
    LEFT JOIN mcp_agent_templates template ON template.name=draft.name`;

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item).trim()).filter(Boolean))]
    .slice(0, maxItems)
    .map(item => item.slice(0, maxLength));
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, maxLength);
}

function normalizeDraft(value: AgentTemplateDraftInput): AgentTemplateDraftInput {
  const name = String(value.name ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,128}$/.test(name)) {
    throw new AgentTemplateInstallError('Preset name must use 2-128 lowercase letters, numbers, underscores or hyphens', 400);
  }
  const label = String(value.label ?? '').trim();
  if (!label || label.length > 256) throw new AgentTemplateInstallError('Preset label is required and must not exceed 256 characters', 400);
  const category = String(value.category ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,64}$/.test(category)) {
    throw new AgentTemplateInstallError('Preset category must use lowercase letters, numbers, underscores or hyphens', 400);
  }
  if (!['chat', 'worker', 'reviewer'].includes(value.agentMode)) {
    throw new AgentTemplateInstallError('Select a valid Agent mode', 400);
  }
  const minimumBundleCount = Number(value.minimumBundleCount ?? 0);
  if (!Number.isInteger(minimumBundleCount) || minimumBundleCount < 0 || minimumBundleCount > 16) {
    throw new AgentTemplateInstallError('Minimum MCP bundle count must be between 0 and 16', 400);
  }
  const temperature = Number(value.config?.temperature ?? 0.3);
  const maxTokens = Number(value.config?.maxTokens ?? 4096);
  const maxIterations = Number(value.config?.maxIterations ?? 10);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new AgentTemplateInstallError('Temperature must be between 0 and 2', 400);
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 131072) {
    throw new AgentTemplateInstallError('Max tokens must be between 256 and 131072', 400);
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100) {
    throw new AgentTemplateInstallError('Max iterations must be between 1 and 100', 400);
  }
  const riskLevel = value.config?.riskLevel ?? 'low';
  if (!['low', 'medium', 'high'].includes(riskLevel)) throw new AgentTemplateInstallError('Select a valid risk level', 400);
  const visibility = value.config?.visibility ?? 'internal';
  if (!['internal', 'public'].includes(visibility)) throw new AgentTemplateInstallError('Select a valid visibility', 400);
  const compositeName = value.compositeName == null || value.compositeName === '' ? null : String(value.compositeName).trim();
  if (compositeName && !/^[a-z0-9_-]{2,128}$/.test(compositeName)) {
    throw new AgentTemplateInstallError('Composite name has an invalid format', 400);
  }
  const requiredToolPatterns = stringList(value.requiredToolPatterns, 64, 256);
  if (minimumBundleCount > 0 && requiredToolPatterns.length === 0) {
    throw new AgentTemplateInstallError('Bundle-scoped presets must declare at least one required tool pattern', 400);
  }
  return {
    name,
    label,
    description: String(value.description ?? '').trim().slice(0, 4000),
    category,
    agentMode: value.agentMode,
    config: {
      temperature,
      maxTokens,
      maxIterations,
      systemPrompt: optionalString(value.config?.systemPrompt, 50_000),
      agentRole: optionalString(value.config?.agentRole, 128),
      giteaProject: optionalString(value.config?.giteaProject, 256),
      enabled: value.config?.enabled ?? true,
      taskType: optionalString(value.config?.taskType, 128),
      allowedPaths: value.config?.allowedPaths == null ? undefined : stringList(value.config.allowedPaths, 64, 512),
      bitbucketRepo: optionalString(value.config?.bitbucketRepo, 256),
      thinkingBudget: Math.max(0, Math.min(131072, Number(value.config?.thinkingBudget ?? 0) || 0)),
      untrustedToolOutputEnforcement: value.config?.untrustedToolOutputEnforcement ?? true,
      codegraphEnabled: value.config?.codegraphEnabled ?? false,
      visibility,
      minRole: optionalString(value.config?.minRole, 20),
      riskLevel,
      humanOversightRequired: value.config?.humanOversightRequired ?? false,
    },
    compositeName,
    skillNames: stringList(value.skillNames, 64, 128),
    recommendedCapabilities: stringList(value.recommendedCapabilities, 64, 128),
    requiredBy: stringList(value.requiredBy, 64, 256),
    requiredToolPatterns,
    minimumBundleCount,
  };
}

function mapDraft(row: DraftRow): AgentTemplateDraft {
  const baseVersion = Number(row.base_version);
  return {
    name: row.name,
    definition: row.definition,
    baseVersion,
    targetVersion: baseVersion === 0 ? 1 : baseVersion + 1,
    existingTemplate: row.published_version != null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]));
  }
  return value;
}

function definitionFingerprint(definition: AgentTemplateDraftInput): string {
  return createHash('sha256').update(JSON.stringify(canonicalJson(definition))).digest('hex');
}

function draftAsTemplate(draft: AgentTemplateDraft): AgentTemplate {
  const definition = draft.definition;
  return {
    id: -1,
    ...definition,
    version: draft.targetVersion,
    compatibleBundleIds: [],
    installed: false,
    installedAgentId: null,
    installedVersion: null,
    installedAgents: [],
    upgradeAvailable: false,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

export async function listAgentTemplateDrafts(pool: pg.Pool): Promise<AgentTemplateDraft[]> {
  const { rows } = await pool.query<DraftRow>(`${DRAFT_SELECT} ORDER BY draft.updated_at DESC, draft.name`);
  return rows.map(mapDraft);
}

export async function saveAgentTemplateDraft(
  pool: pg.Pool,
  value: AgentTemplateDraftInput,
  userId?: number,
): Promise<AgentTemplateDraft> {
  const definition = normalizeDraft(value);
  const published = await pool.query<{ version: number | string }>(
    'SELECT version FROM mcp_agent_templates WHERE name=$1',
    [definition.name],
  );
  const baseVersion = Number(published.rows[0]?.version ?? 0);
  const { rows } = await pool.query<DraftRow>(
    `INSERT INTO mcp_agent_template_drafts (name, definition, base_version, created_by)
     VALUES ($1,$2::jsonb,$3,$4)
     ON CONFLICT (name) DO UPDATE SET
       definition=EXCLUDED.definition,
       preflight_definition_sha256=NULL,
       preflight_evidence=NULL,
       preflight_checked_at=NULL
     RETURNING *, $5::int AS published_version`,
    [definition.name, JSON.stringify(definition), baseVersion, userId ?? null, published.rows[0]?.version ?? null],
  );
  return mapDraft(rows[0]!);
}

export async function deleteAgentTemplateDraft(pool: pg.Pool, name: string): Promise<void> {
  const result = await pool.query('DELETE FROM mcp_agent_template_drafts WHERE name=$1', [name]);
  if (result.rowCount === 0) throw new AgentTemplateInstallError('Agent preset draft not found', 404);
}

async function getAgentTemplateDraft(pool: pg.Pool, name: string): Promise<AgentTemplateDraft> {
  const { rows } = await pool.query<DraftRow>(`${DRAFT_SELECT} WHERE draft.name=$1`, [name]);
  if (!rows[0]) throw new AgentTemplateInstallError('Agent preset draft not found', 404);
  return mapDraft(rows[0]);
}

export async function previewAgentTemplateDraft(
  pool: pg.Pool,
  name: string,
  input: AgentTemplateInstallInput,
  options: AgentTemplatePreflightOptions = {},
): Promise<AgentTemplatePreflight> {
  const draft = await getAgentTemplateDraft(pool, name);
  const preview = await previewAgentTemplateDefinition(pool, draftAsTemplate(draft), input, options);
  const fingerprint = definitionFingerprint(draft.definition);
  const proved = Boolean(preview.selectionValid && preview.readiness?.ready);
  const result = await pool.query(
    `UPDATE mcp_agent_template_drafts
        SET preflight_definition_sha256=$2,
            preflight_evidence=$3::jsonb,
            preflight_checked_at=$4
      WHERE name=$1 AND definition=$5::jsonb`,
    [
      name,
      proved ? fingerprint : null,
      proved ? JSON.stringify(preview) : null,
      proved ? new Date().toISOString() : null,
      JSON.stringify(draft.definition),
    ],
  );
  if (result.rowCount === 0) {
    throw new AgentTemplateInstallError('Preset draft changed while its preflight was running; run preflight again', 409);
  }
  return preview;
}

export async function publishAgentTemplateDraft(pool: pg.Pool, name: string): Promise<AgentTemplate> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const draftResult = await client.query<DraftRow>(
      'SELECT *, NULL::int AS published_version FROM mcp_agent_template_drafts WHERE name=$1 FOR UPDATE',
      [name],
    );
    const row = draftResult.rows[0];
    if (!row) throw new AgentTemplateInstallError('Agent preset draft not found', 404);
    const definition = normalizeDraft(row.definition);
    const templateResult = await client.query<{ version: number | string }>(
      'SELECT version FROM mcp_agent_templates WHERE name=$1 FOR UPDATE',
      [name],
    );
    const currentVersion = Number(templateResult.rows[0]?.version ?? 0);
    const baseVersion = Number(row.base_version);
    if (currentVersion !== baseVersion) {
      throw new AgentTemplateInstallError(
        `Preset changed after this draft was created (draft v${baseVersion}, current v${currentVersion})`,
        409,
      );
    }
    const proofAge = row.preflight_checked_at == null
      ? Number.POSITIVE_INFINITY
      : Date.now() - new Date(row.preflight_checked_at).getTime();
    if (
      row.preflight_definition_sha256 !== definitionFingerprint(definition)
      || !row.preflight_evidence?.selectionValid
      || !row.preflight_evidence.readiness?.ready
      || !Number.isFinite(proofAge)
      || proofAge < 0
      || proofAge > PREFLIGHT_MAX_AGE_MS
    ) {
      throw new AgentTemplateInstallError('Run a successful draft preflight within 24 hours before publishing', 409);
    }
    if (definition.compositeName) {
      const composite = await client.query('SELECT id FROM mcp_composites WHERE name=$1 AND enabled=true', [definition.compositeName]);
      if (!composite.rows[0]) throw new AgentTemplateInstallError(`Required policy composite is unavailable: ${definition.compositeName}`, 409);
    }
    if (definition.skillNames.length > 0) {
      const skills = await client.query<{ name: string }>('SELECT name FROM mcp_skills WHERE name=ANY($1::text[])', [definition.skillNames]);
      const found = new Set(skills.rows.map(skill => skill.name));
      const missing = definition.skillNames.filter(skill => !found.has(skill));
      if (missing.length) throw new AgentTemplateInstallError(`Required preset skills are unavailable: ${missing.join(', ')}`, 409);
    }
    const nextVersion = currentVersion + 1;
    await client.query(
      `INSERT INTO mcp_agent_templates
         (name, label, description, category, agent_mode, config, composite_name,
          skill_names, recommended_capabilities, required_by, required_tool_patterns,
          minimum_bundle_count, version)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (name) DO UPDATE SET
         label=EXCLUDED.label, description=EXCLUDED.description, category=EXCLUDED.category,
         agent_mode=EXCLUDED.agent_mode, config=EXCLUDED.config,
         composite_name=EXCLUDED.composite_name, skill_names=EXCLUDED.skill_names,
         recommended_capabilities=EXCLUDED.recommended_capabilities,
         required_by=EXCLUDED.required_by, required_tool_patterns=EXCLUDED.required_tool_patterns,
         minimum_bundle_count=EXCLUDED.minimum_bundle_count, version=EXCLUDED.version`,
      [
        definition.name, definition.label, definition.description, definition.category,
        definition.agentMode, JSON.stringify(definition.config), definition.compositeName,
        definition.skillNames, definition.recommendedCapabilities, definition.requiredBy,
        definition.requiredToolPatterns, definition.minimumBundleCount, nextVersion,
      ],
    );
    await client.query('DELETE FROM mcp_agent_template_drafts WHERE name=$1', [name]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const template = (await listAgentTemplates(pool)).find(item => item.name === name);
  if (!template) throw new Error('Published Agent preset could not be reloaded');
  return template;
}
