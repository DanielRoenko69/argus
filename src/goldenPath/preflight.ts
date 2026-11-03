import { redactCanonicalAuditPayload, canonicalAuditDigest } from '../audit/canonicalAuditRedaction.js';
import {
  GOLDEN_PATH_PREFLIGHT_CHECK_IDS,
  GOLDEN_PATH_SCHEMA_VERSION,
  goldenPathPreflightSchema,
  type GoldenPathPreflight,
} from './contracts.js';

export type GoldenPathMode = GoldenPathPreflight['mode'];
export type GoldenPathWriteMode = GoldenPathPreflight['policy']['writeMode'];
export type GoldenPathCheckState = GoldenPathPreflight['checks'][number]['state'];

export interface GoldenPathPreflightQuery {
  mode: GoldenPathMode;
  writeMode: GoldenPathWriteMode;
}

export interface GoldenPathDeploymentProfile {
  configured: boolean;
  missing: string[];
  mode: GoldenPathMode;
  workspaceKey: string;
  tenantKey: string;
  environment: string;
  workflowName: string;
  agentName: string;
  preferredRuntime: 'hermes' | 'native';
  fallbackAllowed: boolean;
  git: {
    provider: 'gitea' | 'github';
    bundleName: string;
    repository: string;
    issueNumber: number;
    baseUrlOrigin: string;
  };
  notification: {
    provider: 'slack_fixture' | 'slack';
    bundleName: string;
    destination: string;
  };
}

export interface GoldenPathConnectorSnapshot {
  bundleName: string;
  bundleId: number | null;
  authorized: boolean;
  assignedToWorkflow: boolean;
  state: GoldenPathCheckState;
  detail: string;
  toolNames: string[];
}

export interface GoldenPathPreflightSnapshot {
  generatedAt: string;
  profile: GoldenPathDeploymentProfile;
  coreReady: boolean;
  argusDev: { state: GoldenPathCheckState; detail: string };
  workflow: null | {
    id: number;
    name: string;
    revision: number;
    definition: unknown;
    humanOversightRequired: boolean;
    agentBound: boolean;
  };
  agent: null | {
    id: number;
    name: string;
    revision: string;
    definition: unknown;
    authorized: boolean;
  };
  runtime: {
    state: GoldenPathCheckState;
    detail: string;
    selected: 'hermes' | 'native';
    profileId: string;
    binding: unknown;
  };
  git: GoldenPathConnectorSnapshot;
  notification: GoldenPathConnectorSnapshot;
  evidence: { state: GoldenPathCheckState; detail: string };
}

export class GoldenPathPreflightValidationError extends Error {
  readonly status = 400;
}

function digest(value: unknown): string {
  return canonicalAuditDigest(redactCanonicalAuditPayload(value));
}

function boundedEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
  maximum = 300,
): string {
  return (environment[key]?.trim() || fallback).slice(0, maximum);
}

