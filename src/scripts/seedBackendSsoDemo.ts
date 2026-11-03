import pg from 'pg';
import { encrypt } from '../lib/encryption.js';

const { Pool } = pg;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the backend SSO demo seed`);
  return value;
}

function publicOrigin(name: string, fallback: string): string {
  const raw = process.env[name]?.trim() || fallback;
  const parsed = new URL(raw);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new Error(`${name} must be a credential-free HTTP(S) URL`);
  }
  return parsed.origin;
}

interface BackendRow {
  id: number;
  name: string;
  config: Record<string, unknown>;
}

const proofWorkflowName = 'sso_it_readonly_backend_proof';
const proofGroupName = process.env['ARGUS_SSO_DEMO_GROUP']?.trim() || 'argus-platform-admins';
const proofToolPatterns = [
  'gitea_local_get_repo',
  'gitea_local_list_action_runs',
  'jenkins_prod_list_jobs',
  'jenkins_prod_get_job',
  'aiops_prometheus_query',
  'aiops_loki_query_range',
  'aiops_jaeger_services',
  'opensearch_prod_get_cluster_health',
  'opensearch_prod_search',
] as const;

const proofSteps = [
  { id: 'start', type: 'trigger.manual', label: 'Start SSO proof', args: {} },
  {
    id: 'gitea_repository', type: 'argus.tool', label: 'Read Gitea repository',
    tool: 'gitea_local_get_repo', args: { owner: 'argus', repo: 'argus-dev-sample' }, depends_on: ['start'],
  },
  {
    id: 'gitea_ci', type: 'argus.tool', label: 'Read Gitea Actions',
    tool: 'gitea_local_list_action_runs',
    args: { owner: 'argus', repo: 'argus-dev-sample', limit: 20 }, depends_on: ['start'],
  },
  {
    id: 'jenkins_jobs', type: 'argus.tool', label: 'Read Jenkins jobs',
    tool: 'jenkins_prod_list_jobs', args: {}, depends_on: ['gitea_ci'],
  },
  {
    id: 'jenkins_build', type: 'argus.tool', label: 'Read Jenkins production build',
    tool: 'jenkins_prod_get_job', args: { job_name: 'checkout-api-production' }, depends_on: ['jenkins_jobs'],
  },
  {
    id: 'prometheus', type: 'argus.tool', label: 'Query Prometheus',
    tool: 'aiops_prometheus_query', args: { query: 'up' }, depends_on: ['start'],
  },
  {
    id: 'loki', type: 'argus.tool', label: 'Query Loki logs',
    tool: 'aiops_loki_query_range',
    args: {
      query: '{service="argus-core", environment="local-demo"}',
      start: '{{ input.window_start }}', end: '{{ input.window_end }}', limit: 20, direction: 'backward',
    },
    depends_on: ['start'],
  },
  {
    id: 'jaeger', type: 'argus.tool', label: 'List Jaeger services',
    tool: 'aiops_jaeger_services', args: {}, depends_on: ['start'],
  },
  {
    id: 'opensearch_health', type: 'argus.tool', label: 'Read OpenSearch cluster health',
    tool: 'opensearch_prod_get_cluster_health', args: {}, depends_on: ['start'],
  },
  {
    id: 'opensearch_logs', type: 'argus.tool', label: 'Find checkout production incident',
    tool: 'opensearch_prod_search',
    args: {
      index: 'argus-production-logs',
      query_json: JSON.stringify({
        size: 10,
        query: {
          bool: {
            filter: [
              { term: { 'service.keyword': 'checkout-api' } },
              { term: { 'environment.keyword': 'production' } },
            ],
            must: [{ match: { message: 'payment-provider-timeout' } }],
          },
        },
      }),
    },
    depends_on: ['opensearch_health'],
  },
  {
    id: 'result', type: 'logic.response', label: 'Return bounded proof',
    args: { value: 'SSO backend proof completed for Gitea, Jenkins, Prometheus, Loki, Jaeger and OpenSearch production signals.' },
    depends_on: ['gitea_repository', 'jenkins_build', 'prometheus', 'loki', 'jaeger', 'opensearch_logs'],
  },
];

const proofBlockDefinitions = proofSteps.map((step, index) => ({
  id: step.id,
  type: step.type,
  position: {
    x: index === 0 ? 60 : index === proofSteps.length - 1 ? 980 : 320 + ((index - 1) % 2) * 330,
    y: index === 0 || index === proofSteps.length - 1 ? 260 : 40 + Math.floor((index - 1) / 2) * 220,
  },
  data: Object.fromEntries(Object.entries(step).filter(([key]) => !['id', 'type', 'depends_on'].includes(key))),
}));

interface DemoToolDefinition {
  name: string;
  description: string;
  queryTemplate: string;
  parameters: Array<Record<string, unknown>>;
  category: string;
}

async function seedProductionLikeBackend(
  pool: pg.Pool,
  input: {
    bundleName: string;
    name: string;
    description: string;
    baseUrl: string;
    authValue: string;
    healthPath: string;
    config: Record<string, unknown>;
    tools: DemoToolDefinition[];
  },
): Promise<{ backendId: number; toolIds: number[] }> {
  const bundle = await pool.query<{ id: number }>(
    'SELECT id FROM mcp_service_bundles WHERE name=$1',
    [input.bundleName],
  );
  const bundleId = bundle.rows[0]?.id;
  if (!bundleId) throw new Error(`Backend SSO demo requires bundle ${input.bundleName}`);

  const backend = await pool.query<{ id: number }>(
    `INSERT INTO mcp_backends (
       name, description, base_url, auth_type, auth_value, health_path,
       default_headers, timeout_ms, tls_skip_verify, enabled, backend_type, config
     ) VALUES ($1,$2,$3,'basic',$4,$5,'{}'::jsonb,15000,false,true,'http',$6::jsonb)
     ON CONFLICT (name) DO UPDATE SET
       description=EXCLUDED.description, base_url=EXCLUDED.base_url,
       auth_type='basic', auth_value=EXCLUDED.auth_value, health_path=EXCLUDED.health_path,
       default_headers='{}'::jsonb, timeout_ms=15000, tls_skip_verify=false,
       enabled=true, backend_type='http', config=EXCLUDED.config, updated_at=now()
     RETURNING id`,
    [
      input.name,
      input.description,
      input.baseUrl,
      encrypt(input.authValue),
      input.healthPath,
      JSON.stringify(input.config),
    ],
  );
  const backendId = backend.rows[0]!.id;
  await pool.query(
    `INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
     VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [backendId, bundleId],
  );
  await pool.query(
    `INSERT INTO mcp_bundle_backend_tool_policies (backend_id, bundle_id, mode, allowed_tool_names)
     VALUES ($1,$2,'all','{}')
     ON CONFLICT (backend_id, bundle_id) DO UPDATE SET
       mode='all', allowed_tool_names='{}', updated_at=now()`,
    [backendId, bundleId],
  );

  const toolIds: number[] = [];
  for (const tool of input.tools) {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO mcp_tools (
         name, description, backend, query_template, parameters, category,
         enabled, is_write, risk_level
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,true,false,'low')
       ON CONFLICT (name) DO UPDATE SET
         description=EXCLUDED.description, backend=EXCLUDED.backend,
         query_template=EXCLUDED.query_template, parameters=EXCLUDED.parameters,
         category=EXCLUDED.category, enabled=true, is_write=false,
         risk_level='low', updated_at=now()
       RETURNING id`,
      [tool.name, tool.description, `custom:${input.name}`, tool.queryTemplate, JSON.stringify(tool.parameters), tool.category],
    );
    const toolId = result.rows[0]!.id;
    toolIds.push(toolId);
    await pool.query(
      `INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [toolId, bundleId],
    );
  }
  return { backendId, toolIds };
}

