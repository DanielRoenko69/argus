import pg from 'pg';
import { getTemplateById } from './serviceTemplates.js';
import type { TemplateToolDefinition, ToolParameter } from './serviceTemplates.js';
import { logger } from '../lib/logger.js';
import { encrypt } from '../lib/encryption.js';
import { connectRemoteMcp, persistDiscoveredTools } from '../backends/remoteMcpClients.js';
import type { CustomBackendRow } from '../backends/customBackends.js';
import { protectHeadersForStorage } from '../backends/headerSecrets.js';

// ── Request / Response Types ─────────────────────────────────

export interface CustomToolInput {
  name: string;
  description: string;
  method: string;
  path: string;
  bodyTemplate?: string;
  parameters: ToolParameter[];
}

export interface ApplyTemplateRequest {
  templateId: string;
  prefix: string;
  fields: Record<string, string>;
  customTools?: CustomToolInput[];
  bundleId?: number;
  enabled?: boolean;
}

export interface ApplyTemplateResult {
  backend: { id: number; name: string };
  tools: Array<{ id: number; name: string }>;
}

// ── Helpers ──────────────────────────────────────────────────

export function sanitizePrefix(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function resolvePattern(pattern: string, prefix: string): string {
  return pattern.replaceAll('{{prefix}}', prefix);
}

export function classifyTemplateQueryRisk(queryTemplate: string): { isWrite: boolean; riskLevel: 'low' | 'medium' | 'high' } {
  const operation = queryTemplate.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? '';
  if (operation === 'GET' || operation === 'HEAD' || operation === 'SELECT') {
    return { isWrite: false, riskLevel: 'low' };
  }
  if (operation === 'DELETE' || operation === 'PUT' || operation === 'PATCH') {
    return { isWrite: true, riskLevel: 'high' };
  }
  return { isWrite: true, riskLevel: 'medium' };
}

export function classifyTemplateToolRisk(
  tool: Pick<TemplateToolDefinition, 'queryTemplate' | 'readOnly'>,
): { isWrite: boolean; riskLevel: 'low' | 'medium' | 'high' } {
  if (tool.readOnly === true) return { isWrite: false, riskLevel: 'low' };
  return classifyTemplateQueryRisk(tool.queryTemplate);
}

// ── Main Apply Function ──────────────────────────────────────

export async function applyTemplate(
  pool: pg.Pool,
  request: ApplyTemplateRequest,
): Promise<ApplyTemplateResult> {
  const template = getTemplateById(request.templateId);
  if (!template) {
    throw new Error(`Unknown template: ${request.templateId}`);
  }

  const prefix = sanitizePrefix(request.prefix);
  if (!prefix) {
    throw new Error('Prefix darf nicht leer sein');
  }

  // Validate required fields
  for (const field of template.fields) {
    if (field.required && !request.fields[field.name]) {
      throw new Error(`Pflichtfeld '${field.label}' fehlt`);
    }
  }

  const backendName = prefix;
  const baseUrl = template.buildBaseUrl(request.fields);
  const authType = template.buildAuthType?.(request.fields) ?? 'none';
  const authValue = template.buildAuthValue?.(request.fields) ?? null;
  const healthPath = template.buildHealthPath?.(request.fields) ?? null;
  const backendEnabled = request.enabled ?? true;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Create backend
    const bundleId = request.bundleId ?? null;
    const backendResult = await client.query(
      `INSERT INTO mcp_backends (name, description, base_url, auth_type, auth_value, health_path, default_headers, timeout_ms, tls_skip_verify, enabled, backend_type, mcp_endpoint, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id, name`,
      [
        backendName,
        `${template.name} - erstellt via Template`,
        baseUrl,
        authType,
        encrypt(authValue || null),
        healthPath,
        JSON.stringify(protectHeadersForStorage(template.buildDefaultHeaders?.(request.fields) ?? {})),
        10000,
        false,
        backendEnabled,
        template.backendType ?? 'http',
        template.buildMcpEndpoint?.(request.fields) ?? null,
        JSON.stringify(template.buildConfig?.(request.fields) ?? {}),
      ],
    );

    const backend = backendResult.rows[0] as { id: number; name: string };
    const createdTools: Array<{ id: number; name: string }> = [];

    // Link backend to bundle (n:m junction table)
    if (bundleId !== null) {
      await client.query(
        'INSERT INTO mcp_backend_bundles (backend_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [backend.id, bundleId],
      );
    }

    // 2. Create template-defined tools
    for (const toolDef of template.tools) {
      const toolName = `${prefix}_${toolDef.nameSuffix}`;
      const description = resolvePattern(toolDef.description, prefix);
      const backendRef = resolvePattern(toolDef.backend, prefix);
      const category = resolvePattern(toolDef.category, prefix);
      const risk = classifyTemplateToolRisk(toolDef);

      const toolResult = await client.query(
        `INSERT INTO mcp_tools (name, description, backend, query_template, parameters, category, enabled, is_write, risk_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, name`,
        [
          toolName,
          description,
          backendRef,
          toolDef.queryTemplate,
          JSON.stringify(toolDef.parameters),
          category,
          true,
          risk.isWrite,
          risk.riskLevel,
        ],
      );

      const tool = toolResult.rows[0] as { id: number; name: string };
      createdTools.push(tool);

      // Link tool to bundle (n:m junction table)
      if (bundleId !== null) {
        await client.query(
          'INSERT INTO mcp_tool_bundles (tool_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [tool.id, bundleId],
        );
      }
    }

    // 3. Create user-defined custom tools (REST API template)
    if (request.customTools && request.customTools.length > 0) {
      for (const ct of request.customTools) {
        const toolName = `${prefix}_${sanitizePrefix(ct.name)}`;
        const backendRef = `custom:${backendName}`;

        // Build query template: "METHOD /path\n\nbody"
        let queryTemplate = `${ct.method.toUpperCase()} ${ct.path}`;
        if (ct.bodyTemplate) {
          queryTemplate += `\n\n${ct.bodyTemplate}`;
        }
        const risk = classifyTemplateQueryRisk(queryTemplate);

        const toolResult = await client.query(
          `INSERT INTO mcp_tools (name, description, backend, query_template, parameters, category, enabled, is_write, risk_level)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, name`,
          [
            toolName,
            ct.description,
            backendRef,
            queryTemplate,
            JSON.stringify(ct.parameters),
            'API',
            true,
            risk.isWrite,
            risk.riskLevel,
          ],
        );

        const tool = toolResult.rows[0] as { id: number; name: string };
        createdTools.push(tool);

        // Link tool to bundle (n:m junction table)
        if (bundleId !== null) {
          await client.query(
            'INSERT INTO mcp_tool_bundles (tool_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [tool.id, bundleId],
          );
        }
      }
    }

    await client.query('COMMIT');

    // 4. For MCP-type templates, auto-connect and discover remote tools
    if (template.backendType === 'mcp' && backendEnabled) {
      try {
        const backendRow: CustomBackendRow = {
          id: backend.id,
          name: backend.name,
          description: `${template.name} - erstellt via Template`,
          base_url: baseUrl,
          auth_type: authType as CustomBackendRow['auth_type'],
          auth_value: authValue,
          health_path: healthPath,
          default_headers: template.buildDefaultHeaders?.(request.fields) ?? {},
          timeout_ms: 10000,
          tls_skip_verify: false,
          enabled: true,
          backend_type: 'mcp',
          mcp_endpoint: template.buildMcpEndpoint?.(request.fields) ?? '/mcp',
          bundle_id: bundleId,
          bundle_ids: bundleId !== null ? [bundleId] : [],
          transport_type: 'streamable-http',
          builtin_key: null,
          auth_mode: 'service-account',
          oauth_authorize_url: null,
          oauth_token_url: null,
          oauth_client_id: null,
          oauth_client_secret: null,
          oauth_scopes: null,
          oauth_revoke_url: null,
          config: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const conn = await connectRemoteMcp(backendRow);
        if (conn.connected) {
          await persistDiscoveredTools(pool, backend.id, conn.tools);
          logger.info({ backend: backend.name, toolCount: conn.tools.length }, 'MCP auto-connect successful');
        }
      } catch (mcpErr) {
        logger.warn({ err: mcpErr, backend: backend.name }, 'MCP auto-connect failed (backend still created)');
      }
    }

    logger.info({
      template: request.templateId,
      prefix,
      backendId: backend.id,
      toolCount: createdTools.length,
    }, 'Template applied successfully');

    return { backend, tools: createdTools };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
