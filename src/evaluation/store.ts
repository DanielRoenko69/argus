import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import { getTelemetryTrace } from '../observability/telemetryStore.js';
import type { AuthorizedWorkspaceScope } from '../auth/workspaceScope.js';
import { evaluationDigest, evaluationRulesSchema, EvaluationError, type EvaluationRules } from './contracts.js';
import { assertGlobalCatalogScope, missingReference, type EvaluationContext } from './context.js';
import { assertEvaluationAgent, boundedEvaluationJson, freezeEvaluationConfiguration } from './snapshots.js';
import { withPromptRevision } from './promptRevisions.js';
import { withSkillRevision } from './skillRevisions.js';

export type EvaluationDatasetStatus = 'draft' | 'active' | 'archived';

export interface EvaluationDataset {
  tenant_key: string;
  workspace_key: string;
  contract_version: number;
  id: number;
  dataset_key: string;
  version: number;
  name: string;
  description: string;
  bundle_ids: number[];
  agent_id: number | null;
  status: EvaluationDatasetStatus;
  case_count: number;
  content_sha256: string | null;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface EvaluationCase {
  rules: EvaluationRules | null;
  id: number;
  dataset_id: number;
  case_key: string;
  input_redacted: unknown;
  expected_output: unknown;
  context_redacted: unknown;
  source_trace_id: string | null;
  source_span_id: string | null;
  input_sha256: string;
  metadata: Record<string, unknown>;
  created_by_user_id: number | null;
  created_at: string;
}

export interface CreateDatasetInput {
  datasetKey: string;
  version: number;
  name: string;
  description?: string;
  bundleIds?: number[];
  agentId?: number | null;
}

export interface CreateCaseInput {
  rules: EvaluationRules;
  caseKey: string;
  input: unknown;
  expectedOutput?: unknown;
  context?: unknown;
  sourceTraceId?: string | null;
  sourceSpanId?: string | null;
  metadata?: Record<string, unknown>;
}

export type EvaluationExperimentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface EvaluationAttempt {
  case_id: number;
  attempt: number;
  trace_id: string | null;
  started_at: string;
}

export interface EvaluationExperiment {
  comparison_id?:number|null;
  comparison_status?:EvaluationExperimentStatus|null;
  tenant_key: string;
  workspace_key: string;
  evidence_kind: 'legacy_smoke' | 'frozen_v1';
  dataset_sha256: string | null;
  expected_cases: Array<{ id: number; case_key: string; sha256: string }> | null;
  configuration_snapshot: Record<string, unknown> | null;
  configuration_sha256: string | null;
  evaluator_sha256: string | null;
  id: number;
  dataset_id: number;
  dataset_key?: string;
  dataset_version?: number;
  dataset_agent_id?: number | null;
  agent_id: number | null;
  model_ref: string;
  credential_ref: string | null;
  evaluator_config: Record<string, unknown>;
  baseline_experiment_id: number | null;
  status: EvaluationExperimentStatus;
  started_at: string | null;
  completed_at: string | null;
  created_by_user_id: number | null;
  created_at: string;
}

export interface EvaluationResult {
  evidence?: Record<string, unknown> | null;
  id: number;
  experiment_id: number;
  case_id: number;
  attempt: number;
  trace_id: string | null;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  output_redacted: unknown;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  scores: Record<string, number>;
  evaluator_version: string | null;
  error_message: string | null;
  created_at: string;
}

export interface CreateExperimentInput {
  promptRevisionId?: number;
  skillRevisionId?: number;
  datasetId: number;
  agentId?: number | null;
  modelRef: string;
  credentialRef?: string | null;
  evaluatorConfig?: Record<string, unknown>;
  baselineExperimentId?: number | null;
}


type Db = Pick<pg.Pool, 'query'>;
const scopeValues = (scope: AuthorizedWorkspaceScope) => [scope.tenantKey, scope.workspaceKey];
function normalize<T>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const key of ['id','dataset_id','agent_id','dataset_agent_id','experiment_id','case_id','baseline_experiment_id','comparison_id']) {
    if (out[key] != null) out[key] = Number(out[key]);
  }
  return out as T;
}
export function evaluationCaseContent(c: EvaluationCase) {
  return { case_key: c.case_key, input: c.input_redacted, expected_output: c.expected_output,
    context: c.context_redacted, rules: c.rules, metadata: c.metadata };
}
export function datasetContentDigest(cases: EvaluationCase[]): string {
  return evaluationDigest([...cases].sort((a,b) => a.case_key < b.case_key ? -1 : a.case_key > b.case_key ? 1 : 0).map(evaluationCaseContent));
}
export async function mutate<T extends { id: number }>(
  pool: pg.Pool, context: EvaluationContext, action: string, binding: unknown,
  execute: (client: pg.PoolClient) => Promise<T>, reload: (id: number) => Promise<T | null>,
): Promise<T> {
  const fingerprint = evaluationDigest(binding);
  const outcome = await executeCanonicalAuditedMutation(pool,
    { name: `evaluation.${action}`, eventId: evaluationDigest({ actor:context.user.id,key:context.requestId || randomUUID() }) },
    context, execute,
    row => ({ environment: context.environment, tenantKey: context.tenantKey, workspaceKey: context.workspaceKey, solution: 'argus.core',
      actor: { type: 'human', id: String(context.user.id), authMethod: context.user.auth_method ?? 'local',
        ssoSubject: context.user.auth_method === 'oidc' ? context.user.username : null, effectiveRoles: [context.user.role] },
      action: `evaluation.${action}`, outcome: 'success', risk: action.startsWith('release') || action.includes('.release') ? 'high' : 'medium',
      resource: { type: action.startsWith('skill.release') ? 'agent_skill_release' : action.startsWith('skill.revision') ? 'skill_revision' : action.startsWith('prompt.release') ? 'agent_prompt_release' : action.startsWith('prompt.revision') ? 'agent_prompt_revision' : action.startsWith('release') ? 'evaluation_execution_release' : action.startsWith('review') ? 'quality_review' : action.startsWith('comparison') ? 'evaluation_comparison' : action.startsWith('dataset') ? 'evaluation_dataset' : action.startsWith('case') ? 'evaluation_case' : action.startsWith('result') ? 'evaluation_result' : 'evaluation_experiment', id: String(row.id), revision:fingerprint },
      correlation: { requestId: context.requestId || fingerprint,
        traceId:typeof (row as Record<string,unknown>)['trace_id'] === 'string' ? (row as Record<string,unknown>)['trace_id'] as string : undefined },
      payload: { context: { request_sha256: fingerprint,...(action.startsWith('release') || action.includes('.release') ? {
        comparison_id:(row as Record<string,unknown>)['comparison_id'],agent_id:(row as Record<string,unknown>)['agent_id'],
        evidence_sha256:(row as Record<string,unknown>)['evidence_sha256'],source_release_id:(row as Record<string,unknown>)['source_release_id'],
        mfa_verified_at:context.user.mfa_verified_at,mfa_method:context.user.mfa_method,
      } : {}) }, after: { id: row.id, digest: evaluationDigest(row) } },
    }));
  if (outcome.replayed && outcome.event.resource.revision !== fingerprint) {
    throw new EvaluationError('EVALUATION_IDEMPOTENCY_CONFLICT','Idempotency-Key was already used for a different request',409);
  }
  const result = outcome.result ?? await reload(Number(outcome.event.resource.id));
  if (!result) missingReference();
  return normalize(result);
}
export async function listEvaluationDatasets(pool: Db,scope: AuthorizedWorkspaceScope,status?: EvaluationDatasetStatus): Promise<EvaluationDataset[]> {
  return (await pool.query<EvaluationDataset>(`SELECT * FROM mcp_evaluation_datasets
    WHERE tenant_key=$1 AND workspace_key=$2 AND ($3::text IS NULL OR status=$3)
    ORDER BY updated_at DESC,id DESC LIMIT 200`,[...scopeValues(scope),status ?? null])).rows.map(normalize);
}
export async function getEvaluationDataset(pool: Db,id: number,scope: AuthorizedWorkspaceScope) {
  const dataset = (await pool.query<EvaluationDataset>(`SELECT * FROM mcp_evaluation_datasets
    WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3`,[id,...scopeValues(scope)])).rows[0];
  if (!dataset) return null;
  const cases = (await pool.query<EvaluationCase>('SELECT * FROM mcp_evaluation_cases WHERE dataset_id=$1 ORDER BY case_key',[id])).rows;
  return { dataset:normalize(dataset),cases:cases.map(normalize) };
}
export async function lockDataset(client: pg.PoolClient,id: number,scope: AuthorizedWorkspaceScope): Promise<EvaluationDataset> {
  const row = (await client.query<EvaluationDataset>(`SELECT * FROM mcp_evaluation_datasets
    WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3 FOR UPDATE`,[id,...scopeValues(scope)])).rows[0];
  if (!row) missingReference();
  return normalize(row);
}
export function requireDraft(dataset: EvaluationDataset): void {
  if (dataset.status!=='draft') throw new EvaluationError('EVALUATION_DATASET_IMMUTABLE','Create a new dataset version to change frozen cases',409);
  if (dataset.contract_version!==1) throw new EvaluationError('EVALUATION_LEGACY_SMOKE','Create a new dataset version with explicit assertion rules',409);
}
export async function createEvaluationDataset(pool: pg.Pool,input: CreateDatasetInput,context: EvaluationContext) {
  return mutate(pool,context,'dataset.created',input,async client => {
    if (input.agentId != null) await assertEvaluationAgent(client,input.agentId,context);
    const bundleIds = [...new Set(input.bundleIds ?? [])];
    if (bundleIds.length) {
      assertGlobalCatalogScope(context);
      if (context.user.allowed_bundles && bundleIds.some(id => !context.user.allowed_bundles!.includes(id))) missingReference();
      const found = await client.query('SELECT id FROM mcp_service_bundles WHERE id=ANY($1::int[]) FOR SHARE',[bundleIds]);
      if (found.rows.length!==bundleIds.length) missingReference();
    }
    return (await client.query<EvaluationDataset>(`INSERT INTO mcp_evaluation_datasets
      (dataset_key,version,name,description,bundle_ids,agent_id,created_by_user_id,tenant_key,workspace_key,contract_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1) RETURNING *`,
    [input.datasetKey,input.version,input.name,input.description ?? '',bundleIds,input.agentId ?? null,context.user.id,...scopeValues(context)])).rows[0]!;
  },async id => (await getEvaluationDataset(pool,id,context))?.dataset ?? null);
}
export async function createEvaluationCase(pool: pg.Pool,datasetId: number,input: CreateCaseInput,context: EvaluationContext) {
  const data=prepareEvaluationCase(input);
  return mutate(pool,context,'case.created',{ datasetId,caseKey:input.caseKey,...data,trace:input.sourceTraceId,span:input.sourceSpanId },
    client => insertEvaluationCase(client,datasetId,input,context),
    async id => (await getEvaluationDataset(pool,datasetId,context))?.cases.find(c => c.id===id) ?? null);
}