async function seedProductionLikeBackends(pool: pg.Pool): Promise<Record<string, unknown>> {
  const jenkinsToken = process.env['ARGUS_JENKINS_SERVICE_TOKEN']?.trim()
    || '11a64f0e733bfa5da9d8bb312839476a1d';
  const opensearchPassword = process.env['ARGUS_OPENSEARCH_SERVICE_PASSWORD']?.trim()
    || 'ArgusOpenSearchService42!';
  const jenkins = await seedProductionLikeBackend(pool, {
    bundleName: 'argus-dev-demo',
    name: 'jenkins-prod',
    description: 'Production-like Jenkins CI with Workforce SSO for humans and a read-only Argus service identity.',
    baseUrl: 'http://jenkins-sso:8080',
    authValue: `argus-service:${jenkinsToken}`,
    healthPath: '/api/json',
    config: { kind: 'jenkins', environment: 'production-like', credential_mode: 'readonly-service-identity' },
    tools: [
      {
        name: 'jenkins_prod_list_jobs',
        description: 'List production-like Jenkins jobs and their latest build status (read-only).',
        queryTemplate: 'GET /api/json?tree=jobs[name,color,url,lastBuild[number,result,timestamp,url]]',
        parameters: [], category: 'DevOps',
      },
      {
        name: 'jenkins_prod_get_job',
        description: 'Read the production-like Jenkins job and its latest build evidence (read-only).',
        queryTemplate: 'GET /job/{{job_name}}/api/json?tree=name,url,color,lastBuild[number,result,timestamp,url,duration,building]',
        parameters: [{ name: 'job_name', type: 'string', description: 'Jenkins job name', required: true }],
        category: 'DevOps',
      },
    ],
  });
  const opensearch = await seedProductionLikeBackend(pool, {
    bundleName: 'argus-aiops-observe',
    name: 'opensearch-prod',
    description: 'Production-like OpenSearch logs with Workforce SSO for humans and a least-privileged Argus reader.',
    baseUrl: 'http://opensearch-sso:9200',
    authValue: `argus-service:${opensearchPassword}`,
    healthPath: '/_cluster/health',
    config: {
      kind: 'opensearch',
      environment: 'production-like',
      index: 'argus-production-logs',
      credential_mode: 'readonly-service-identity',
      read_only_post_paths: ['/argus-production-logs/_search'],
    },
    tools: [
      {
        name: 'opensearch_prod_get_cluster_health',
        description: 'Read health of the production-like OpenSearch cluster.',
        queryTemplate: 'GET /_cluster/health', parameters: [], category: 'Observability',
      },
      {
        name: 'opensearch_prod_search',
        description: 'Search structured production-like service logs in the bounded Argus evidence index.',
        queryTemplate: 'POST /{{index}}/_search\n\n{{query_json}}',
        parameters: [
          { name: 'index', type: 'string', description: 'Allowed OpenSearch evidence index', required: true },
          { name: 'query_json', type: 'string', description: 'OpenSearch Query DSL JSON', required: true },
        ],
        category: 'Observability',
      },
    ],
  });
  return { jenkins, opensearch };
}

