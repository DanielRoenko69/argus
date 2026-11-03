import type pg from 'pg';
import { applyTemplate, classifyTemplateToolRisk, type ApplyTemplateResult } from '../templates/applyTemplate.js';
import { TEMPLATE_CATEGORIES } from '../templates/categories.js';
import { certifyServiceTemplateTools } from '../templates/certification.js';
import { getAllTemplates, getTemplateById, type ServiceTemplate } from '../templates/serviceTemplates.js';

const MAX_FIELD_LENGTH = 8_192;
const BLOCKED_TEMPLATES: Partial<Record<string, string>> = {
  postgresql: 'Requires a credential-safe database adapter; the legacy template embeds credentials in a DSN.',
};

export class ServiceTemplateCatalogError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ServiceTemplateCatalogError';
  }
}

export interface ServiceTemplateInstallInput {
  templateId: string;
  prefix: string;
  fields: Record<string, string>;
  bundleId: number;
}

function mapTemplate(template: ServiceTemplate) {
  const unavailableReason = BLOCKED_TEMPLATES[template.id] ?? null;
  const certification = certifyServiceTemplateTools([template]);
  const certifiedCount = certification.filter(item => item.status === 'certified').length;
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    icon: template.icon,
    category: template.category,
    subcategory: template.subcategory ?? null,
    tags: template.tags ?? [],
    backendType: template.backendType ?? 'http',
    docsUrl: template.docsUrl ?? null,
    installable: unavailableReason == null,
    unavailableReason,
    certification: {
      level: 'contract' as const,
      status: certifiedCount === certification.length ? 'certified' as const : 'failed' as const,
      certifiedCount,
      totalCount: certification.length,
    },
    fields: template.fields.map(field => ({
      name: field.name,
      label: field.label,
      type: field.type,
      required: field.required,
      ...(field.type !== 'password' && field.default !== undefined ? { default: field.default } : {}),
      placeholder: field.placeholder ?? null,
      options: field.options ?? [],
    })),
    tools: template.tools.map(tool => {
      const risk = classifyTemplateToolRisk(tool);
      return {
        nameSuffix: tool.nameSuffix,
        description: tool.description,
        method: tool.queryTemplate.trim().split(/\s+/, 1)[0]?.toUpperCase() || null,
        ...risk,
      };
    }),
  };
}

export function getNativeServiceTemplateCatalog() {
  const templates = getAllTemplates().map(mapTemplate);
  return {
    generatedAt: new Date().toISOString(),
    categories: TEMPLATE_CATEGORIES.map(category => ({
      id: category.id,
      label: category.label,
      icon: category.icon,
      templateCount: templates.filter(template => template.category === category.id).length,
    })),
    templates,
  };
}

function normalizeFields(template: ServiceTemplate, value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceTemplateCatalogError('Template fields must be an object');
  }
  const raw = value as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const field of template.fields) {
    const candidate = raw[field.name] ?? field.default ?? '';
    if (typeof candidate !== 'string') {
      throw new ServiceTemplateCatalogError(`Field “${field.label}” must be text`);
    }
    if (candidate.length > MAX_FIELD_LENGTH) {
      throw new ServiceTemplateCatalogError(`Field “${field.label}” is too long`);
    }
    const normalized = field.type === 'password' ? candidate : candidate.trim();
    if (field.required && !normalized.trim()) {
      throw new ServiceTemplateCatalogError(`Required field “${field.label}” is missing`);
    }
    if (field.type === 'select' && normalized && !field.options?.includes(normalized)) {
      throw new ServiceTemplateCatalogError(`Field “${field.label}” has an invalid option`);
    }
    if (field.type === 'number' && normalized && !Number.isFinite(Number(normalized))) {
      throw new ServiceTemplateCatalogError(`Field “${field.label}” must be a number`);
    }
    fields[field.name] = normalized;
  }
  return fields;
}

export function normalizeServiceTemplateInstall(templateId: unknown, value: unknown): ServiceTemplateInstallInput {
  if (typeof templateId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(templateId)) {
    throw new ServiceTemplateCatalogError('Template ID is invalid');
  }
  const template = getTemplateById(templateId);
  if (!template) throw new ServiceTemplateCatalogError('Template not found', 404);
  const blockedReason = BLOCKED_TEMPLATES[template.id];
  if (blockedReason) throw new ServiceTemplateCatalogError(blockedReason, 409);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceTemplateCatalogError('Template configuration must be an object');
  }
  const raw = value as Record<string, unknown>;
  const prefix = typeof raw.prefix === 'string' ? raw.prefix.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(prefix)) {
    throw new ServiceTemplateCatalogError('Prefix must be 2–64 lowercase letters, numbers, underscores or hyphens');
  }
  const bundleId = Number(raw.bundleId);
  if (!Number.isSafeInteger(bundleId) || bundleId < 1) {
    throw new ServiceTemplateCatalogError('Choose an access bundle; native template installs cannot be unscoped');
  }
  const fields = normalizeFields(template, raw.fields);
  let target: URL;
  try {
    target = new URL(template.buildBaseUrl(fields));
  } catch {
    throw new ServiceTemplateCatalogError('Template fields do not produce a valid target URL');
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new ServiceTemplateCatalogError('Template target must be an HTTP(S) URL without embedded credentials');
  }
  return { templateId, prefix, fields, bundleId };
}

export async function installNativeServiceTemplate(
  pool: pg.Pool,
  templateId: unknown,
  value: unknown,
): Promise<{ input: ServiceTemplateInstallInput; result: ApplyTemplateResult }> {
  const input = normalizeServiceTemplateInstall(templateId, value);
  const bundle = await pool.query<{ id: number }>(
    'SELECT id FROM mcp_service_bundles WHERE id = $1',
    [input.bundleId],
  );
  if (!bundle.rows[0]) throw new ServiceTemplateCatalogError('Access bundle not found', 404);
  const result = await applyTemplate(pool, { ...input, enabled: false });
  return { input, result };
}
