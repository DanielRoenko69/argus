import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Config } from '../config/env.js';
import { resolveRegisteredLlmTarget } from '../llm/modelRegistry.js';
import { logger } from '../lib/logger.js';
import { evaluationReadiness, evaluationDigest, evaluationRulesSchema, EvaluationError } from './contracts.js';
import { missingReference, type EvaluationContext } from './context.js';
import { assertEvaluationAgent, evaluationTargetDigest } from './snapshots.js';
import { getPromptRevision } from './promptRevisions.js';
import { agentSkillHead,getSkillRevision } from './skillRevisions.js';
import { rawHead } from './releases.js';
import { buildEvaluationRequest, executeNativeEvaluationCase } from './nativeExecutor.js';
import { getAgentRuntimeAssignment } from '../agents/runtimeProfiles.js';
import { codexEvaluationAvailable,codexProfileSupported,codexRuntimeDigest,codexEvaluationTarget,buildCodexEvaluationRequest,executeCodexEvaluationCase } from './codexExecutor.js';
import { EVALUATOR_VERSION } from './scoring.js';
import { assertEvaluationCaller, evaluationProgress, lockEvaluationWorker, monitorEvaluationWorker, EVALUATION_LEASE_SECONDS } from './lifecycle.js';
import { retryEvaluationSchema } from './contracts.js';
import { authorizeComparisonChild, type ComparisonClaim } from './comparisonStore.js';
import { getEvaluationExperiment, getEvaluationDataset, datasetContentDigest, evaluationCaseContent, mutate,
  type EvaluationExperiment, type EvaluationCase, type EvaluationResult } from './store.js';

async function targetForCase(client: pg.PoolClient, experiment: EvaluationExperiment, context: EvaluationContext) {
  if (!experiment.agent_id) missingReference();
  const agent = await assertEvaluationAgent(client, experiment.agent_id, context);
  const skill=experiment.configuration_snapshot!['skill_revision'] as { id:number;content_sha256:string;source_head_sha256:string }|undefined;
  if (skill) {
    const revision=await getSkillRevision(client,skill.id,agent.id,context);
    if (revision.content_sha256!==skill.content_sha256 || await agentSkillHead(client,agent.id)!==skill.source_head_sha256) {
      throw new EvaluationError('EVALUATION_SKILL_STALE','Agent or Skill pins changed; create a fresh comparison.',409);
    }
  }
  const prompt=experiment.configuration_snapshot!['prompt_revision'] as { id:number;content_sha256:string }|undefined;
  if (prompt) {
    const revision=await getPromptRevision(client,prompt.id,context);
    if (revision.agent_id!==agent.id || revision.content_sha256!==prompt.content_sha256
      || revision.source_head_sha256!==await rawHead(client,agent.id)) {
      throw new EvaluationError('EVALUATION_PROMPT_STALE','Prompt draft source changed; create a new draft and comparison.',409);
    }
  }
  const execution = experiment.configuration_snapshot!['execution'] as Record<string,unknown>;
  if ((agent.runtime_profile_id ?? null) !== execution['profile_id']) {
    throw new EvaluationError('EVALUATION_CONFIGURATION_DRIFT','Agent runtime assignment changed; create a new snapshot',409);
  }
  if (execution['type']==='codex') {
    await client.query('SELECT id FROM mcp_agent_runtime_profiles WHERE id=$1 FOR SHARE',[agent.runtime_profile_id]);
    const runtime=await getAgentRuntimeAssignment(client as unknown as pg.Pool,agent.id);
    if (!codexProfileSupported(runtime) || codexRuntimeDigest(runtime!)!==execution['runtime_configuration_sha256']) {
      throw new EvaluationError('EVALUATION_CONFIGURATION_DRIFT','Codex runtime configuration changed; create a new snapshot',409);
    }
    const target=codexEvaluationTarget(runtime!.model!);
    if (evaluationTargetDigest(target)!==execution['target_sha256'] || !await codexEvaluationAvailable()) {
      throw new EvaluationError('EVALUATION_CODEX_UNAVAILABLE','The frozen isolated Codex target is unavailable; no API fallback',409);
    }
    return target;
  }
  if (agent.runtime_profile_id) {
    const profile = (await client.query('SELECT runtime_type,enabled FROM mcp_agent_runtime_profiles WHERE id=$1 FOR SHARE',[agent.runtime_profile_id])).rows[0];
    if (!profile?.enabled || profile.runtime_type !== 'argus') missingReference();
  }
  const models = (await client.query(`SELECT m.id,p.credential_profile_id FROM mcp_models m JOIN mcp_llm_providers p ON p.id=m.provider_id
    WHERE m.model_name=$1 AND m.enabled AND p.enabled FOR SHARE OF m,p`,[experiment.model_ref])).rows;
  if (models.length !== 1 || models[0].id !== (execution['model_catalog'] as Record<string,unknown>)['id']) missingReference();
  const profileId = agent.llm_credential_profile_id ?? models[0].credential_profile_id ?? null;
  if (agent.llm_api_key || (profileId ? 'profile:'+profileId : null) !== execution['credential_ref']) missingReference();
  // Model row is locked and absence must never fall back to environment routing.
  const target = await resolveRegisteredLlmTarget(client as unknown as pg.Pool,experiment.model_ref,null,profileId,true);
  if (target.runtimeType || evaluationTargetDigest(target) !== execution['target_sha256']) {
    throw new EvaluationError('EVALUATION_CONFIGURATION_DRIFT','Provider routing changed; create a new snapshot',409);
  }
  return target;
}

