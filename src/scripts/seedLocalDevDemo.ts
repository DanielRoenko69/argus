import pg from 'pg';
import { encrypt } from '../lib/encryption.js';
import { ingestDocument } from '../agents/kb/ingest.js';
import { classifyTemplateToolRisk } from '../templates/applyTemplate.js';
import { getTemplateById } from '../templates/serviceTemplates.js';

const { Pool } = pg;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Argus.Dev demo seed`);
  return value;
}

interface GiteaTreeEntry {
  path?: string;
  type?: string;
}

const DEMO_SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.json', '.toml', '.md', '.css', '.html',
  '.sh', '.yml', '.yaml', '.dockerfile',
]);

function sourceExtension(path: string): string {
  if (path === 'Dockerfile') return '.dockerfile';
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

function markdownFence(path: string): string {
  const extension = sourceExtension(path).replace(/^\./, '');
  if (extension === 'yml') return 'yaml';
  if (extension === 'dockerfile') return 'dockerfile';
  return extension;
}

async function giteaRequest(url: string, token: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`Gitea request failed (${response.status}) for ${new URL(url).pathname}: ${detail}`);
  }
  return response;
}

async function buildRepositoryCorpus(
  baseUrl: string,
  token: string,
  owner: string,
  repo: string,
): Promise<{ content: string; fileCount: number }> {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const treeResponse = await giteaRequest(
    `${baseUrl}/api/v1/repos/${encodedOwner}/${encodedRepo}/git/trees/main?recursive=true`,
    token,
  );
  const tree = await treeResponse.json() as { tree?: GiteaTreeEntry[] };
  const paths = (tree.tree ?? [])
    .filter(entry => entry.type === 'blob' && typeof entry.path === 'string')
    .map(entry => entry.path!)
    .filter(path => DEMO_SOURCE_EXTENSIONS.has(sourceExtension(path)))
    .filter(path => !path.endsWith('package-lock.json'))
    .sort()
    .slice(0, 100);
  if (paths.length === 0) throw new Error('The demo repository contains no supported source files to ingest');

  const sections = [`# Repository ${owner}/${repo} @ main`, '',
    'This corpus is generated from the current main branch of the local Gitea demo repository.', ''];
  let totalBytes = 0;
  for (const path of paths) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const response = await giteaRequest(
      `${baseUrl}/api/v1/repos/${encodedOwner}/${encodedRepo}/contents/${encodedPath}?ref=main`,
      token,
    );
    const file = await response.json() as { content?: string; encoding?: string };
    if (file.encoding !== 'base64' || typeof file.content !== 'string') {
      throw new Error(`Gitea returned an unsupported content encoding for ${path}`);
    }
    const content = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > 1_000_000) throw new Error('The demo repository RAG corpus exceeds the 1 MB safety limit');
    sections.push(`## ${path}`, '', `\`\`\`${markdownFence(path)}`, content.trimEnd(), '\`\`\`', '');
  }
  return { content: sections.join('\n'), fileCount: paths.length };
}

