import type pg from 'pg';
import type { A2aTask } from '../a2a/client.js';
import type { ExecutionResourceScopeRequest } from '../solutionPacks/executionTargets.js';
import {
  normalizeIncidentRemediationExecutionIntent,
  type IncidentRemediationExecutionIntent,
  type KubernetesScaleRemediationIntent,
} from './incidentRemediationAdapters.js';

type Queryable = Pick<pg.Pool, 'query'>;

export interface IncidentAiopsTaskRecord {
  id: number;
  incidentId: number;
  packId: string;
  agentId: string;
  taskId: string;
  rootTraceId: string | null;
  state: string;
  quality: string | null;
  summary: string | null;
  result: IncidentAiopsResult | null;
  executionContext: IncidentAiopsExecutionContext;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export type IncidentAiopsTriggerKind = 'manual' | 'native-alert' | 'provider-incident' | 'schedule' | 'api';

export interface IncidentAiopsExecutionContextInput {
  bundleIds: number[];
  resourceScope: ExecutionResourceScopeRequest | null;
  service: string | null;
  environment: string | null;
  serviceProfile?: {
    id: number;
    revision: number;
    sha256: string;
  } | null;
  trigger?: {
    kind: IncidentAiopsTriggerKind;
    ref: string | null;
  } | null;
}

export interface IncidentAiopsExecutionContext extends IncidentAiopsExecutionContextInput {
  serviceProfile: {
    id: number;
    revision: number;
    sha256: string;
  } | null;
  trigger: {
    kind: IncidentAiopsTriggerKind;
    ref: string | null;
  } | null;
  capturedAt: string;
}

export type IncidentAiopsConclusion = 'confirmed' | 'suspected' | 'inconclusive' | 'refuted';
export type IncidentAiopsConfidence = number;

export type IncidentAiopsKubernetesScaleIntent = KubernetesScaleRemediationIntent;
export type IncidentAiopsExecutionIntent = IncidentRemediationExecutionIntent;

export interface IncidentAiopsResult {
  schemaVersion: 1;
  sourceSchemaVersion: number;
  generatedAt: string | null;
  quality: 'reviewed' | 'partial' | 'failed';
  conclusion: IncidentAiopsConclusion;
  executiveAssessment: string;
  rootCause: {
    candidateRef: string | null;
    targetKind: string | null;
    targetName: string | null;
    statement: string;
    confidence: IncidentAiopsConfidence;
    rationale: string;
  } | null;
  hypotheses: Array<{
    id: string;
    statement: string;
    verdict: 'supported' | 'weakened' | 'unresolved' | 'refuted';
    confidence: IncidentAiopsConfidence;
    evidenceFor: string[];
    evidenceAgainst: string[];
  }>;
  evidence: Array<{
    lane: 'metrics' | 'logs' | 'traces' | 'runtime' | 'topology' | 'changes' | 'knowledge';
    claim: string;
    sourceRefs: string[];
  }>;
  recommendedActions: Array<{
    priority: 'now' | 'next' | 'later';
    action: string;
    rationale: string;
    requiresApproval: boolean;
    executionIntent?: IncidentAiopsExecutionIntent | null;
  }>;
}

export interface IncidentAiopsTaskSnapshot {
  rootTraceId?: string | null;
  state: string;
  quality?: string | null;
  summary?: string | null;
  result?: IncidentAiopsResult | null;
}

export interface IncidentAiopsTaskStore {
  incidentExists(incidentId: number): Promise<boolean>;
  create(input: {
    incidentId: number;
    packId: string;
    agentId: string;
    taskId: string;
    createdBy: number | null;
    snapshot: IncidentAiopsTaskSnapshot;
    executionContext?: IncidentAiopsExecutionContextInput | null;
  }): Promise<IncidentAiopsTaskRecord>;
  list(incidentId: number, limit?: number): Promise<IncidentAiopsTaskRecord[]>;
  listActive(limit?: number): Promise<IncidentAiopsTaskRecord[]>;
  update(id: number, snapshot: IncidentAiopsTaskSnapshot): Promise<IncidentAiopsTaskRecord>;
}

type IncidentAiopsTaskRow = {
  id: number | string;
  incident_id: number | string;
  pack_id: string;
  agent_id: string;
  task_id: string;
  root_trace_id: string | null;
  state: string;
  quality: string | null;
  summary: string | null;
  result_json: unknown;
  execution_bundle_ids: Array<number | string> | null;
  execution_resource_scope: ExecutionResourceScopeRequest | null;
  execution_service: string | null;
  execution_environment: string | null;
  execution_context_captured_at: Date | string;
  service_profile_id: number | string | null;
  service_profile_revision: number | string | null;
  service_profile_sha256: string | null;
  trigger_kind: IncidentAiopsTriggerKind | null;
  trigger_ref: string | null;
  created_by: number | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapRecord(row: IncidentAiopsTaskRow): IncidentAiopsTaskRecord {
  return {
    id: Number(row.id),
    incidentId: Number(row.incident_id),
    packId: row.pack_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    rootTraceId: row.root_trace_id,
    state: row.state,
    quality: row.quality,
    summary: row.summary,
    result: normalizeStoredResult(row.result_json),
    executionContext: {
      bundleIds: [...new Set((row.execution_bundle_ids ?? []).map(Number)
        .filter(value => Number.isSafeInteger(value) && value > 0))],
      resourceScope: row.execution_resource_scope ?? null,
      service: row.execution_service,
      environment: row.execution_environment,
      serviceProfile: row.service_profile_id == null || row.service_profile_revision == null || row.service_profile_sha256 == null
        ? null
        : {
            id: Number(row.service_profile_id),
            revision: Number(row.service_profile_revision),
            sha256: row.service_profile_sha256,
          },
      trigger: row.trigger_kind == null ? null : { kind: row.trigger_kind, ref: row.trigger_ref },
      capturedAt: iso(row.execution_context_captured_at),
    },
    createdBy: row.created_by == null ? null : Number(row.created_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function confidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : 0;
}

function stringList(value: unknown, limit: number, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap(item => {
    const text = boundedText(item, max);
    return text ? [text] : [];
  });
}

const CONCLUSIONS = new Set<IncidentAiopsConclusion>(['confirmed', 'suspected', 'inconclusive', 'refuted']);
const QUALITIES = new Set<IncidentAiopsResult['quality']>(['reviewed', 'partial', 'failed']);
const VERDICTS = new Set<IncidentAiopsResult['hypotheses'][number]['verdict']>(['supported', 'weakened', 'unresolved', 'refuted']);
const LANES = new Set<IncidentAiopsResult['evidence'][number]['lane']>(['metrics', 'logs', 'traces', 'runtime', 'topology', 'changes', 'knowledge']);
const PRIORITIES = new Set<IncidentAiopsResult['recommendedActions'][number]['priority']>(['now', 'next', 'later']);

function normalizedExecutionIntent(value: unknown): IncidentAiopsExecutionIntent | null {
  return normalizeIncidentRemediationExecutionIntent(value);
}

function normalizedResult(value: unknown, sourceSchemaVersion?: number, generatedAt?: string | null, quality?: string | null): IncidentAiopsResult | null {
  const raw = object(value);
  if (!raw) return null;
  const conclusion = CONCLUSIONS.has(raw['conclusion'] as IncidentAiopsConclusion)
    ? raw['conclusion'] as IncidentAiopsConclusion
    : 'inconclusive';
  const executiveAssessment = boundedText(raw['executiveAssessment'], 2_000);
  if (!executiveAssessment) return null;
  const rawRootCause = object(raw['rootCause']);
  const rootStatement = boundedText(rawRootCause?.['statement'], 1_000);
  const candidateRef = boundedText(rawRootCause?.['candidateRef'], 128);
  const rootCause = rawRootCause && rootStatement ? {
    candidateRef: candidateRef && /^argus\.core\.impact\.candidate\.[1-5]$/.test(candidateRef) ? candidateRef : null,
    targetKind: boundedText(rawRootCause['targetKind'], 120),
    targetName: boundedText(rawRootCause['targetName'], 200),
    statement: rootStatement.slice(0, 800),
    confidence: confidence(rawRootCause['confidence']),
    rationale: boundedText(rawRootCause['rationale'], 1_200) ?? 'No additional rationale was supplied.',
  } : null;
  const hypotheses = (Array.isArray(raw['hypotheses']) ? raw['hypotheses'] : []).slice(0, 6).flatMap(item => {
    const hypothesis = object(item);
    const id = boundedText(hypothesis?.['id'], 128);
    const statement = boundedText(hypothesis?.['statement'], 800);
    if (!hypothesis || !id || !statement) return [];
    const verdict = VERDICTS.has(hypothesis['verdict'] as IncidentAiopsResult['hypotheses'][number]['verdict'])
      ? hypothesis['verdict'] as IncidentAiopsResult['hypotheses'][number]['verdict']
      : 'unresolved';
    return [{
      id,
      statement,
      verdict,
      confidence: confidence(hypothesis['confidence']),
      evidenceFor: stringList(hypothesis['evidenceFor'], 3, 300),
      evidenceAgainst: stringList(hypothesis['evidenceAgainst'], 3, 300),
    }];
  });
  const evidence = (Array.isArray(raw['evidence']) ? raw['evidence'] : []).slice(0, 10).flatMap(item => {
    const entry = object(item);
    const claim = boundedText(entry?.['claim'], 800);
    if (!entry || !claim || !LANES.has(entry['lane'] as IncidentAiopsResult['evidence'][number]['lane'])) return [];
    return [{
      lane: entry['lane'] as IncidentAiopsResult['evidence'][number]['lane'],
      claim,
      sourceRefs: stringList(entry['sourceRefs'], 4, 128),
    }];
  });
  const recommendedActions = (Array.isArray(raw['recommendedActions']) ? raw['recommendedActions'] : []).slice(0, 6).flatMap(item => {
    const action = object(item);
    const actionText = boundedText(action?.['action'], 800);
    if (!action || !actionText || !PRIORITIES.has(action['priority'] as IncidentAiopsResult['recommendedActions'][number]['priority'])) return [];
    return [{
      priority: action['priority'] as IncidentAiopsResult['recommendedActions'][number]['priority'],
      action: actionText,
      rationale: boundedText(action['rationale'], 800) ?? 'No rationale was supplied.',
      requiresApproval: action['requiresApproval'] === true,
      executionIntent: normalizedExecutionIntent(action['executionIntent']),
    }];
  });
  const sourceVersion = Number.isSafeInteger(sourceSchemaVersion) && Number(sourceSchemaVersion) > 0
    ? Math.min(100, Number(sourceSchemaVersion))
    : 1;
  const generated = generatedAt && !Number.isNaN(Date.parse(generatedAt)) ? new Date(generatedAt).toISOString() : null;
  return {
    schemaVersion: 1,
    sourceSchemaVersion: sourceVersion,
    generatedAt: generated,
    quality: QUALITIES.has(quality as IncidentAiopsResult['quality']) ? quality as IncidentAiopsResult['quality'] : 'partial',
    conclusion,
    executiveAssessment,
    rootCause,
    hypotheses,
    evidence,
    recommendedActions,
  };
}

function normalizeStoredResult(value: unknown): IncidentAiopsResult | null {
  const raw = object(value);
  if (!raw || raw['schemaVersion'] !== 1) return null;
  return normalizedResult(
    raw,
    typeof raw['sourceSchemaVersion'] === 'number' ? raw['sourceSchemaVersion'] : 1,
    boundedText(raw['generatedAt'], 64),
    boundedText(raw['quality'], 32),
  );
}

export function incidentAiopsResultFromTask(task: A2aTask): IncidentAiopsResult | null {
  for (const artifact of [...(task.artifacts ?? [])].reverse()) {
    for (const part of [...artifact.parts].reverse()) {
      if (!('data' in part)) continue;
      const data = object(part.data);
      if (!data || data['kind'] !== 'aiops-investigation-evidence') continue;
      const diagnosis = object(data['diagnosis']);
      if (!diagnosis) return null;
      return normalizedResult(
        diagnosis,
        typeof data['schemaVersion'] === 'number' ? data['schemaVersion'] : 1,
        boundedText(data['generatedAt'], 64),
        boundedText(data['quality'], 32),
      );
    }
  }
  return null;
}

function boundedSummary(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 2000) : null;
}

function boundedContextText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const normalized = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function boundedMetadataText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
}

export function incidentAiopsSnapshotFromTask(
  task: A2aTask,
  rootTraceId?: string | null,
): IncidentAiopsTaskSnapshot {
  const metadata = task.metadata ?? {};
  const trace = boundedMetadataText(metadata['rootTraceId'], 128)
    ?? boundedMetadataText(metadata['argusRootTraceId'], 128)
    ?? boundedMetadataText(rootTraceId, 128);
  const quality = boundedMetadataText(metadata['quality'], 64);
  const result = incidentAiopsResultFromTask(task);
  const artifactSummary = [...(task.artifacts ?? [])].reverse().flatMap(artifact => [...artifact.parts].reverse())
    .map(part => {
      if (!('data' in part) || !part.data || typeof part.data !== 'object' || Array.isArray(part.data)) return null;
      const data = part.data as Record<string, unknown>;
      return boundedMetadataText(data['synthesis'], 2000)
        ?? boundedMetadataText(data['summary'], 2000);
    })
    .find((value): value is string => Boolean(value));
  const statusSummary = task.status.message?.parts
    .map(part => 'text' in part ? part.text : '')
    .filter(Boolean)
    .join(' ');
  return {
    state: task.status.state,
    rootTraceId: trace,
    quality: quality ?? result?.quality ?? null,
    summary: result?.executiveAssessment ?? artifactSummary ?? boundedMetadataText(statusSummary, 2000),
    result,
  };
}

export class PostgresIncidentAiopsTaskStore implements IncidentAiopsTaskStore {
  constructor(private readonly pool: Queryable) {}

  async incidentExists(incidentId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM mcp_observability_alert_incidents WHERE id=$1',
      [incidentId],
    );
    return (rowCount ?? 0) > 0;
  }

  async create(input: {
    incidentId: number;
    packId: string;
    agentId: string;
    taskId: string;
    createdBy: number | null;
    snapshot: IncidentAiopsTaskSnapshot;
    executionContext?: IncidentAiopsExecutionContextInput | null;
  }): Promise<IncidentAiopsTaskRecord> {
    const executionContext = input.executionContext ?? null;
    const bundleIds = [...new Set((executionContext?.bundleIds ?? [])
      .filter(value => Number.isSafeInteger(value) && value > 0))].slice(0, 64);
    const serviceProfile = executionContext?.serviceProfile ?? null;
    if (serviceProfile && (
      !Number.isSafeInteger(serviceProfile.id) || serviceProfile.id <= 0
      || !Number.isSafeInteger(serviceProfile.revision) || serviceProfile.revision <= 0
      || !/^[a-f0-9]{64}$/.test(serviceProfile.sha256)
    )) throw new Error('AIOps service profile execution snapshot is invalid');
    const trigger = executionContext?.trigger ?? null;
    const { rows } = await this.pool.query<IncidentAiopsTaskRow>(
      `INSERT INTO mcp_observability_incident_aiops_tasks
        (incident_id, pack_id, agent_id, task_id, root_trace_id, state, quality, summary, result_json, created_by,
         execution_bundle_ids, execution_resource_scope, execution_service, execution_environment,
         service_profile_id, service_profile_revision, service_profile_sha256, trigger_kind, trigger_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (incident_id, pack_id, task_id) DO UPDATE SET
         root_trace_id=COALESCE(EXCLUDED.root_trace_id, mcp_observability_incident_aiops_tasks.root_trace_id),
         state=EXCLUDED.state,
         quality=COALESCE(EXCLUDED.quality, mcp_observability_incident_aiops_tasks.quality),
         summary=COALESCE(EXCLUDED.summary, mcp_observability_incident_aiops_tasks.summary),
         result_json=COALESCE(EXCLUDED.result_json, mcp_observability_incident_aiops_tasks.result_json),
         updated_at=now()
       RETURNING *`,
      [
        input.incidentId,
        input.packId,
        input.agentId,
        input.taskId,
        input.snapshot.rootTraceId ?? null,
        input.snapshot.state,
        input.snapshot.quality ?? null,
        boundedSummary(input.snapshot.summary),
        input.snapshot.result ?? null,
        input.createdBy,
        bundleIds,
        executionContext?.resourceScope ? JSON.stringify(executionContext.resourceScope) : null,
        boundedContextText(executionContext?.service, 200),
        boundedContextText(executionContext?.environment, 120),
        serviceProfile?.id ?? null,
        serviceProfile?.revision ?? null,
        serviceProfile?.sha256 ?? null,
        trigger?.kind ?? null,
        boundedContextText(trigger?.ref, 256),
      ],
    );
    return mapRecord(rows[0]!);
  }

  async list(incidentId: number, limit = 10): Promise<IncidentAiopsTaskRecord[]> {
    const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const { rows } = await this.pool.query<IncidentAiopsTaskRow>(
      `SELECT * FROM mcp_observability_incident_aiops_tasks
        WHERE incident_id=$1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [incidentId, boundedLimit],
    );
    return rows.map(mapRecord);
  }

  async listActive(limit = 100): Promise<IncidentAiopsTaskRecord[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const { rows } = await this.pool.query<IncidentAiopsTaskRow>(
      `SELECT * FROM mcp_observability_incident_aiops_tasks
        WHERE state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED')
        ORDER BY updated_at ASC, id ASC
        LIMIT $1`,
      [boundedLimit],
    );
    return rows.map(mapRecord);
  }

  async update(id: number, snapshot: IncidentAiopsTaskSnapshot): Promise<IncidentAiopsTaskRecord> {
    const { rows } = await this.pool.query<IncidentAiopsTaskRow>(
      `UPDATE mcp_observability_incident_aiops_tasks SET
         root_trace_id=COALESCE($2, root_trace_id),
         state=$3,
         quality=COALESCE($4, quality),
         summary=COALESCE($5, summary),
         result_json=COALESCE($6, result_json),
         updated_at=now()
       WHERE id=$1
       RETURNING *`,
      [id, snapshot.rootTraceId ?? null, snapshot.state, snapshot.quality ?? null, boundedSummary(snapshot.summary), snapshot.result ?? null],
    );
    if (!rows[0]) throw new Error(`AIOps incident link ${id} not found`);
    return mapRecord(rows[0]);
  }
}