function verifyCases(experiment: EvaluationExperiment, cases: EvaluationCase[]) {
  if (!experiment.configuration_snapshot || evaluationDigest(experiment.configuration_snapshot) !== experiment.configuration_sha256
      || evaluationDigest(experiment.configuration_snapshot['evaluator']) !== experiment.evaluator_sha256
      || datasetContentDigest(cases) !== experiment.dataset_sha256
      || evaluationDigest(cases.map(c => ({ id:c.id,case_key:c.case_key,sha256:evaluationDigest(evaluationCaseContent(c)) }))) !== evaluationDigest(experiment.expected_cases)) {
    throw new EvaluationError('EVALUATION_DIGEST_MISMATCH','Frozen evaluation content verification failed',409);
  }
  for (const c of cases) evaluationRulesSchema.parse(c.rules);
}

/** Read-only preflight, usable by the paired controller before it authorizes any spend. */
export async function preflightEvaluationExperiment(client:pg.PoolClient,e:EvaluationExperiment,context:EvaluationContext) {
  const ready=evaluationReadiness(e.evidence_kind,e.configuration_snapshot,'queued');
  if (!ready.startable) throw new EvaluationError(ready.code,ready.reason,409);
  const dataset=await getEvaluationDataset(client,e.dataset_id,context);
  if (!dataset || dataset.dataset.status!=='active') missingReference();
  verifyCases(e,dataset.cases);
  const target=await targetForCase(client,e,context);
  for (const c of dataset.cases) target.runtimeType==='codex-subscription'
    ? buildCodexEvaluationRequest(e.configuration_snapshot!,c) : buildEvaluationRequest(e.configuration_snapshot!,c,target);
  return dataset.cases;
}

/** Atomic audited claim before scheduling. A replay can never start another worker. */
export async function executeEvaluationExperiment(pool: pg.Pool, _config: Config, experimentId: number, context: EvaluationContext) {
  return startEvaluation(pool,experimentId,context);
}

/** Only the comparison coordinator supplies its private lease token. Never exposed over HTTP. */
export async function executeComparisonChild(pool:pg.Pool,experimentId:number,context:EvaluationContext,claim:ComparisonClaim) {
  return startEvaluation(pool,experimentId,context,undefined,claim);
}

export async function retryEvaluationExperiment(pool: pg.Pool, experimentId: number, input: unknown, context: EvaluationContext) {
  const retry=retryEvaluationSchema.parse(input);
  if (!context.requestId) throw new EvaluationError('EVALUATION_IDEMPOTENCY_REQUIRED','Retry requires an Idempotency-Key',400);
  return startEvaluation(pool,experimentId,context,[...new Set(retry.case_ids)].sort((a,b) => a-b));
}