function prepareEvaluationCase(input:CreateCaseInput) {
  const rules = evaluationRulesSchema.parse(boundedEvaluationJson(input.rules,16384,'rules'));
  if (input.input===undefined) throw new EvaluationError('EVALUATION_INVALID','input is required');
  const data = { input:boundedEvaluationJson(input.input,32768,'input'), expected:boundedEvaluationJson(input.expectedOutput,32768,'expected output'),
    context:boundedEvaluationJson(input.context ?? {},65536,'context'), metadata:boundedEvaluationJson(input.metadata ?? {},16384,'metadata'), rules };
  return data;
}
/** Transaction-owned helper; callers must commit a canonical event with the case(s). */
export async function insertEvaluationCase(client: pg.PoolClient,datasetId: number,input: CreateCaseInput,context: EvaluationContext) {
  const data=prepareEvaluationCase(input),rules=data.rules;
    const dataset = await lockDataset(client,datasetId,context);
    requireDraft(dataset);
    if (dataset.case_count>=200) throw new EvaluationError('EVALUATION_CASE_LIMIT','V1 datasets support up to 200 cases',409);
    if (input.sourceSpanId && !input.sourceTraceId) missingReference();
    if (input.sourceTraceId) {
      const evidence = await getTelemetryTrace(client as unknown as pg.Pool,input.sourceTraceId,
        { userId:context.user.id,observeAll:true,allowedBundleIds:context.user.allowed_bundles,...context });
      if (!evidence || evidence.trace.id!==input.sourceTraceId || (input.sourceSpanId && !evidence.spans.some(s => s.id===input.sourceSpanId))) missingReference();
    }
    return (await client.query<EvaluationCase>(`INSERT INTO mcp_evaluation_cases
      (dataset_id,case_key,input_redacted,expected_output,context_redacted,source_trace_id,source_span_id,input_sha256,metadata,rules,created_by_user_id)
      VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,$11) RETURNING *`,
    [datasetId,input.caseKey,JSON.stringify(data.input),JSON.stringify(data.expected),JSON.stringify(data.context),input.sourceTraceId ?? null,input.sourceSpanId ?? null,
      evaluationDigest(data.input),JSON.stringify(data.metadata),JSON.stringify(rules),context.user.id])).rows[0]!;
}
export async function activateEvaluationDataset(pool: pg.Pool,id: number,context: EvaluationContext) {
  return mutate(pool,context,'dataset.activated',{ id },async client => {
    const dataset = await lockDataset(client,id,context);
    requireDraft(dataset);
    const record = await getEvaluationDataset(client,id,context);
    if (!record?.cases.length) throw new EvaluationError('EVALUATION_EMPTY_DATASET','Add at least one case before activation',409);
    for (const c of record.cases) evaluationRulesSchema.parse(c.rules);
    return (await client.query<EvaluationDataset>(`UPDATE mcp_evaluation_datasets SET status='active',content_sha256=$2,
      case_count=$3,updated_at=now() WHERE id=$1 RETURNING *`,[id,datasetContentDigest(record.cases),record.cases.length])).rows[0]!;
  },async resourceId => (await getEvaluationDataset(pool,resourceId,context))?.dataset ?? null);
}
export async function createEvaluationExperiment(pool: pg.Pool,input: CreateExperimentInput,context: EvaluationContext) {
  return mutate(pool,context,'experiment.created',input,client => insertFrozenEvaluationExperiment(client,input,context),
    async id => (await getEvaluationExperiment(pool,id,context))?.experiment ?? null);
}

