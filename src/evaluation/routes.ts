import type { Express, Request, RequestHandler, Response } from 'express';
import type pg from 'pg';
import { SkillPinUnavailableError } from '../agents/skillStore.js';
import { z } from 'zod';
import type { Config } from '../config/env.js';
import { WorkspaceScopeAccessError } from '../auth/workspaceScope.js';
import { requireFreshMfa, requirePermission } from '../auth/sessionMiddleware.js';
import { exportEvaluationComparison } from './export.js';
import { logger } from '../lib/logger.js';
import { evaluationContext, missingReference, type EvaluationContext } from './context.js';
import { evaluationStarterSets } from './starterSets.js';
import { applyExecutionRelease, listExecutionReleases, previewExecutionRelease, previewExecutionRollback, rollbackExecutionRelease } from './releases.js';
import { createPromptRevision, getAgentPromptState } from './promptRevisions.js';
import { createSkillRevision,getAgentSkillState } from './skillRevisions.js';
import { applySkillRelease,listSkillReleases,previewSkillRelease,previewSkillRollback,rollbackSkillRelease } from './skillReleases.js';
import { applyPromptRelease, listPromptReleases, previewPromptRelease, previewPromptRollback, rollbackPromptRelease } from './promptReleases.js';
import { getQualityReviewHistory, listQualityQueue, saveQualityReview } from './reviewQueue.js';
import { createEvaluationCaseFromTrace, importEvaluationStarterSet, previewEvaluationTrace, starterImportSchema, traceCaseSchema, traceSourceSchema } from './curation.js';
import { createDatasetSchema, createCaseSchema, createExperimentSchema, EvaluationError, evaluationReadiness } from './contracts.js';
import { compareEvaluationEvidence, evaluateRegression, summarizeEvaluationComparison } from './regression.js';
import { createEvaluationComparison, getEvaluationComparisonDetail, listEvaluationComparisons } from './comparisonStore.js';
import { cancelEvaluationComparison, runEvaluationComparison } from './comparisonRunner.js';
import { buildComparisonPreview, evaluationPreview, listEvaluationTargets } from './authoring.js';
import { executeEvaluationExperiment, retryEvaluationExperiment } from './runner.js';
import { cancelEvaluationExperiment, evaluationProgress } from './lifecycle.js';
import {
  createEvaluationDataset, createEvaluationCase, activateEvaluationDataset, getEvaluationDataset,
  listEvaluationDatasets, createEvaluationExperiment, getEvaluationExperiment, listEvaluationExperiments,
  type EvaluationExperiment,
} from './store.js';

