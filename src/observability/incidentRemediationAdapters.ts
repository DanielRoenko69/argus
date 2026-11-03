import type { ToolResult } from '../tools/toolRunner.js';
import {
  KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_ADAPTER,
  KUBERNETES_SCALE_ADAPTER,
} from './incidentRemediationPlans.js';

export interface KubernetesScaleRemediationIntent {
  adapterKey: typeof KUBERNETES_SCALE_ADAPTER;
  workloadKind: 'Deployment' | 'StatefulSet';
  workloadName: string;
  desiredReplicas: number;
}

export interface KubernetesDeploymentRevisionRollbackIntent {
  adapterKey: typeof KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_ADAPTER;
  workloadKind: 'Deployment';
  workloadName: string;
  targetRevision: number;
}

export type IncidentRemediationExecutionIntent =
  | KubernetesScaleRemediationIntent
  | KubernetesDeploymentRevisionRollbackIntent;

export interface KubernetesRemediationTarget {
  backendId: number;
  targetId: string;
  cluster: string;
  namespace: string;
  environment: string;
}

export interface KubernetesScaleAdapterState {
  schemaVersion: 1;
  before: { replicas: number };
  desired: { replicas: number };
}

export interface KubernetesScaleObservedState {
  schemaVersion: 1;
  observed: { replicas: number };
}

export interface KubernetesRevisionAdapterState {
  schemaVersion: 1;
  before: { revision: number; templateHash: string };
  desired: { targetRevision: number; templateHash: string };
}

export interface KubernetesRevisionObservedState {
  schemaVersion: 1;
  observed: { revision: number; templateHash: string };
}

export type IncidentRemediationAdapterState = KubernetesScaleAdapterState | KubernetesRevisionAdapterState;
export type IncidentRemediationObservedState = KubernetesScaleObservedState | KubernetesRevisionObservedState;

export interface IncidentRemediationPreparedPlan {
  targetScope: Record<string, unknown>;
  preview: {
    format: string;
    summary: string;
    lines: string[];
    rollbackSummary: string;
  };
  writeArguments: Record<string, unknown>;
  verifyArguments: Record<string, unknown>;
  rollbackArguments: Record<string, unknown>;
  adapterState: IncidentRemediationAdapterState;
  previousReplicas: number | null;
  desiredReplicas: number | null;
  noop: boolean;
}

export interface IncidentRemediationAdapterControls {
  riskLevel: 'high';
  planApproval: 'hash_bound';
  verification: 'read_after_write';
  rollback: 'verified_restore';
  postChangeMonitoring: true;
  productionSeparationOfDuties: true;
}