/** Transaction-owned helper: callers must commit a canonical audit with these rows. */
export async function insertFrozenEvaluationExperiment(client: pg.PoolClient,input: CreateExperimentInput,context: EvaluationContext) {
    const dataset = await lockDataset(client,input.datasetId,context);
    if (dataset.status!=='active' || dataset.contract_version!==1 || !dataset.content_sha256) {
      throw new EvaluationError('EVALUATION_DATASET_NOT_FROZEN','Select an active V1 dataset with a content digest',409);
    }
    const cases = (await getEvaluationDataset(client,dataset.id,context))!.cases;
    if (datasetContentDigest(cases)!==dataset.content_sha256) throw new EvaluationError('EVALUATION_DIGEST_MISMATCH','Dataset digest verification failed',409);
    const agentId = input.agentId ?? dataset.agent_id;
    if (!agentId) throw new EvaluationError('EVALUATION_AGENT_REQUIRED','Select an Agent');
    const live = await freezeEvaluationConfiguration(client,agentId,input.modelRef,input.credentialRef ?? null,context);
    if (input.promptRevisionId && input.skillRevisionId) throw new EvaluationError('EVALUATION_INVALID','Compare one revision family at a time');
    const configuration = input.promptRevisionId ? await withPromptRevision(client,live,input.promptRevisionId,context)
      : input.skillRevisionId ? await withSkillRevision(client,live,input.skillRevisionId,context) : live;
    const evaluator = { version:'argus.deterministic.v1',config:input.evaluatorConfig ?? {},
      cases:cases.map(c => ({ case_key:c.case_key,rules:c.rules })) };
    const evaluatorHash = evaluationDigest(evaluator);
    if (input.baselineExperimentId) {
      const baseline = await getEvaluationExperiment(client,input.baselineExperimentId,context);
      if (!baseline) missingReference();
      if (baseline.experiment.evidence_kind!=='frozen_v1' || baseline.experiment.dataset_sha256!==dataset.content_sha256
          || baseline.experiment.dataset_id!==dataset.id || baseline.experiment.evaluator_sha256!==evaluatorHash) {
        throw new EvaluationError('EVALUATION_BASELINE_INCOMPATIBLE','Baseline must use the same frozen dataset and evaluators',409);
      }
    }
    const expectedCases = cases.map(c => ({ id:c.id,case_key:c.case_key,sha256:evaluationDigest(evaluationCaseContent(c)) }));
    const snapshot = { ...configuration,evaluator,baseline_experiment_id:input.baselineExperimentId ?? null };
    const execution = configuration['execution'] as Record<string,unknown>;
    return (await client.query<EvaluationExperiment>(`INSERT INTO mcp_evaluation_experiments
      (dataset_id,agent_id,model_ref,credential_ref,evaluator_config,baseline_experiment_id,created_by_user_id,
       tenant_key,workspace_key,evidence_kind,dataset_sha256,expected_cases,configuration_snapshot,configuration_sha256,evaluator_sha256)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'frozen_v1',$10,$11::jsonb,$12::jsonb,$13,$14) RETURNING *`,
    [dataset.id,agentId,input.modelRef,execution['credential_ref'],JSON.stringify(input.evaluatorConfig ?? {}),input.baselineExperimentId ?? null,context.user.id,
      ...scopeValues(context),dataset.content_sha256,JSON.stringify(expectedCases),JSON.stringify(snapshot),evaluationDigest(snapshot),evaluatorHash])).rows[0]!;
}