function parsePositiveInteger(value: string | undefined, fallback: number, key: string): number {
  if (!value?.trim()) return fallback;
  if (!/^\d+$/.test(value.trim())) throw new GoldenPathPreflightValidationError(`${key} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new GoldenPathPreflightValidationError(`${key} must be a positive integer`);
  }
  return parsed;
}

function parseOrigin(value: string, key: string): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid');
    return parsed.origin;
  } catch {
    throw new GoldenPathPreflightValidationError(`${key} must be an HTTP(S) origin without credentials`);
  }
}

function requiredLiveValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  missing: string[],
  placeholder: string,
): string {
  const value = environment[key]?.trim();
  if (value) return value;
  missing.push(key);
  return placeholder;
}

/**
 * Loads only non-secret Golden Path target identifiers. Provider credentials
 * stay in MCP Fabric/runtime secret stores and are never copied into this
 * profile or its API projection.
 */
export function loadGoldenPathDeploymentProfile(
  mode: GoldenPathMode,
  environment: NodeJS.ProcessEnv = process.env,
): GoldenPathDeploymentProfile {
  const certification = mode === 'certification';
  const missing: string[] = [];
  const read = (key: string, certificationDefault: string, placeholder: string): string => certification
    ? boundedEnvironmentValue(environment, key, certificationDefault)
    : requiredLiveValue(environment, key, missing, placeholder).slice(0, 300);

  const baseUrl = read(
    'ARGUS_GOLDEN_PATH_GIT_ORIGIN',
    environment['GITEA_BASE_URL']?.trim() || 'http://gitea:3000',
    'https://github.com',
  );
  const issueRaw = environment['ARGUS_GOLDEN_PATH_ISSUE_NUMBER'];
  if (!certification && !issueRaw?.trim()) missing.push('ARGUS_GOLDEN_PATH_ISSUE_NUMBER');

  const profile: GoldenPathDeploymentProfile = {
    configured: false,
    missing,
    mode,
    workspaceKey: boundedEnvironmentValue(environment, 'ARGUS_GOLDEN_PATH_WORKSPACE_KEY', 'default', 120),
    tenantKey: boundedEnvironmentValue(environment, 'ARGUS_GOLDEN_PATH_TENANT_KEY', 'default', 120),
    environment: boundedEnvironmentValue(environment, 'ARGUS_GOLDEN_PATH_ENVIRONMENT', 'demo', 120),
    workflowName: read('ARGUS_GOLDEN_PATH_WORKFLOW_NAME', 'golden_path_dev_triage', 'golden-path-not-configured'),
    agentName: read('ARGUS_GOLDEN_PATH_AGENT_NAME', 'planner', 'golden-path-agent-not-configured'),
    preferredRuntime: environment['ARGUS_GOLDEN_PATH_PREFERRED_RUNTIME'] === 'native' ? 'native' : 'hermes',
    fallbackAllowed: environment['ARGUS_GOLDEN_PATH_RUNTIME_FALLBACK'] !== 'false',
    git: {
      provider: certification ? 'gitea' : 'github',
      bundleName: read('ARGUS_GOLDEN_PATH_GIT_BUNDLE', 'gitea_local', 'golden-path-git-not-configured'),
      repository: read('ARGUS_GOLDEN_PATH_GIT_REPOSITORY', 'argus/golden-path-demo', 'not-configured/not-configured'),
      issueNumber: parsePositiveInteger(issueRaw, certification ? 17 : 1, 'ARGUS_GOLDEN_PATH_ISSUE_NUMBER'),
      baseUrlOrigin: parseOrigin(baseUrl, 'ARGUS_GOLDEN_PATH_GIT_ORIGIN'),
    },
    notification: {
      provider: certification ? 'slack_fixture' : 'slack',
      bundleName: read('ARGUS_GOLDEN_PATH_NOTIFICATION_BUNDLE', 'slack_fixture', 'golden-path-notification-not-configured'),
      destination: read('ARGUS_GOLDEN_PATH_NOTIFICATION_DESTINATION', 'argus-golden-path', 'not-configured'),
    },
  };
  profile.configured = profile.missing.length === 0;
  return profile;
}

export function parseGoldenPathPreflightQuery(input: Record<string, unknown>): GoldenPathPreflightQuery {
  const mode = input['mode'] ?? 'certification';
  const writeMode = input['writeMode'] ?? 'guarded';
  if (mode !== 'certification' && mode !== 'live_demo') {
    throw new GoldenPathPreflightValidationError('mode must be certification or live_demo');
  }
  if (writeMode !== 'read_only' && writeMode !== 'guarded') {
    throw new GoldenPathPreflightValidationError('writeMode must be read_only or guarded');
  }
  return { mode, writeMode };
}

function check(
  id: typeof GOLDEN_PATH_PREFLIGHT_CHECK_IDS[number],
  label: string,
  state: GoldenPathCheckState,
  detail: string,
  recovery?: { label: string; href: string },
): GoldenPathPreflight['checks'][number] {
  return { id, label, required: true, state, detail, ...(recovery ? { recovery } : {}) };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function goldenPathWorkflowPolicyShape(snapshot: GoldenPathPreflightSnapshot): {
  ready: boolean;
  detail: string;
} {
  const definition = record(snapshot.workflow?.definition);
  const rawSteps = Array.isArray(definition['steps']) ? definition['steps'] : [];
  const steps = rawSteps.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  const byId = new Map(steps.map(step => [String(step['id'] ?? ''), step]));
  const conditionedApprovals = steps.filter(step => step['type'] === 'argus.approval'
    && /input\.write_mode\s*===\s*['"]guarded['"]/.test(String(step['condition'] ?? '')));
  const writeToolNames = new Set([...snapshot.git.toolNames, ...snapshot.notification.toolNames]
    .filter(name => !/(?:^|_)(?:get|read|list|search|fetch)(?:_|$)/i.test(name)));
  const writes = steps.filter(step => step['type'] === 'argus.tool' && writeToolNames.has(String(step['tool'] ?? '')));
  const dependsOnApproval = (step: Record<string, unknown>, visited = new Set<string>()): boolean => {
    const dependencies = Array.isArray(step['depends_on']) ? step['depends_on'].map(String) : [];
    return dependencies.some(id => {
      if (visited.has(id)) return false;
      visited.add(id);
      const dependency = byId.get(id);
      return Boolean(dependency && (conditionedApprovals.includes(dependency) || dependsOnApproval(dependency, visited)));
    });
  };
  const guardedWrites = writes.filter(step => /input\.write_mode\s*===\s*['"]guarded['"]/.test(String(step['condition'] ?? ''))
    && dependsOnApproval(step));
  if (conditionedApprovals.length !== 1) {
    return { ready: false, detail: 'Golden Path requires exactly one approval step conditioned on input.write_mode === guarded.' };
  }
  if (writes.length === 0) {
    return { ready: false, detail: 'Golden Path workflow does not contain the configured bounded write steps.' };
  }
  if (guardedWrites.length !== writes.length) {
    return { ready: false, detail: 'Every configured write step must be guarded by write_mode and depend on the Golden Path approval.' };
  }
  return { ready: true, detail: `One conditional approval protects ${writes.length} bounded write step${writes.length === 1 ? '' : 's'}; read-only runs skip both.` };
}

export function buildGoldenPathPreflight(
  snapshot: GoldenPathPreflightSnapshot,
  query: GoldenPathPreflightQuery,
): GoldenPathPreflight {
  const { profile } = snapshot;
  if (profile.mode !== query.mode) throw new GoldenPathPreflightValidationError('snapshot mode does not match request mode');

  const workflowReady = Boolean(snapshot.workflow && snapshot.workflow.revision > 0 && snapshot.agent
    && snapshot.workflow.agentBound && snapshot.agent.authorized);
  const policyShape = workflowReady ? goldenPathWorkflowPolicyShape(snapshot) : { ready: false, detail: 'Workflow binding is not ready.' };
  const policyReady = workflowReady && policyShape.ready;
  const policyWrites: GoldenPathPreflight['policy']['writes'] = query.writeMode === 'guarded'
    ? ['git_comment', 'git_add_label', 'slack_post_message']
    : [];
  const checks: GoldenPathPreflight['checks'] = [
    check('core', 'Argus Core', snapshot.coreReady ? 'ready' : 'blocked', snapshot.coreReady
      ? 'Core API and database are healthy.'
      : 'Core persistence is unavailable.'),
    check('argus_dev', 'Argus Dev', snapshot.argusDev.state, snapshot.argusDev.detail, snapshot.argusDev.state === 'ready'
      ? undefined : { label: 'Open Argus Dev', href: '/solutions/argus.dev' }),
    check('runtime', 'Agent runtime', snapshot.runtime.state, snapshot.runtime.detail, snapshot.runtime.state === 'ready'
      ? undefined : { label: 'Configure runtime profile', href: '/build/agents' }),
    check('mcp_git', `${profile.git.provider === 'github' ? 'GitHub' : 'Gitea'} provider`, snapshot.git.state, snapshot.git.detail,
      snapshot.git.state === 'ready' ? undefined : { label: 'Configure Git bundle', href: '/build/mcp-fabric?intent=golden-path-git' }),
    check('mcp_notification', profile.notification.provider === 'slack' ? 'Slack provider' : 'Notification fixture', snapshot.notification.state, snapshot.notification.detail,
      snapshot.notification.state === 'ready' ? undefined : { label: 'Configure notification bundle', href: '/build/mcp-fabric?intent=golden-path-notification' }),
    check('workflow', 'Saved workflow', workflowReady ? 'ready' : 'blocked', workflowReady
      ? `Saved workflow revision ${snapshot.workflow!.revision} is bound to authorized Agent '${snapshot.agent!.name}'.`
      : 'An enabled append-only saved workflow revision and an authorized bound Agent are required.',
    workflowReady ? undefined : { label: 'Open Workflow Studio', href: '/build/workflows' }),
    check('policy', 'Write policy', policyReady ? 'ready' : 'blocked', policyReady
      ? query.writeMode === 'guarded'
        ? `External writes are exact-target scoped and require runtime approval. ${policyShape.detail}`
        : `Read-only execution grants no external write operations and requires no approval. ${policyShape.detail}`
      : policyShape.detail,
    policyReady ? undefined : { label: 'Configure workflow policy', href: '/build/workflows' }),
    check('evidence', 'Evidence pipeline', snapshot.evidence.state, snapshot.evidence.detail,
      snapshot.evidence.state === 'ready' ? undefined : { label: 'Open Audit & Evidence', href: '/observe/audit' }),
  ];
  const requiredProblem = checks.some(item => item.required && item.state !== 'ready');
  const optionalProblem = checks.some(item => !item.required && item.state !== 'ready');
  const state: GoldenPathPreflight['state'] = requiredProblem ? 'blocked' : optionalProblem ? 'degraded' : 'ready';
  const workflowDefinition = snapshot.workflow?.definition ?? { missing: profile.workflowName };
  const agentDefinition = snapshot.agent?.definition ?? { missing: profile.agentName };
  const runtimeBinding = snapshot.runtime.binding ?? { selected: snapshot.runtime.selected };
  const profileId = snapshot.runtime.profileId || `unconfigured:${snapshot.runtime.selected}`;

  return goldenPathPreflightSchema.parse({
    schemaVersion: GOLDEN_PATH_SCHEMA_VERSION,
    kind: 'argus.golden-path-preflight',
    mode: query.mode,
    state,
    generatedAt: snapshot.generatedAt,
    scope: {
      tenantKey: profile.tenantKey,
      workspaceKey: profile.workspaceKey,
      environment: profile.environment,
    },
    targets: {
      git: {
        provider: profile.git.provider,
        repository: profile.git.repository,
        issueNumber: profile.git.issueNumber,
        baseUrlOrigin: profile.git.baseUrlOrigin,
        allowedOperations: ['comment', 'add_label'],
        writeScopeSha256: digest({
          provider: profile.git.provider,
          repository: profile.git.repository,
          issueNumber: profile.git.issueNumber,
          operations: ['comment', 'add_label'],
        }),
      },
      notification: {
        provider: profile.notification.provider,
        destination: profile.notification.destination,
        allowedOperations: ['post_message'],
        writeScopeSha256: digest({
          provider: profile.notification.provider,
          destination: profile.notification.destination,
          operations: ['post_message'],
        }),
      },
    },
    runtime: {
      preferred: profile.preferredRuntime,
      selected: snapshot.runtime.selected,
      fallbackAllowed: profile.fallbackAllowed,
      profileId,
      grantSha256: digest({ profileId, binding: runtimeBinding, scope: profile.workspaceKey }),
    },
    workflow: {
      id: snapshot.workflow ? String(snapshot.workflow.id) : `missing:${profile.workflowName}`,
      revision: snapshot.workflow ? String(snapshot.workflow.revision) : 'missing',
      sha256: digest(workflowDefinition),
      saved: true,
      agent: {
        id: snapshot.agent ? String(snapshot.agent.id) : `missing:${profile.agentName}`,
        revision: snapshot.agent?.revision ?? 'missing',
        sha256: digest(agentDefinition),
      },
    },
    policy: {
      writeMode: query.writeMode,
      approvalRequired: query.writeMode === 'guarded',
      separationOfDutiesRequired: query.writeMode === 'guarded',
      policySha256: digest({
        writeMode: query.writeMode,
        writes: policyWrites,
        gitScope: profile.git,
        notificationScope: profile.notification,
      }),
      writes: policyWrites,
    },
    checks,
    allowedActions: state === 'ready' ? ['start', 'refresh'] : ['refresh', 'configure'],
  });
}