export interface IncidentRemediationAdapterDefinition {
  key: IncidentRemediationExecutionIntent['adapterKey'];
  label: string;
  description: string;
  controls: IncidentRemediationAdapterControls;
  remoteToolName: string;
  workloadKinds: Array<'Deployment' | 'StatefulSet'>;
  replicaRange: { minimum: 1; maximum: 50 } | null;
  normalizeIntent(value: unknown): IncidentRemediationExecutionIntent | null;
  supportsToolSchema(schema: Record<string, unknown> | null): boolean;
  readArguments(intent: IncidentRemediationExecutionIntent, target: KubernetesRemediationTarget): Record<string, unknown>;
  observedState(result: ToolResult): IncidentRemediationObservedState | null;
  normalizeState(value: unknown): IncidentRemediationAdapterState | null;
  preparePlan(input: {
    intent: IncidentRemediationExecutionIntent;
    target: KubernetesRemediationTarget;
    currentResult: ToolResult;
  }): IncidentRemediationPreparedPlan | null;
  matchesDesiredState(state: IncidentRemediationAdapterState, observed: IncidentRemediationObservedState): boolean;
  matchesBeforeState(state: IncidentRemediationAdapterState, observed: IncidentRemediationObservedState): boolean;
  describeExpectedState(state: IncidentRemediationAdapterState, phase: 'desired' | 'before'): string;
  legacyObservedReplicas(observed: IncidentRemediationObservedState | null): number | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function workloadName(value: unknown): string | null {
  const normalized = typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return normalized
    && normalized.length <= 253
    && /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(normalized)
    ? normalized : null;
}

function normalizeKubernetesScaleIntent(value: unknown): KubernetesScaleRemediationIntent | null {
  const raw = object(value);
  if (!raw || raw['adapterKey'] !== KUBERNETES_SCALE_ADAPTER) return null;
  if (raw['workloadKind'] !== 'Deployment' && raw['workloadKind'] !== 'StatefulSet') return null;
  const name = workloadName(raw['workloadName']);
  const desiredReplicas = raw['desiredReplicas'];
  if (!name || !Number.isSafeInteger(desiredReplicas)
    || Number(desiredReplicas) < 1 || Number(desiredReplicas) > 50) return null;
  return {
    adapterKey: KUBERNETES_SCALE_ADAPTER,
    workloadKind: raw['workloadKind'],
    workloadName: name,
    desiredReplicas: Number(desiredReplicas),
  };
}

function normalizeKubernetesRevisionIntent(value: unknown): KubernetesDeploymentRevisionRollbackIntent | null {
  const raw = object(value);
  if (!raw || raw['adapterKey'] !== KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_ADAPTER
    || raw['workloadKind'] !== 'Deployment') return null;
  const name = workloadName(raw['workloadName']);
  const targetRevision = raw['targetRevision'];
  if (!name || !Number.isSafeInteger(targetRevision)
    || Number(targetRevision) < 1 || Number(targetRevision) > 1_000_000_000) return null;
  return {
    adapterKey: KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_ADAPTER,
    workloadKind: 'Deployment',
    workloadName: name,
    targetRevision: Number(targetRevision),
  };
}

function schemaProperties(schema: Record<string, unknown> | null): {
  required: unknown[];
  propertyType(name: string): unknown;
} | null {
  if (!schema || schema['type'] !== 'object') return null;
  const properties = object(schema['properties']);
  if (!properties) return null;
  return {
    required: Array.isArray(schema['required']) ? schema['required'] : [],
    propertyType(name: string): unknown {
      return object(properties[name])?.['type'];
    },
  };
}

function supportsScaleContract(schema: Record<string, unknown> | null): boolean {
  const contract = schemaProperties(schema);
  if (!contract) return false;
  return ['apiVersion', 'kind', 'name'].every(name => contract.required.includes(name) && contract.propertyType(name) === 'string')
    && contract.propertyType('namespace') === 'string'
    && ['integer', 'number'].includes(String(contract.propertyType('scale')));
}

function supportsRevisionContract(schema: Record<string, unknown> | null): boolean {
  const contract = schemaProperties(schema);
  if (!contract) return false;
  return ['name', 'namespace'].every(name => contract.required.includes(name) && contract.propertyType(name) === 'string')
    && contract.propertyType('targetRevision') === 'integer'
    && contract.propertyType('expectedCurrentTemplateHash') === 'string'
    && contract.propertyType('targetTemplateHash') === 'string';
}

function parsedResult(result: ToolResult): unknown {
  const raw = result.content.map(part => part.text).join('\n');
  try { return JSON.parse(raw); } catch { return null; }
}

function scaleFromResult(result: ToolResult): number | null {
  const raw = result.content.map(part => part.text).join('\n');
  const candidates: unknown[] = [];
  const parsed = parsedResult(result);
  if (parsed != null) candidates.push(parsed);
  const visit = (value: unknown, depth = 0): number | null => {
    if (depth > 8 || value == null) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found != null) return found;
      }
      return null;
    }
    if (typeof value !== 'object') return null;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:scale|replicas|currentReplicas)$/i.test(key)) {
        const parsedReplica = Number(item);
        if (Number.isSafeInteger(parsedReplica) && parsedReplica >= 0 && parsedReplica <= 10_000) return parsedReplica;
      }
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = visit(item, depth + 1);
      if (found != null) return found;
    }
    return null;
  };
  for (const candidate of candidates) {
    const found = visit(candidate);
    if (found != null) return found;
  }
  const match = raw.match(/\b(?:current\s+)?(?:scale|replicas)\s*[:=]\s*(\d{1,5})\b/i);
  const parsedReplica = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(parsedReplica) && parsedReplica >= 0 && parsedReplica <= 10_000 ? parsedReplica : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function templateHash(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function normalizeScaleState(value: unknown): KubernetesScaleAdapterState | null {
  const raw = object(value);
  const before = object(raw?.['before']);
  const desired = object(raw?.['desired']);
  const previousReplicas = boundedInteger(before?.['replicas'], 0, 10_000);
  const desiredReplicas = boundedInteger(desired?.['replicas'], 1, 50);
  if (raw?.['schemaVersion'] !== 1 || previousReplicas == null || desiredReplicas == null) return null;
  return { schemaVersion: 1, before: { replicas: previousReplicas }, desired: { replicas: desiredReplicas } };
}

function normalizeRevisionState(value: unknown): KubernetesRevisionAdapterState | null {
  const raw = object(value);
  const before = object(raw?.['before']);
  const desired = object(raw?.['desired']);
  const revision = boundedInteger(before?.['revision'], 1, 1_000_000_000);
  const targetRevision = boundedInteger(desired?.['targetRevision'], 1, 1_000_000_000);
  const beforeHash = templateHash(before?.['templateHash']);
  const desiredHash = templateHash(desired?.['templateHash']);
  if (raw?.['schemaVersion'] !== 1 || revision == null || targetRevision == null || !beforeHash || !desiredHash) return null;
  return {
    schemaVersion: 1,
    before: { revision, templateHash: beforeHash },
    desired: { targetRevision, templateHash: desiredHash },
  };
}

type RevisionSnapshot = {
  currentRevision: number;
  templateHash: string;
  availableRevisions: Array<{ revision: number; templateHash: string }>;
};

function revisionSnapshot(result: ToolResult): RevisionSnapshot | null {
  const raw = object(parsedResult(result));
  const currentRevision = boundedInteger(raw?.['currentRevision'], 1, 1_000_000_000);
  const currentHash = templateHash(raw?.['templateHash']);
  if (currentRevision == null || !currentHash || !Array.isArray(raw?.['availableRevisions'])) return null;
  const availableRevisions = raw['availableRevisions'].slice(0, 100).flatMap(value => {
    const revision = object(value);
    const number = boundedInteger(revision?.['revision'], 1, 1_000_000_000);
    const hash = templateHash(revision?.['templateHash']);
    return number == null || !hash ? [] : [{ revision: number, templateHash: hash }];
  });
  return { currentRevision, templateHash: currentHash, availableRevisions };
}

const controls = Object.freeze<IncidentRemediationAdapterControls>({
  riskLevel: 'high',
  planApproval: 'hash_bound',
  verification: 'read_after_write',
  rollback: 'verified_restore',
  postChangeMonitoring: true,
  productionSeparationOfDuties: true,
});

export const KUBERNETES_SCALE_REMEDIATION_ADAPTER = Object.freeze<IncidentRemediationAdapterDefinition>({
  key: KUBERNETES_SCALE_ADAPTER,
  label: 'Kubernetes workload scale',
  description: 'Scale one Deployment or StatefulSet inside the incident namespace, then verify or restore the previous replica count.',
  controls,
  remoteToolName: 'resources_scale',
  workloadKinds: ['Deployment', 'StatefulSet'],
  replicaRange: { minimum: 1, maximum: 50 },
  normalizeIntent: normalizeKubernetesScaleIntent,
  supportsToolSchema: supportsScaleContract,
  readArguments(intent, target) {
    if (intent.adapterKey !== KUBERNETES_SCALE_ADAPTER) return {};
    return { apiVersion: 'apps/v1', kind: intent.workloadKind, name: intent.workloadName, namespace: target.namespace };
  },
  observedState(result) {
    const replicas = scaleFromResult(result);
    return replicas == null ? null : { schemaVersion: 1, observed: { replicas } };
  },
  normalizeState: normalizeScaleState,
  preparePlan({ intent, target, currentResult }) {
    if (intent.adapterKey !== KUBERNETES_SCALE_ADAPTER) return null;
    const previousReplicas = scaleFromResult(currentResult);
    if (previousReplicas == null) return null;
    const verifyArguments = this.readArguments(intent, target);
    return {
      targetScope: {
        kind: 'kubernetes', backendId: target.backendId, targetId: target.targetId,
        cluster: target.cluster, namespace: target.namespace, environment: target.environment,
        workloadKind: intent.workloadKind, workloadName: intent.workloadName,
      },
      preview: {
        format: 'replica_diff',
        summary: `Scale ${intent.workloadKind} ${target.namespace}/${intent.workloadName} from ${previousReplicas} to ${intent.desiredReplicas} replicas.`,
        lines: [`- replicas: ${previousReplicas}`, `+ replicas: ${intent.desiredReplicas}`],
        rollbackSummary: `Restore replicas to ${previousReplicas} if verification does not observe ${intent.desiredReplicas}.`,
      },
      writeArguments: { ...verifyArguments, scale: intent.desiredReplicas },
      verifyArguments,
      rollbackArguments: { ...verifyArguments, scale: previousReplicas },
      adapterState: { schemaVersion: 1, before: { replicas: previousReplicas }, desired: { replicas: intent.desiredReplicas } },
      previousReplicas,
      desiredReplicas: intent.desiredReplicas,
      noop: previousReplicas === intent.desiredReplicas,
    };
  },
  matchesDesiredState(state, observed) {
    return 'replicas' in state.desired && 'replicas' in observed.observed
      && state.desired.replicas === observed.observed.replicas;
  },
  matchesBeforeState(state, observed) {
    return 'replicas' in state.before && 'replicas' in observed.observed
      && state.before.replicas === observed.observed.replicas;
  },
  describeExpectedState(state, phase) {
    const side = phase === 'before' ? state.before : state.desired;
    return 'replicas' in side ? `${side.replicas} replicas` : 'valid replica state';
  },
  legacyObservedReplicas(observed) {
    return observed && 'replicas' in observed.observed ? observed.observed.replicas : null;
  },
});

export const KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_REMEDIATION_ADAPTER = Object.freeze<IncidentRemediationAdapterDefinition>({
  key: KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_ADAPTER,
  label: 'Kubernetes deployment revision rollback',
  description: 'Restore one Deployment to an exact retained ReplicaSet revision through a workload-scoped connector, then verify its pod-template fingerprint.',
  controls,
  remoteToolName: 'deployment_revision_rollback',
  workloadKinds: ['Deployment'],
  replicaRange: null,
  normalizeIntent: normalizeKubernetesRevisionIntent,
  supportsToolSchema: supportsRevisionContract,
  readArguments(intent, target) {
    if (intent.adapterKey !== KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_ADAPTER) return {};
    return { name: intent.workloadName, namespace: target.namespace };
  },
  observedState(result) {
    const snapshot = revisionSnapshot(result);
    return snapshot == null ? null : {
      schemaVersion: 1,
      observed: { revision: snapshot.currentRevision, templateHash: snapshot.templateHash },
    };
  },
  normalizeState: normalizeRevisionState,
  preparePlan({ intent, target, currentResult }) {
    if (intent.adapterKey !== KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_ADAPTER) return null;
    const snapshot = revisionSnapshot(currentResult);
    const desired = snapshot?.availableRevisions.find(item => item.revision === intent.targetRevision);
    if (!snapshot || !desired) return null;
    const verifyArguments = this.readArguments(intent, target);
    const short = (hash: string) => `${hash.slice(0, 12)}…`;
    return {
      targetScope: {
        kind: 'kubernetes', backendId: target.backendId, targetId: target.targetId,
        cluster: target.cluster, namespace: target.namespace, environment: target.environment,
        workloadKind: 'Deployment', workloadName: intent.workloadName,
      },
      preview: {
        format: 'deployment_revision_diff',
        summary: `Restore Deployment ${target.namespace}/${intent.workloadName} from revision ${snapshot.currentRevision} to retained revision ${intent.targetRevision}.`,
        lines: [
          `- revision ${snapshot.currentRevision} · template ${short(snapshot.templateHash)}`,
          `+ revision ${intent.targetRevision} · template ${short(desired.templateHash)}`,
        ],
        rollbackSummary: `Restore template ${short(snapshot.templateHash)} from revision ${snapshot.currentRevision} if verification fails.`,
      },
      writeArguments: {
        ...verifyArguments,
        targetRevision: intent.targetRevision,
        expectedCurrentTemplateHash: snapshot.templateHash,
        targetTemplateHash: desired.templateHash,
      },
      verifyArguments,
      rollbackArguments: {
        ...verifyArguments,
        targetRevision: snapshot.currentRevision,
        expectedCurrentTemplateHash: desired.templateHash,
        targetTemplateHash: snapshot.templateHash,
      },
      adapterState: {
        schemaVersion: 1,
        before: { revision: snapshot.currentRevision, templateHash: snapshot.templateHash },
        desired: { targetRevision: intent.targetRevision, templateHash: desired.templateHash },
      },
      previousReplicas: null,
      desiredReplicas: null,
      noop: snapshot.templateHash === desired.templateHash,
    };
  },
  matchesDesiredState(state, observed) {
    return 'templateHash' in state.desired && 'templateHash' in observed.observed
      && state.desired.templateHash === observed.observed.templateHash;
  },
  matchesBeforeState(state, observed) {
    return 'templateHash' in state.before && 'templateHash' in observed.observed
      && state.before.templateHash === observed.observed.templateHash;
  },
  describeExpectedState(state, phase) {
    const side = phase === 'before' ? state.before : state.desired;
    if (!('templateHash' in side)) return 'valid deployment revision state';
    const revision = 'revision' in side ? side.revision : side.targetRevision;
    return `revision ${revision} template ${side.templateHash.slice(0, 12)}…`;
  },
  legacyObservedReplicas() { return null; },
});

const ADAPTERS = new Map<string, IncidentRemediationAdapterDefinition>([
  [KUBERNETES_SCALE_REMEDIATION_ADAPTER.key, KUBERNETES_SCALE_REMEDIATION_ADAPTER],
  [KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_REMEDIATION_ADAPTER.key, KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_REMEDIATION_ADAPTER],
]);

export function incidentRemediationAdapter(key: unknown): IncidentRemediationAdapterDefinition | null {
  return typeof key === 'string' ? ADAPTERS.get(key) ?? null : null;
}

export function normalizeIncidentRemediationExecutionIntent(value: unknown): IncidentRemediationExecutionIntent | null {
  const raw = object(value);
  return incidentRemediationAdapter(raw?.['adapterKey'])?.normalizeIntent(raw) ?? null;
}

export function listIncidentRemediationAdapters(): IncidentRemediationAdapterDefinition[] {
  return [...ADAPTERS.values()];
}