/** Repetitions reuse the original configuration, never resample mutable Agent settings. */
export async function cloneFrozenEvaluationExperiment(client: pg.PoolClient,source: EvaluationExperiment,baselineId: number | null,context: EvaluationContext) {
  const snapshot={ ...source.configuration_snapshot,baseline_experiment_id:baselineId };
  return normalize((await client.query<EvaluationExperiment>(`INSERT INTO mcp_evaluation_experiments
    (dataset_id,agent_id,model_ref,credential_ref,evaluator_config,baseline_experiment_id,created_by_user_id,
     tenant_key,workspace_key,evidence_kind,dataset_sha256,expected_cases,configuration_snapshot,configuration_sha256,evaluator_sha256)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'frozen_v1',$10,$11::jsonb,$12::jsonb,$13,$14) RETURNING *`,
  [source.dataset_id,source.agent_id,source.model_ref,source.credential_ref,JSON.stringify(source.evaluator_config),baselineId,context.user.id,
    ...scopeValues(context),source.dataset_sha256,JSON.stringify(source.expected_cases),JSON.stringify(snapshot),evaluationDigest(snapshot),source.evaluator_sha256])).rows[0]!);
}
export async function getEvaluationExperiment(pool: Db,id: number,scope: AuthorizedWorkspaceScope) {
  const experiment = (await pool.query<EvaluationExperiment>(`SELECT e.*,d.dataset_key,d.version AS dataset_version,d.agent_id AS dataset_agent_id,s.comparison_id,c.status AS comparison_status
    FROM mcp_evaluation_experiments e JOIN mcp_evaluation_datasets d ON d.id=e.dataset_id
    LEFT JOIN mcp_evaluation_comparison_steps s ON s.experiment_id=e.id LEFT JOIN mcp_evaluation_comparisons c ON c.id=s.comparison_id
    WHERE e.id=$1 AND e.tenant_key=$2 AND e.workspace_key=$3 AND d.tenant_key=$2 AND d.workspace_key=$3`,[id,...scopeValues(scope)])).rows[0];
  if (!experiment) return null;
  const results = (await pool.query<EvaluationResult>('SELECT * FROM mcp_evaluation_results WHERE experiment_id=$1 ORDER BY id',[id])).rows;
  const attempts = (await pool.query<EvaluationAttempt>('SELECT case_id,attempt,trace_id,started_at FROM mcp_evaluation_attempts WHERE experiment_id=$1 ORDER BY case_id,attempt',[id])).rows;
  const worker = (await pool.query<{ cancel_requested: boolean; leased_until: string }>('SELECT cancel_requested,leased_until FROM mcp_evaluation_workers WHERE experiment_id=$1',[id])).rows[0];
  return { experiment:normalize(experiment),results:results.map(normalize),attempts:attempts.map(normalize),
    cancellation_requested:worker?.cancel_requested ?? false,lease_expires_at:worker?.leased_until ?? null };
}
export async function listEvaluationExperiments(pool: Db,scope: AuthorizedWorkspaceScope,status?: EvaluationExperimentStatus): Promise<EvaluationExperiment[]> {
  return (await pool.query<EvaluationExperiment>(`SELECT e.*,d.dataset_key,d.version AS dataset_version,d.agent_id AS dataset_agent_id,s.comparison_id,c.status AS comparison_status
    FROM mcp_evaluation_experiments e JOIN mcp_evaluation_datasets d ON d.id=e.dataset_id
    LEFT JOIN mcp_evaluation_comparison_steps s ON s.experiment_id=e.id LEFT JOIN mcp_evaluation_comparisons c ON c.id=s.comparison_id
    WHERE e.tenant_key=$1 AND e.workspace_key=$2 AND d.tenant_key=$1 AND d.workspace_key=$2
      AND ($3::text IS NULL OR e.status=$3) ORDER BY e.created_at DESC,e.id DESC LIMIT 200`,[...scopeValues(scope),status ?? null])).rows.map(normalize);
}