async function seedProofWorkflow(pool: pg.Pool): Promise<{ id: number; bundleIds: number[] }> {
  const bundleResult = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM mcp_service_bundles
      WHERE name = ANY($1::text[]) ORDER BY id`,
    [['argus-dev-demo', 'argus-aiops-observe']],
  );
  const found = new Set(bundleResult.rows.map(bundle => bundle.name));
  const missing = ['argus-dev-demo', 'argus-aiops-observe'].filter(name => !found.has(name));
  if (missing.length > 0) throw new Error(`SSO proof workflow requires bundles: ${missing.join(', ')}`);

  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO mcp_workflows
       (name, description, steps, input_params, enabled, canvas_state, trigger_config,
        block_definitions, source, tags, lifecycle_status, human_oversight_required)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,true,$5::jsonb,$6::jsonb,$7::jsonb,'visual',$8::text[],'draft',false)
     ON CONFLICT (tenant_key, workspace_key, name) DO UPDATE SET
       description=EXCLUDED.description, steps=EXCLUDED.steps, input_params=EXCLUDED.input_params,
       enabled=true, canvas_state=EXCLUDED.canvas_state, trigger_config=EXCLUDED.trigger_config,
       block_definitions=EXCLUDED.block_definitions, source='visual', tags=EXCLUDED.tags,
       lifecycle_status='draft', human_oversight_required=false, updated_at=now()
     RETURNING id`,
    [
      proofWorkflowName,
      'Presentation-safe read-only proof that a Alex SSO session drives governed Dev, CI and AIOps backend actions.',
      JSON.stringify(proofSteps),
      JSON.stringify([
        { name: 'window_start', type: 'string', required: true, description: 'RFC3339 evidence window start' },
        { name: 'window_end', type: 'string', required: true, description: 'RFC3339 evidence window end' },
      ]),
      JSON.stringify({ theme: 'dark', viewport: { x: 0, y: 0, zoom: 0.9 } }),
      JSON.stringify({ type: 'manual' }),
      JSON.stringify(proofBlockDefinitions),
      ['demo', 'sso', 'dev', 'aiops', 'read-only'],
    ],
  );
  const workflowId = inserted.rows[0]!.id;
  const bundleIds = bundleResult.rows.map(bundle => bundle.id);
  await pool.query('DELETE FROM mcp_workflow_bundles WHERE workflow_id=$1', [workflowId]);
  for (const bundleId of bundleIds) {
    await pool.query(
      'INSERT INTO mcp_workflow_bundles (workflow_id, bundle_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [workflowId, bundleId],
    );
  }
  return { id: workflowId, bundleIds };
}