async function startEvaluation(pool: pg.Pool, experimentId: number, context: EvaluationContext, retryCaseIds?: number[],comparison?:ComparisonClaim) {
  assertEvaluationCaller(context);
  let claimed = false;
  let cases: EvaluationCase[] = [];
  const token=randomUUID();
  const experiment = await mutate(pool,context,retryCaseIds ? 'experiment.retried' : 'experiment.started',{ experimentId,caseIds:retryCaseIds ?? null },async client => {
    await authorizeComparisonChild(client,experimentId,context,!!retryCaseIds,comparison);
    await client.query('SELECT id FROM mcp_evaluation_experiments WHERE id=$1 FOR UPDATE',[experimentId]);
    const record = await getEvaluationExperiment(client,experimentId,context);
    if (!record) missingReference();
    const e = record.experiment;
    const ready = evaluationReadiness(e.evidence_kind,e.configuration_snapshot,retryCaseIds ? 'queued' : e.status);
    if (!ready.startable) throw new EvaluationError(ready.code,ready.reason,409);
    if (retryCaseIds) {
      const eligible = evaluationProgress(record).retryable_case_ids;
      if (retryCaseIds.some(id => !eligible.includes(id))) throw new EvaluationError('EVALUATION_RETRY_NOT_ELIGIBLE','Select only unfinished or technically failed cases from a stopped run',409);
    }
    cases = await preflightEvaluationExperiment(client,e,context);
    if (retryCaseIds) cases=cases.filter(c => retryCaseIds.includes(c.id));
    await client.query(`INSERT INTO mcp_evaluation_workers (experiment_id,token,environment,leased_until,comparison_id,comparison_token)
      VALUES ($1,$2,$3,clock_timestamp()+($4::int*interval '1 second'),$5,$6) ON CONFLICT (experiment_id) DO UPDATE
      SET token=EXCLUDED.token,environment=EXCLUDED.environment,leased_until=EXCLUDED.leased_until,cancel_requested=false,
        comparison_id=EXCLUDED.comparison_id,comparison_token=EXCLUDED.comparison_token`,
    [experimentId,token,context.environment,EVALUATION_LEASE_SECONDS,comparison?.id ?? null,comparison?.token ?? null]);
    const row = (await client.query<EvaluationExperiment>(
      "UPDATE mcp_evaluation_experiments SET status='running',started_at=COALESCE(started_at,now()),completed_at=NULL WHERE id=$1 RETURNING *",[experimentId])).rows[0];
    if (!row) throw new EvaluationError('EVALUATION_ALREADY_STARTED','Experiment already claimed',409);
    claimed = true;
    return { ...row,comparison_id:e.comparison_id,comparison_status:e.comparison_status };
  },async id => (await getEvaluationExperiment(pool,id,context))?.experiment ?? null);
  const completion = claimed ? runClaimedEvaluation(pool,experiment,cases,context,token) : Promise.resolve();
  // Recovery marks expired workers interrupted, without issuing another request.
  void completion.catch(() => logger.error({ experimentId,code:'EVALUATION_EXECUTION_INTERRUPTED' },'Evaluation interrupted; inspect persisted evidence before retrying'));
  return { experiment_id:experiment.id,status:experiment.status,completion };
}

