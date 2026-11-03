import type pg from 'pg';
import { agentAccessGate } from '../agents/agentStore.js';
import { assessAgentReadiness } from '../agents/agentReadiness.js';
import type { SessionUser } from '../auth/userAuth.js';
import type { SolutionPackDiscoveryState } from '../solutionPacks/discovery.js';
import type {
  GoldenPathCheckState,
  GoldenPathConnectorSnapshot,
  GoldenPathDeploymentProfile,
  GoldenPathPreflightQuery,
  GoldenPathPreflightSnapshot,
} from './preflight.js';

interface WorkflowRow extends pg.QueryResultRow {
  id: number;
  name: string;
  steps: unknown;
  input_params: unknown;
  trigger_config: unknown;
  version: number;
  human_oversight_required: boolean;
}

interface AgentIdRow extends pg.QueryResultRow { id: number }
interface BundleIdRow extends pg.QueryResultRow { bundle_id: number }
interface BundleRow extends pg.QueryResultRow { id: number; name: string; label: string }
interface BackendRow extends pg.QueryResultRow {
  id: number;
  name: string;
  backend_type: 'http' | 'mcp' | 'builtin';
  enabled: boolean;
  trust_status: 'unverified' | 'trusted' | 'changed' | 'quarantined' | null;
  tool_count: number | string | null;
}
interface ToolRow extends pg.QueryResultRow { name: string }
interface EvidenceRow extends pg.QueryResultRow { events_table: string | null; reports_table: string | null }

export interface GoldenPathStoreDependencies {
  now?: () => Date;
  auditEvidenceEnabled: boolean;
  loadPackState: (packId: string) => Promise<{ state: SolutionPackDiscoveryState; version: string | null } | null>;
}