async function seedProofGroupAccess(pool: pg.Pool): Promise<{ groupName: string; toolPatterns: string[] }> {
  for (const toolPattern of proofToolPatterns) {
    await pool.query(
      `INSERT INTO mcp_group_tool_rules (group_name, tool_pattern, effect, reason)
       SELECT $1::varchar(128), $2::text, 'allow', 'Argus SSO IT golden-path read-only proof'
        WHERE NOT EXISTS (
          SELECT 1 FROM mcp_group_tool_rules
           WHERE group_name=$1::varchar(128) AND tool_pattern=$2::text AND effect='allow'
        )`,
      [proofGroupName, toolPattern],
    );
  }
  return { groupName: proofGroupName, toolPatterns: [...proofToolPatterns] };
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requiredEnv('POSTGRES_CONNECTION_URL') });
  const giteaOrigin = publicOrigin('GITEA_PUBLIC_URL', 'http://localhost:3005');
  const grafanaOrigin = publicOrigin('ARGUS_GRAFANA_PUBLIC_URL', 'http://localhost:3006');
  const jenkinsOrigin = publicOrigin('ARGUS_JENKINS_PUBLIC_URL', 'http://localhost:8081');
  const opensearchDashboardsOrigin = publicOrigin('ARGUS_OPENSEARCH_DASHBOARDS_PUBLIC_URL', 'http://localhost:5601');
  try {
    const productionLikeBackends = await seedProductionLikeBackends(pool);
    const result = await pool.query<BackendRow>(
      `SELECT id, name, config
         FROM mcp_backends
        WHERE enabled = true
          AND (
            config->>'kind' = ANY($2::text[])
            OR name = ANY($1::text[])
          )
        ORDER BY id`,
      [[
        'aiops-prometheus',
        'aiops-loki',
        'aiops-jaeger',
        'aiops-kubernetes',
        'aiops-kubernetes-remediation',
      ], ['gitea', 'jenkins', 'opensearch']],
    );
    const updated: Array<{ id: number; name: string; application: string; launchUrl: string }> = [];
    for (const backend of result.rows) {
      const isGitea = backend.config?.['kind'] === 'gitea';
      const isJenkins = backend.config?.['kind'] === 'jenkins';
      const isOpenSearch = backend.config?.['kind'] === 'opensearch';
      const owner = typeof backend.config?.['owner'] === 'string' ? backend.config['owner'] : null;
      const repo = typeof backend.config?.['repo_slug'] === 'string'
        ? backend.config['repo_slug']
        : typeof backend.config?.['repo'] === 'string' ? backend.config['repo'] : null;
      const launchUrl = isGitea
        ? `${giteaOrigin}/user/oauth2/argus-mfa-demo`
        : isJenkins
          ? `${jenkinsOrigin}/securityRealm/commenceLogin?from=%2Fjob%2Fcheckout-api-production%2F`
          : isOpenSearch
            ? `${opensearchDashboardsOrigin}/app/discover`
            : `${grafanaOrigin}/d/argus-sso-overview/argus-aiops-workforce-sso`;
      const portal = isGitea ? {
        mode: 'shared_oidc',
        application: 'Gitea',
        label: 'Open repository with SSO',
        launch_url: launchUrl,
        provider_name: 'Argus Workforce IdP',
        presentation_role: owner && repo
          ? `Source code, issues and CI actions for ${owner}/${repo}`
          : 'Source code, issues and CI actions for this governed connection',
      } : isJenkins ? {
        mode: 'shared_oidc',
        application: 'Jenkins',
        label: 'Open CI with SSO',
        launch_url: launchUrl,
        provider_name: 'Argus Workforce IdP',
        presentation_role: 'Human SSO view of the production-like checkout-api build; Argus automation remains read-only',
      } : isOpenSearch ? {
        mode: 'shared_oidc',
        application: 'OpenSearch Dashboards',
        label: 'Open production logs with SSO',
        launch_url: launchUrl,
        provider_name: 'Argus Workforce IdP',
        presentation_role: 'Human SSO view of service-specific production logs; Argus uses a least-privileged reader',
      } : {
        mode: 'shared_oidc',
        application: 'Grafana',
        label: 'Open AIOps portal with SSO',
        launch_url: launchUrl,
        provider_name: 'Argus Workforce IdP',
        presentation_role: 'Human SSO portal for governed Prometheus, Loki and Jaeger signals',
      };
      await pool.query(
        `UPDATE mcp_backends
            SET config = jsonb_set(config, '{sso_portal}', $2::jsonb, true), updated_at = now()
          WHERE id = $1`,
        [backend.id, JSON.stringify(portal)],
      );
      updated.push({ id: backend.id, name: backend.name, application: portal.application, launchUrl });
    }
    const proofAccess = await seedProofGroupAccess(pool);
    const proofWorkflow = await seedProofWorkflow(pool);
    process.stdout.write(`${JSON.stringify({
      schema: 'argus.backend-sso-demo-seed.v2',
      updatedCount: updated.length,
      giteaOrigin,
      grafanaOrigin,
      jenkinsOrigin,
      opensearchDashboardsOrigin,
      updated,
      productionLikeBackends,
      proofAccess,
      proofWorkflow: { name: proofWorkflowName, ...proofWorkflow },
    })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