async function runClaimedEvaluation(pool: pg.Pool, experiment: EvaluationExperiment, cases: EvaluationCase[], context: EvaluationContext, token: string) {
  const monitor=monitorEvaluationWorker(pool,experiment.id,token);
  const stageContext = (key: string) => ({ ...context,requestId:`evaluation:${experiment.id}:${token}:${key}` });
  try {
  for (const c of cases) {
    const traceId = randomUUID();
    let attempt=1;
    let target: Awaited<ReturnType<typeof targetForCase>> | undefined;
    try {
    await mutate(pool,stageContext('case:'+c.id+':start'),'case.started',{ experimentId:experiment.id,caseId:c.id },async client => {
      const worker=await lockEvaluationWorker(client,experiment.id,token);
      if (worker.cancel_requested) throw new EvaluationError('EVALUATION_CANCEL_REQUESTED','Cancellation requested',409);
      monitor.signal.throwIfAborted();
      target = await targetForCase(client,experiment,context);
      attempt=Number((await client.query(`SELECT COALESCE(max(attempt),0)+1 AS next FROM (
        SELECT attempt FROM mcp_evaluation_attempts WHERE experiment_id=$1 AND case_id=$2
        UNION ALL SELECT attempt FROM mcp_evaluation_results WHERE experiment_id=$1 AND case_id=$2) a`,[experiment.id,c.id])).rows[0].next);
      await client.query(`INSERT INTO mcp_observability_traces
        (id,root_trace_id,name,kind,status,user_id,agent_id,model,provider,started_at,metadata)
        VALUES ($1,$1,$2,'evaluation','running',$3,$4,$5,$6,now(),$7::jsonb)`,
      [traceId,'Evaluation case #'+c.id,context.user.id,experiment.agent_id,target.model,target.provider,
        JSON.stringify({ tenantKey:context.tenantKey,workspaceKey:context.workspaceKey,evaluationExperimentId:experiment.id,
          evaluationCaseId:c.id,evaluationAttempt:attempt,evaluationComparisonId:experiment.comparison_id ?? null,
          agent_prompt_revision_id:(experiment.configuration_snapshot?.['prompt_revision'] as { id?:number }|undefined)?.id ?? null,
          agent_skill_revisions:(experiment.configuration_snapshot?.['skills'] as Array<{ id:number;revision_id?:number;content_sha256?:string }> ?? []).map(s=>({ skill_id:s.id,revision_id:s.revision_id ?? null,content_sha256:s.content_sha256 ?? null })),
          agent_prompt_sha256:evaluationDigest((experiment.configuration_snapshot?.['agent'] as Record<string,unknown>)['system_prompt']),
          configuration_sha256:experiment.configuration_sha256,usageSource:'unknown',costSource:'unknown' })]);
      await client.query(`INSERT INTO mcp_evaluation_attempts (experiment_id,case_id,attempt,worker_token,trace_id) VALUES ($1,$2,$3,$4,$5)`,
        [experiment.id,c.id,attempt,token,traceId]);
      return { id:c.id,trace_id:traceId };
    },async () => null);
    } catch (error) {
      if (error instanceof EvaluationError && error.code==='EVALUATION_CANCEL_REQUESTED') break;
      throw error;
    }
    const outcome = target!.runtimeType==='codex-subscription'
      ? await executeCodexEvaluationCase(experiment.configuration_snapshot!,c,target!,monitor.signal,traceId)
      : await executeNativeEvaluationCase(experiment.configuration_snapshot!,c,target!,monitor.signal);
    const m = outcome.evidence.measurements;
    await mutate(pool,stageContext('case:'+c.id+':result'),'result.recorded',{ experimentId:experiment.id,caseId:c.id,traceId },async client => {
      await lockEvaluationWorker(client,experiment.id,token);
      const row = (await client.query<EvaluationResult>(`INSERT INTO mcp_evaluation_results
        (experiment_id,case_id,attempt,trace_id,status,output_redacted,latency_ms,input_tokens,output_tokens,cost_usd,scores,evaluator_version,error_message,evidence)
        VALUES ($1,$2,$14,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb) RETURNING *`,
      [experiment.id,c.id,traceId,outcome.status,JSON.stringify(outcome.output_redacted),m.latency_ms,m.input_tokens,m.output_tokens,m.cost_usd,
        JSON.stringify(outcome.scores),EVALUATOR_VERSION,outcome.error_message,JSON.stringify(outcome.evidence),attempt])).rows[0]!;
      // Legacy telemetry numeric columns are non-null; nullable measurement truth
      // is retained in metadata and in the authoritative evaluation result.
      await client.query(`UPDATE mcp_observability_traces SET status=$2,ended_at=now(),duration_ms=$3,
        input_tokens=$4,output_tokens=$5,total_cost_usd=$6,error_message=$7,metadata=metadata || $8::jsonb WHERE id=$1`,
      [traceId,outcome.status === 'error' ? 'failed' : 'completed',m.latency_ms,m.input_tokens ?? 0,m.output_tokens ?? 0,m.cost_usd ?? 0,
        outcome.error_message,JSON.stringify({ measurements:m,qualityStatus:outcome.status,usageSource:m.usage_source,costSource:m.cost_source })]);
      return row;
    },async id => (await getEvaluationExperiment(pool,experiment.id,context))?.results.find(r => r.id===id) ?? null);
  }
  await mutate(pool,stageContext('finish'),'experiment.finished',{ experimentId:experiment.id },async client => {
    const worker=await lockEvaluationWorker(client,experiment.id,token);
    const record=await getEvaluationExperiment(client,experiment.id,context);
    if (!record) missingReference();
    const progress=evaluationProgress(record);
    const status=worker.cancel_requested ? 'cancelled' : progress.completed_cases===progress.total_cases ? 'completed' : 'failed';
    return (await client.query<EvaluationExperiment>(`UPDATE mcp_evaluation_experiments SET status=$2,completed_at=now()
      WHERE id=$1 AND status='running' RETURNING *`,[experiment.id,status])).rows[0]!;
  },async id => (await getEvaluationExperiment(pool,id,context))?.experiment ?? null);
  } finally { monitor.stop(); }
}