async function main(): Promise<void> {
  const connectionString = requiredEnv('POSTGRES_CONNECTION_URL');
  const token = requiredEnv('GITEA_TOKEN');
  const baseUrl = (process.env['GITEA_BASE_URL']?.trim() || 'http://gitea:3000').replace(/\/+$/, '');
  const owner = process.env['GITEA_OWNER']?.trim() || 'argus';
  const repo = process.env['GITEA_REPO']?.trim() || 'argus-dev-sample';
  const profileSlug = (process.env['ARGUS_DEV_DEMO_PROFILE']?.trim() ||
    (repo === 'argus-dev-sample' ? 'local' : repo))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!profileSlug) throw new Error('ARGUS_DEV_DEMO_PROFILE must contain at least one letter or number');
  const isDefaultProfile = profileSlug === 'local';
  const bundleName = process.env['ARGUS_DEV_BUNDLE_NAME']?.trim() ||
    (isDefaultProfile ? 'argus-dev-demo' : `argus-dev-${profileSlug.replaceAll('_', '-')}`);
  const bundleLabel = process.env['ARGUS_DEV_BUNDLE_LABEL']?.trim() ||
    (isDefaultProfile ? 'Argus.Dev Demo' : `Argus.Dev ${profileSlug.replaceAll('_', ' ')}`);
  const installRag = process.env['ARGUS_DEV_INSTALL_REPOSITORY_RAG']?.trim().toLowerCase() !== 'false';
  const argusUsername = process.env['ARGUS_DEV_DEMO_USER']?.trim() || 'Alex';
  const workspaceSecret = requiredEnv('WORKSPACE_SECRET');
  const prefix = `gitea_${profileSlug}`;
  const template = getTemplateById('gitea');
  if (!template) throw new Error('The native Gitea MCP template is not registered');
  const langgraphPrefix = `langgraph_${profileSlug}`;
  const langgraphTemplate = getTemplateById('langgraph');
  if (!langgraphTemplate) throw new Error('The native LangGraph MCP template is not registered');

  const fields = {
    base_url: baseUrl,
    token,
    owner,
    repo,
    default_branch: 'main',
  };
  const langgraphFields = {
    base_url: process.env['LANGGRAPH_URL']?.trim() || 'http://argus-dev:2025',
    workspace_secret: workspaceSecret,
  };
  const repositoryCorpus = installRag ? await buildRepositoryCorpus(baseUrl, token, owner, repo) : null;
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const bundleResult = await client.query<{ id: number }>(
      `INSERT INTO mcp_service_bundles (name, label, description, icon)
       VALUES ($1, $2,
               'Governed Gitea, LangGraph and repository capabilities for a local Argus.Dev E2E lab.',
               'code')
       ON CONFLICT (name) DO UPDATE SET
         label = EXCLUDED.label,
         description = EXCLUDED.description,
         icon = EXCLUDED.icon,
         updated_at = now()
       RETURNING id`,
      [bundleName, bundleLabel],
    );
    const bundleId = bundleResult.rows[0]!.id;

    const backendResult = await client.query<{ id: number }>(
      `INSERT INTO mcp_backends (
         name, description, base_url, auth_type, auth_value, health_path,
         default_headers, timeout_ms, tls_skip_verify, enabled, backend_type, config
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 10000, false, true, 'http', $8)
       ON CONFLICT (name) DO UPDATE SET
         description = EXCLUDED.description,
         base_url = EXCLUDED.base_url,
         auth_type = EXCLUDED.auth_type,
         auth_value = EXCLUDED.auth_value,
         health_path = EXCLUDED.health_path,
         default_headers = EXCLUDED.default_headers,
         enabled = true,
         backend_type = 'http',
         config = EXCLUDED.config,
         updated_at = now()
       RETURNING id`,
      [
        prefix,
        'Local Gitea — native REST connection exposed by Argus as governed MCP capabilities',
        template.buildBaseUrl(fields),
        template.buildAuthType?.(fields) ?? 'bearer',
        encrypt(template.buildAuthValue?.(fields) ?? null),
        template.buildHealthPath?.(fields) ?? '/api/healthz',
        JSON.stringify(template.buildDefaultHeaders?.(fields) ?? {}),
        JSON.stringify(template.buildConfig?.(fields) ?? {}),
      ],
    );
    const backendId = backendResult.rows[0]!.id;

    await client.query(
      `INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [backendId, bundleId],
    );
    await client.query(
      `INSERT INTO mcp_bundle_backend_tool_policies (backend_id, bundle_id, mode, allowed_tool_names)
       VALUES ($1, $2, 'all', '{}')
       ON CONFLICT (backend_id, bundle_id) DO UPDATE SET mode = 'all', allowed_tool_names = '{}', updated_at = now()`,
      [backendId, bundleId],
    );

    const toolIds: number[] = [];
    for (const definition of template.tools) {
      const name = `${prefix}_${definition.nameSuffix}`;
      const risk = classifyTemplateToolRisk(definition);
      const result = await client.query<{ id: number }>(
        `INSERT INTO mcp_tools (
           name, description, backend, query_template, parameters, category,
           enabled, is_write, risk_level
         ) VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
         ON CONFLICT (name) DO UPDATE SET
           description = EXCLUDED.description,
           backend = EXCLUDED.backend,
           query_template = EXCLUDED.query_template,
           parameters = EXCLUDED.parameters,
           category = EXCLUDED.category,
           enabled = true,
           is_write = EXCLUDED.is_write,
           risk_level = EXCLUDED.risk_level,
           updated_at = now()
         RETURNING id`,
        [
          name,
          definition.description,
          `custom:${prefix}`,
          definition.queryTemplate,
          JSON.stringify(definition.parameters),
          definition.category,
          risk.isWrite,
          risk.riskLevel,
        ],
      );
      const toolId = result.rows[0]!.id;
      toolIds.push(toolId);
      await client.query(
        `INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [toolId, bundleId],
      );
    }

    const langgraphBackendResult = await client.query<{ id: number }>(
      `INSERT INTO mcp_backends (
         name, description, base_url, auth_type, auth_value, health_path,
         default_headers, timeout_ms, tls_skip_verify, enabled, backend_type, config
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 10000, false, true, 'http', $8)
       ON CONFLICT (name) DO UPDATE SET
         description = EXCLUDED.description,
         base_url = EXCLUDED.base_url,
         auth_type = EXCLUDED.auth_type,
         auth_value = EXCLUDED.auth_value,
         health_path = EXCLUDED.health_path,
         default_headers = EXCLUDED.default_headers,
         enabled = true,
         backend_type = 'http',
         config = EXCLUDED.config,
         updated_at = now()
       RETURNING id`,
      [
        langgraphPrefix,
        'Local LangGraph runtime exposed as read-only MCP observability; execution stays governed by A2A',
        langgraphTemplate.buildBaseUrl(langgraphFields),
        langgraphTemplate.buildAuthType?.(langgraphFields) ?? 'header',
        encrypt(langgraphTemplate.buildAuthValue?.(langgraphFields) ?? null),
        langgraphTemplate.buildHealthPath?.(langgraphFields) ?? '/healthz',
        JSON.stringify(langgraphTemplate.buildDefaultHeaders?.(langgraphFields) ?? {}),
        JSON.stringify(langgraphTemplate.buildConfig?.(langgraphFields) ?? {}),
      ],
    );
    const langgraphBackendId = langgraphBackendResult.rows[0]!.id;
    await client.query(
      `INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [langgraphBackendId, bundleId],
    );
    await client.query(
      `INSERT INTO mcp_bundle_backend_tool_policies (backend_id, bundle_id, mode, allowed_tool_names)
       VALUES ($1, $2, 'all', '{}')
       ON CONFLICT (backend_id, bundle_id) DO UPDATE SET mode = 'all', allowed_tool_names = '{}', updated_at = now()`,
      [langgraphBackendId, bundleId],
    );

    const langgraphToolIds: number[] = [];
    for (const definition of langgraphTemplate.tools) {
      const name = `${langgraphPrefix}_${definition.nameSuffix}`;
      const risk = classifyTemplateToolRisk(definition);
      const result = await client.query<{ id: number }>(
        `INSERT INTO mcp_tools (
           name, description, backend, query_template, parameters, category,
           enabled, is_write, risk_level
         ) VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
         ON CONFLICT (name) DO UPDATE SET
           description = EXCLUDED.description,
           backend = EXCLUDED.backend,
           query_template = EXCLUDED.query_template,
           parameters = EXCLUDED.parameters,
           category = EXCLUDED.category,
           enabled = true,
           is_write = EXCLUDED.is_write,
           risk_level = EXCLUDED.risk_level,
           updated_at = now()
         RETURNING id`,
        [
          name,
          definition.description,
          `custom:${langgraphPrefix}`,
          definition.queryTemplate,
          JSON.stringify(definition.parameters),
          definition.category,
          risk.isWrite,
          risk.riskLevel,
        ],
      );
      const toolId = result.rows[0]!.id;
      langgraphToolIds.push(toolId);
      await client.query(
        `INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [toolId, bundleId],
      );
    }

    let ragIndexId: number | null = null;
    const ragAgentNames = ['planner', 'knowledge', 'coder', 'reviewer'];
    if (installRag) {
      const ragName = `argus-dev-${profileSlug}`;
      const ragResult = await client.query<{ id: number }>(
        `INSERT INTO mcp_rag_indexes (
           name, label, description, provider, endpoint, index_name, adapter_config, top_k, enabled
         ) VALUES ($1, $2,
           'Locally embedded source knowledge generated from the current Gitea main branch.',
           'pgvector', '', $1, $3, 5, true)
         ON CONFLICT (name) DO UPDATE SET
           label = EXCLUDED.label,
           description = EXCLUDED.description,
           provider = EXCLUDED.provider,
           endpoint = EXCLUDED.endpoint,
           index_name = EXCLUDED.index_name,
           adapter_config = EXCLUDED.adapter_config,
           top_k = EXCLUDED.top_k,
           enabled = true,
           updated_at = now()
         RETURNING id`,
        [ragName, `${bundleLabel} Repository`, JSON.stringify({ source: 'gitea', repository: `${owner}/${repo}`, branch: 'main' })],
      );
      ragIndexId = ragResult.rows[0]!.id;
      await client.query(
        `INSERT INTO mcp_agent_rag_indexes (agent_id, rag_index_id, priority)
         SELECT id, $1, CASE name
           WHEN 'knowledge' THEN 0 WHEN 'planner' THEN 1 WHEN 'coder' THEN 2 ELSE 3 END
         FROM mcp_agents WHERE name = ANY($2::text[])
         ON CONFLICT (agent_id, rag_index_id) DO UPDATE SET priority = EXCLUDED.priority`,
        [ragIndexId, ragAgentNames],
      );
    }

    const userResult = await client.query<{ id: number; username: string }>(
      `SELECT id, username FROM mcp_users WHERE lower(username) = lower($1) AND enabled = true LIMIT 1`,
      [argusUsername],
    );
    const user = userResult.rows[0] ?? null;
    if (user) {
      for (const pattern of ['workspace_*', `${prefix}_*`, `${langgraphPrefix}_*`]) {
        await client.query(
          `INSERT INTO mcp_user_tool_rules (user_id, tool_pattern, effect, reason, created_by)
           SELECT $1, $2, 'allow', 'Argus.Dev local demo access', $1
            WHERE NOT EXISTS (
              SELECT 1 FROM mcp_user_tool_rules
               WHERE user_id = $1 AND tool_pattern = $2 AND effect = 'allow'
                 AND reason = 'Argus.Dev local demo access' AND expires_at IS NULL
            )`,
          [user.id, pattern],
        );
      }
    }

    await client.query('COMMIT');
    const documentName = repositoryCorpus ? `${owner}-${repo}-main.md` : null;
    const ingested = repositoryCorpus && ragIndexId !== null
      ? await ingestDocument(pool, ragIndexId, documentName!, Buffer.from(repositoryCorpus.content, 'utf8'))
      : null;
    if (ingested && ragIndexId !== null && documentName) {
      await pool.query(
        `DELETE FROM mcp_kb_documents
         WHERE rag_index_id = $1 AND name = $2 AND id <> $3`,
        [ragIndexId, documentName, ingested.id],
      );
    }
    process.stdout.write(`${JSON.stringify({
      bundleId,
      backendId,
      langgraphBackendId,
      capabilityCount: toolIds.length + langgraphToolIds.length,
      grantedUser: user?.username ?? null,
      repository: `${owner}/${repo}`,
      ragIndexId,
      ragDocument: documentName,
      ragFileCount: repositoryCorpus?.fileCount ?? 0,
      ragChunkCount: ingested?.chunkCount ?? 0,
      ragAgents: installRag ? ragAgentNames : [],
    })}\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