interface EvaluationRouteOptions {
  config: Config; requireAuth: RequestHandler; requireAdmin: RequestHandler; requireSameOrigin: RequestHandler;
}
const idSchema = z.coerce.number().int().positive().safe();
function readiness(e:EvaluationExperiment) {
  return e.comparison_id && e.status==='queued'
    ? { startable:false,code:'EVALUATION_COMPARISON_CONTROLLED',reason:`Start this snapshot through comparison #${e.comparison_id}; its execution order is frozen.` }
    : evaluationReadiness(e.evidence_kind,e.configuration_snapshot,e.status);
}
function handleError(res: Response,error: unknown): void {
  if (error instanceof SkillPinUnavailableError) {
    res.status(409).json({ error:error.message,code:'EVALUATION_SKILL_UNAVAILABLE' });return;
  }
  if (error instanceof EvaluationError || error instanceof WorkspaceScopeAccessError) {
    res.status(error.status).json({ error:error.message,code:error.code }); return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error:'Invalid evaluation request',code:'EVALUATION_INVALID',
      issues:error.issues.map(i => ({ path:i.path,message:i.message })) }); return;
  }
  const sqlCode = (error as { code?: string })?.code;
  if (sqlCode==='23505') { res.status(409).json({ error:'This version or case already exists',code:'EVALUATION_CONFLICT' }); return; }
  if (sqlCode==='23503') { res.status(404).json({ error:'Referenced resource was not found in this workspace',code:'EVALUATION_REFERENCE_NOT_FOUND' }); return; }
  if (sqlCode==='23514') { res.status(409).json({ error:'The evaluation integrity constraint rejected this change',code:'EVALUATION_INTEGRITY_CONFLICT' }); return; }
  // Do not leak SQL detail, prompts, provider messages or credentials in responses/logs.
  logger.error({ code:sqlCode ?? 'UNKNOWN' },'Evaluation operation failed');
  res.status(500).json({ error:'Evaluation operation failed',code:'EVALUATION_FAILED' });
}
export function registerEvaluationRoutes(app: Express,pool: pg.Pool,options: EvaluationRouteOptions): void {
  const { requireAuth,requireAdmin,requireSameOrigin }=options;
  const route=(fn:(req:Request,res:Response,context:EvaluationContext)=>Promise<void>):RequestHandler =>
    (req,res) => { void (async () => {
      try { await fn(req,res,evaluationContext(req)); } catch(error) { handleError(res,error); }
    })(); };
  const get=(path:string,fn:Parameters<typeof route>[0]) => app.get('/api/admin/evaluations'+path,requireAuth,requireAdmin,route(fn));
  const post=(path:string,fn:Parameters<typeof route>[0]) => app.post('/api/admin/evaluations'+path,requireAuth,requireAdmin,requireSameOrigin,route(fn));

  get('/agents/:id/skill-revisions',async(req,res,c)=>{
    res.set('Cache-Control','private, no-store');res.json(await getAgentSkillState(pool,idSchema.parse(req.params['id']),c));
  });
  post('/agents/:id/skill-revisions',async(req,res,c)=>{
    res.set('Cache-Control','private, no-store');res.status(201).json({ revision:await createSkillRevision(pool,idSchema.parse(req.params['id']),req.body,c) });
  });
  get('/comparisons/:id/skill-releases',async(req,res,c)=>{
    res.set('Cache-Control','private, no-store');res.json({ releases:await listSkillReleases(pool,idSchema.parse(req.params['id']),c) });
  });
  for (const [path,operation] of [
    ['/comparisons/:id/skill-release-preview',previewSkillRelease],['/skill-releases/:id/rollback-preview',previewSkillRollback],
  ] as const) post(path,async(req,res,c)=>{
    z.object({}).strict().parse(req.body ?? {});res.set('Cache-Control','private, no-store');res.json(await operation(pool,idSchema.parse(req.params['id']),c));
  });
  for (const [path,operation] of [
    ['/comparisons/:id/skill-release',applySkillRelease],['/skill-releases/:id/rollback',rollbackSkillRelease],
  ] as const) app.post('/api/admin/evaluations'+path,requireAuth,requireAdmin,requirePermission('agents.manage'),requireSameOrigin,
    requireFreshMfa(options.config.oidcMfaMaxAgeSeconds ?? 600),route(async(req,res,c)=>{
      res.set('Cache-Control','private, no-store');res.status(201).json({ release:await operation(pool,idSchema.parse(req.params['id']),req.body,c,options.config.oidcMfaMaxAgeSeconds ?? 600) });
    }));

  get('/agents/:id/prompt-revisions',async(req,res,c)=>{
    res.set('Cache-Control','private, no-store');res.json(await getAgentPromptState(pool,idSchema.parse(req.params['id']),c));
  });
  post('/agents/:id/prompt-revisions',async(req,res,c)=>{
    res.set('Cache-Control','private, no-store');res.status(201).json({ revision:await createPromptRevision(pool,idSchema.parse(req.params['id']),req.body,c) });
  });
  get('/comparisons/:id/prompt-releases',async(req,res,c)=>{
    res.set('Cache-Control','private, no-store');res.json({ releases:await listPromptReleases(pool,idSchema.parse(req.params['id']),c) });
  });
  for (const [path,operation] of [
    ['/comparisons/:id/prompt-release-preview',previewPromptRelease],['/prompt-releases/:id/rollback-preview',previewPromptRollback],
  ] as const) post(path,async(req,res,c)=>{
    z.object({}).strict().parse(req.body ?? {});res.set('Cache-Control','private, no-store');res.json(await operation(pool,idSchema.parse(req.params['id']),c));
  });
  for (const [path,operation] of [
    ['/comparisons/:id/prompt-release',applyPromptRelease],['/prompt-releases/:id/rollback',rollbackPromptRelease],
  ] as const) app.post('/api/admin/evaluations'+path,requireAuth,requireAdmin,requirePermission('agents.manage'),requireSameOrigin,
    requireFreshMfa(options.config.oidcMfaMaxAgeSeconds ?? 600),route(async(req,res,c)=>{
      res.set('Cache-Control','private, no-store');res.status(201).json({ release:await operation(pool,idSchema.parse(req.params['id']),req.body,c,options.config.oidcMfaMaxAgeSeconds ?? 600) });
    }));

  get('/comparisons/:id/releases',async(req,res,c) => {
    res.set('Cache-Control','private, no-store');res.json({ releases:await listExecutionReleases(pool,idSchema.parse(req.params['id']),c) });
  });
  post('/comparisons/:id/release-preview',async(req,res,c) => {
    z.object({}).strict().parse(req.body ?? {});res.set('Cache-Control','private, no-store');res.json(await previewExecutionRelease(pool,idSchema.parse(req.params['id']),c));
  });
  post('/releases/:id/rollback-preview',async(req,res,c) => {
    z.object({}).strict().parse(req.body ?? {});res.set('Cache-Control','private, no-store');res.json(await previewExecutionRollback(pool,idSchema.parse(req.params['id']),c));
  });
  for (const [path,operation] of [
    ['/comparisons/:id/release',applyExecutionRelease],['/releases/:id/rollback',rollbackExecutionRelease],
  ] as const) app.post('/api/admin/evaluations'+path,requireAuth,requireAdmin,requirePermission('agents.manage'),requireSameOrigin,
    requireFreshMfa(options.config.oidcMfaMaxAgeSeconds ?? 600),route(async(req,res,c) => {
      res.set('Cache-Control','private, no-store');res.status(201).json({ release:await operation(pool,idSchema.parse(req.params['id']),req.body,c,options.config.oidcMfaMaxAgeSeconds ?? 600) });
    }));

  get('/starter-sets',async(_req,res) => { res.json({ starter_sets:evaluationStarterSets }); });
  get('/review-queue',async(_req,res,context) => {
    res.set('Cache-Control','private, no-store'); res.json(await listQualityQueue(pool,context));
  });
  get('/review-queue/:traceId',async(req,res,context) => {
    res.set('Cache-Control','private, no-store'); res.json(await getQualityReviewHistory(pool,z.string().uuid().parse(req.params['traceId']),context));
  });
  post('/review-queue/:traceId',async(req,res,context) => {
    res.set('Cache-Control','private, no-store');
    res.status(201).json({ review:await saveQualityReview(pool,z.string().uuid().parse(req.params['traceId']),req.body,context) });
  });
  post('/starter-sets/:key/import',async(req,res,context) => {
    res.status(201).json({ dataset:await importEvaluationStarterSet(pool,String(req.params['key']),starterImportSchema.parse(req.body),context) });
  });
  post('/trace-preview',async(req,res,context) => {
    res.set('Cache-Control','private, no-store');
    res.json(await previewEvaluationTrace(pool,traceSourceSchema.parse(req.body),context));
  });
  post('/datasets/:id/from-trace',async(req,res,context) => {
    res.status(201).json({ case:await createEvaluationCaseFromTrace(pool,idSchema.parse(req.params['id']),traceCaseSchema.parse(req.body),context) });
  });

  const exportRoute=route(async(req,res,context) => {
    const format=z.enum(['json','csv','pdf']).parse(req.query['format']);
    const artifact=await exportEvaluationComparison(pool,idSchema.parse(req.params['id']),format,context,options.config.oidcMfaMaxAgeSeconds ?? 600);
    res.set({ 'Content-Type':req.path.endsWith('/content') ? 'application/vnd.argus.evaluation-artifact' : artifact.contentType,
      'X-Argus-Artifact-Content-Type':artifact.contentType,'X-Argus-Artifact-Filename':artifact.filename,
      'X-Argus-Artifact-Sha256':artifact.artifactSha256,'X-Argus-Payload-Sha256':artifact.payloadSha256,
      'X-Argus-Audit-Event-Id':artifact.auditEventId,'Content-Length':String(artifact.bytes.length),
      'Content-Digest':`sha-256=:${Buffer.from(artifact.artifactSha256,'hex').toString('base64')}:`,
      'Content-Disposition':`${req.path.endsWith('/content') ? 'inline' : 'attachment'}; filename="${artifact.filename}"` });
    res.send(artifact.bytes);
  });
  for (const suffix of ['/export','/export/content']) app.get('/api/admin/evaluations/comparisons/:id'+suffix,
    (_req,res,next) => { res.set({ 'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff' }); next(); },
    requireAuth,requireAdmin,requirePermission('audit.export'),requireSameOrigin,
    requireFreshMfa(options.config.oidcMfaMaxAgeSeconds ?? 600),exportRoute);

  get('/targets',async(req,res,context) => {
    res.json(await listEvaluationTargets(pool,idSchema.parse(req.query['agent_id']),context));
  });
  post('/comparisons/preflight',async(req,res,context) => {
    res.json(await evaluationPreview(pool,client => buildComparisonPreview(client,req.body,context)));
  });
  get('/comparisons',async(_req,res,context) => {
    res.json({ comparisons:await listEvaluationComparisons(pool,context) });
  });
  post('/comparisons',async(req,res,context) => {
    res.status(201).json({ comparison:await createEvaluationComparison(pool,req.body,context) });
  });
  get('/comparisons/:id',async(req,res,context) => {
    const detail=await getEvaluationComparisonDetail(pool,idSchema.parse(req.params['id']),context);
    if (!detail) missingReference();
    res.json({ ...detail,summary:summarizeEvaluationComparison(detail.comparison,detail.records) });
  });
  post('/comparisons/:id/run',async(req,res,context) => {
    const { comparison_id,status }=await runEvaluationComparison(pool,idSchema.parse(req.params['id']),req.body,context);
    res.status(202).json({ comparison_id,status });
  });
  post('/comparisons/:id/cancel',async(req,res,context) => {
    z.object({}).strict().parse(req.body ?? {});
    const c=await cancelEvaluationComparison(pool,idSchema.parse(req.params['id']),context);
    res.status(202).json({ comparison_id:c.id,status:c.status });
  });

  get('/datasets',async(req,res,context) => {
    const status=z.enum(['draft','active','archived']).optional().parse(req.query['status']);
    res.json({ datasets:await listEvaluationDatasets(pool,context,status) });
  });
  post('/datasets',async(req,res,context) => {
    const b=createDatasetSchema.parse(req.body);
    res.status(201).json({ dataset:await createEvaluationDataset(pool,{
      datasetKey:b.dataset_key,version:b.version,name:b.name,description:b.description,bundleIds:b.bundle_ids,agentId:b.agent_id,
    },context) });
  });
  get('/datasets/:id',async(req,res,context) => {
    const record=await getEvaluationDataset(pool,idSchema.parse(req.params['id']),context);
    if (!record) missingReference();
    res.json(record);
  });
  post('/datasets/:id/cases',async(req,res,context) => {
    const b=createCaseSchema.parse(req.body);
    res.status(201).json({ case:await createEvaluationCase(pool,idSchema.parse(req.params['id']),{
      caseKey:b.case_key,input:b.input,expectedOutput:b.expected_output,context:b.context,
      sourceTraceId:b.source_trace_id,sourceSpanId:b.source_span_id,metadata:b.metadata,rules:b.rules,
    },context) });
  });
  post('/datasets/:id/activate',async(req,res,context) => {
    res.json({ dataset:await activateEvaluationDataset(pool,idSchema.parse(req.params['id']),context) });
  });
  get('/experiments',async(req,res,context) => {
    const status=z.enum(['queued','running','completed','failed','cancelled','interrupted']).optional().parse(req.query['status']);
    const experiments=await listEvaluationExperiments(pool,context,status);
    res.json({ experiments:experiments.map(e => ({ ...e,readiness:readiness(e) })) });
  });
  post('/experiments',async(req,res,context) => {
    const b=createExperimentSchema.parse(req.body);
    const experiment=await createEvaluationExperiment(pool,{
      datasetId:b.dataset_id,agentId:b.agent_id,modelRef:b.model_ref,credentialRef:b.credential_ref,
      evaluatorConfig:b.evaluator_config,baselineExperimentId:b.baseline_experiment_id,
    },context);
    res.status(201).json({ experiment:{ ...experiment,readiness:evaluationReadiness(experiment.evidence_kind,experiment.configuration_snapshot,experiment.status) } });
  });
  get('/experiments/:id',async(req,res,context) => {
    const record=await getEvaluationExperiment(pool,idSchema.parse(req.params['id']),context);
    if (!record) missingReference();
    const { current_results:_current,...progress }=evaluationProgress(record);
    res.json({ ...record,progress,experiment:{ ...record.experiment,readiness:readiness(record.experiment) } });
  });
  get('/experiments/:id/regression',async(req,res,context) => {
    const id=idSchema.parse(req.params['id']);
    const record=await getEvaluationExperiment(pool,id,context);
    if (!record) missingReference();
    const baseline = record.experiment.baseline_experiment_id
      ? await getEvaluationExperiment(pool,record.experiment.baseline_experiment_id,context) : null;
    res.json(compareEvaluationEvidence(record,baseline));
  });
  post('/experiments/:id/run',async(req,res,context) => {
    const { experiment_id,status } = await executeEvaluationExperiment(pool,options.config,idSchema.parse(req.params['id']),context);
    res.status(202).json({ experiment_id,status });
  });
  post('/experiments/:id/cancel',async(req,res,context) => {
    z.object({}).strict().parse(req.body ?? {});
    const experiment=await cancelEvaluationExperiment(pool,idSchema.parse(req.params['id']),context);
    res.status(202).json({ experiment_id:experiment.id,status:experiment.status });
  });
  post('/experiments/:id/retry',async(req,res,context) => {
    const { experiment_id,status }=await retryEvaluationExperiment(pool,idSchema.parse(req.params['id']),req.body,context);
    res.status(202).json({ experiment_id,status });
  });
  post('/regression',async(req,res) => {
    const aggregate=z.object({ overall:z.number().min(0).max(1),cases:z.number().int().min(1),
      errors:z.number().int().nonnegative().optional(),latencyMs:z.number().nonnegative().optional(),costUsd:z.number().nonnegative().optional() }).strict();
    const b=z.object({ baseline:aggregate,candidate:aggregate,policy:z.object({
      minimumOverall:z.number().min(0).max(1).optional(),maximumScoreDrop:z.number().min(0).max(1).optional(),
      maximumErrorRate:z.number().min(0).max(1).optional() }).strict().optional() }).strict().parse(req.body);
    res.json({ evidence_kind:'simulation',result:evaluateRegression(b.baseline,b.candidate,b.policy) });
  });
}