function stages(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function serializeRevision(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return String(value ?? 'missing');
}

function workflowBindsAgent(steps: unknown, agent: { id: number; name: string; agent_role: string | null }): boolean {
  return stages(steps).some(step => {
    if (step['type'] !== 'argus.agent') return false;
    const agentId = Number(step['agent_id'] ?? step['agentId']);
    const name = String(step['agent_name'] ?? step['agent'] ?? '').trim();
    const role = String(step['agent_role'] ?? '').trim();
    return agentId === agent.id || name === agent.name || Boolean(role && agent.agent_role && role === agent.agent_role);
  });
}

function connectorState(
  bundle: BundleRow | undefined,
  authorized: boolean,
  assignedToWorkflow: boolean,
  backends: BackendRow[],
  toolNames: string[],
  requiredToolFragments: string[][],
): { state: GoldenPathCheckState; detail: string } {
  if (!bundle) return { state: 'not_configured', detail: 'The exact configured MCP bundle does not exist.' };
  if (!authorized) return { state: 'blocked', detail: `Bundle '${bundle.name}' is outside the signed-in user's server-side scope.` };
  if (!assignedToWorkflow) return { state: 'blocked', detail: `Bundle '${bundle.name}' is not assigned to the saved workflow.` };
  if (backends.length === 0) return { state: 'not_configured', detail: `Bundle '${bundle.name}' has no provider backend.` };
  const blockedBackends = backends.filter(backend => !backend.enabled
    || (backend.backend_type === 'mcp' && backend.trust_status !== 'trusted'));
  if (blockedBackends.length > 0) {
    return {
      state: 'blocked',
      detail: `Bundle '${bundle.name}' has disabled or untrusted provider connections: ${blockedBackends.map(item => item.name).join(', ')}.`,
    };
  }
  const lowerNames = toolNames.map(name => name.toLowerCase());
  const missingActions = requiredToolFragments.filter(alternatives => !lowerNames.some(name => alternatives.some(fragment => name.includes(fragment))));
  if (missingActions.length > 0) {
    return {
      state: 'blocked',
      detail: `Bundle '${bundle.name}' is missing ${missingActions.length} required Golden Path action${missingActions.length === 1 ? '' : 's'}.`,
    };
  }
  return {
    state: 'ready',
    detail: `Bundle '${bundle.name}' is authorized, workflow-bound and exposes the required bounded actions.`,
  };
}

async function loadConnector(
  pool: pg.Pool,
  profile: GoldenPathDeploymentProfile,
  user: SessionUser,
  workflowBundleIds: Set<number>,
  kind: 'git' | 'notification',
  writeMode: GoldenPathPreflightQuery['writeMode'],
): Promise<GoldenPathConnectorSnapshot> {
  const bundleName = kind === 'git' ? profile.git.bundleName : profile.notification.bundleName;
  const bundleResult = await pool.query<BundleRow>(
    'SELECT id, name, label FROM mcp_service_bundles WHERE name=$1 LIMIT 1',
    [bundleName],
  );
  const bundle = bundleResult.rows[0];
  const authorized = Boolean(bundle && (user.allowed_bundles == null || user.allowed_bundles.includes(bundle.id)));
  const assignedToWorkflow = Boolean(bundle && workflowBundleIds.has(bundle.id));
  if (!bundle) {
    return { bundleName, bundleId: null, authorized: false, assignedToWorkflow: false, state: 'not_configured', detail: 'The exact configured MCP bundle does not exist.', toolNames: [] };
  }

  const [backendResult, toolResult] = await Promise.all([
    pool.query<BackendRow>(
      `SELECT backend.id, backend.name, backend.backend_type, backend.enabled,
              registry.trust_status, registry.tool_count
         FROM mcp_backend_bundles assignment
         JOIN mcp_backends backend ON backend.id=assignment.backend_id
         LEFT JOIN mcp_registry_entries registry ON registry.backend_id=backend.id
        WHERE assignment.bundle_id=$1
        ORDER BY backend.name`,
      [bundle.id],
    ),
    pool.query<ToolRow>(
      `SELECT tool.name
         FROM mcp_tool_bundles assignment
         JOIN mcp_tools tool ON tool.id=assignment.tool_id
        WHERE assignment.bundle_id=$1 AND tool.enabled=true
       UNION
       SELECT remote.prefixed_name AS name
         FROM mcp_backend_bundles assignment
         JOIN mcp_remote_tools remote ON remote.backend_id=assignment.backend_id
        WHERE assignment.bundle_id=$1
        ORDER BY name`,
      [bundle.id],
    ),
  ]);
  const toolNames = [...new Set(toolResult.rows.map(row => row.name))];
  const requiredToolFragments = kind === 'notification'
    ? [['post_message', 'send_message']]
    : writeMode === 'read_only'
      ? [['get_issue', 'read_issue']]
      : [['get_issue', 'read_issue'], ['comment'], ['add_label', 'set_label', 'labels']];
  const result = connectorState(bundle, authorized, assignedToWorkflow, backendResult.rows, toolNames, requiredToolFragments);
  return { bundleName, bundleId: bundle.id, authorized, assignedToWorkflow, ...result, toolNames };
}

function mapPackState(state: SolutionPackDiscoveryState | undefined): GoldenPathCheckState {
  if (state === 'ready') return 'ready';
  if (state === 'degraded') return 'degraded';
  if (state === 'not_checked' || state == null) return 'not_configured';
  return 'blocked';
}

export async function loadGoldenPathPreflightSnapshot(
  pool: pg.Pool,
  user: SessionUser,
  query: GoldenPathPreflightQuery,
  profile: GoldenPathDeploymentProfile,
  dependencies: GoldenPathStoreDependencies,
): Promise<GoldenPathPreflightSnapshot> {
  const workflowResult = await pool.query<WorkflowRow>(
    `SELECT workflow.id, workflow.name,
            COALESCE(version.steps, workflow.steps) AS steps,
            COALESCE(version.input_params, workflow.input_params) AS input_params,
            COALESCE(version.trigger_config, workflow.trigger_config, '{}'::jsonb) AS trigger_config,
            COALESCE(version.version, 0)::integer AS version,
            workflow.human_oversight_required
       FROM mcp_workflows workflow
       LEFT JOIN LATERAL (
         SELECT saved.version, saved.steps, saved.input_params, saved.trigger_config
           FROM mcp_workflow_versions saved
          WHERE saved.workflow_id=workflow.id
          ORDER BY saved.version DESC
          LIMIT 1
       ) version ON true
      WHERE workflow.name=$1 AND workflow.enabled=true AND COALESCE(workflow.source, 'visual') <> 'template'
      LIMIT 1`,
    [profile.workflowName],
  );
  const workflow = workflowResult.rows[0] ?? null;
  const workflowBundleResult = workflow
    ? await pool.query<BundleIdRow>('SELECT bundle_id FROM mcp_workflow_bundles WHERE workflow_id=$1', [workflow.id])
    : { rows: [] as BundleIdRow[] };
  const workflowBundleIds = new Set(workflowBundleResult.rows.map(row => row.bundle_id));

  const agentIdResult = await pool.query<AgentIdRow>('SELECT id FROM mcp_agents WHERE name=$1 AND enabled=true LIMIT 1', [profile.agentName]);
  const agentId = agentIdResult.rows[0]?.id;
  const access = agentId == null
    ? { verdict: 'not_found' as const, agent: null }
    : await agentAccessGate(pool, agentId, user);
  const agent = access.agent;
  const agentBound = Boolean(workflow && agent && workflowBindsAgent(workflow.steps, agent));
  let runtime: GoldenPathPreflightSnapshot['runtime'] = {
    state: 'blocked',
    detail: agent ? 'The selected Agent runtime could not be assessed.' : 'The configured Agent is missing or unauthorized.',
    selected: 'native',
    profileId: agent ? `native:${agent.id}` : 'native:missing',
    binding: { agentId: agent?.id ?? null },
  };
  if (agent && access.verdict === 'ok') {
    const readiness = await assessAgentReadiness(pool, agent, {
      bundleIds: [...workflowBundleIds],
      probeRuntime: true,
    });
    const selected = readiness.runtime.type === 'hermes' ? 'hermes' : 'native';
    const selectedDiffers = selected !== profile.preferredRuntime;
    const allowedSelection = !selectedDiffers || profile.fallbackAllowed;
    runtime = {
      state: readiness.ready && allowedSelection ? 'ready' : 'blocked',
      detail: readiness.ready && allowedSelection
        ? selectedDiffers
          ? `${readiness.runtime.detail}; policy selected the allowed ${selected} fallback.`
          : readiness.runtime.detail
        : [...readiness.blockers, ...(allowedSelection ? [] : ['Configured runtime fallback policy forbids this selection'])].join('; ').slice(0, 1_000) || 'Runtime readiness is blocked.',
      selected,
      profileId: readiness.runtime.profileId == null ? `native:${agent.id}` : String(readiness.runtime.profileId),
      binding: readiness.runtime,
    };
  }

  const [pack, git, notification, evidenceResult] = await Promise.all([
    dependencies.loadPackState('argus.dev'),
    loadConnector(pool, profile, user, workflowBundleIds, 'git', query.writeMode),
    loadConnector(pool, profile, user, workflowBundleIds, 'notification', query.writeMode),
    dependencies.auditEvidenceEnabled
      ? pool.query<EvidenceRow>("SELECT to_regclass('public.mcp_canonical_audit_events')::text AS events_table, to_regclass('public.mcp_audit_report_runs')::text AS reports_table")
      : Promise.resolve({ rows: [] as EvidenceRow[] }),
  ]);
  const evidenceTablesReady = Boolean(evidenceResult.rows[0]?.events_table && evidenceResult.rows[0]?.reports_table);
  const packState = mapPackState(pack?.state);
  const configuredState: GoldenPathCheckState = profile.configured ? 'ready' : 'not_configured';

  return {
    generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    profile,
    coreReady: true,
    argusDev: {
      state: profile.configured ? packState : configuredState,
      detail: !profile.configured
        ? `Golden Path target profile is incomplete: ${profile.missing.join(', ')}.`
        : packState === 'ready'
          ? `Argus Dev ${pack?.version ?? ''} is connected and ready.`.trim()
          : `Argus Dev discovery state is '${pack?.state ?? 'not_configured'}'.`,
    },
    workflow: workflow ? {
      id: workflow.id,
      name: workflow.name,
      revision: workflow.version,
      definition: { steps: workflow.steps, inputParams: workflow.input_params, triggerConfig: workflow.trigger_config },
      humanOversightRequired: workflow.human_oversight_required,
      agentBound,
    } : null,
    agent: agent ? {
      id: agent.id,
      name: agent.name,
      // node-postgres materializes TIMESTAMPTZ as Date even though the Agent
      // domain interface historically typed this field as a string. Keep the
      // public preflight contract transport-safe and stable at the DB edge.
      revision: serializeRevision(agent.updated_at),
      definition: {
        name: agent.name,
        model: agent.model,
        role: agent.agent_role,
        runtimeProfileId: agent.runtime_profile_id,
        bundleIds: agent.bundle_ids,
      },
      authorized: access.verdict === 'ok',
    } : null,
    runtime,
    git,
    notification,
    evidence: {
      state: dependencies.auditEvidenceEnabled && evidenceTablesReady ? 'ready' : 'blocked',
      detail: dependencies.auditEvidenceEnabled && evidenceTablesReady
        ? 'Canonical audit events and report/evidence persistence are enabled.'
        : 'Audit evidence v1 is disabled or its persistence schema is unavailable.',
    },
  };
}
