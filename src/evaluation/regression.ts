/** Deterministic baseline-vs-candidate evaluation policy. */
import type { EvaluationExperiment, EvaluationResult } from './store.js';
import { evaluationDigest } from './contracts.js';
import { EVALUATOR_VERSION, type EvaluationJudgement } from './scoring.js';
import { evaluationProgress, type EvaluationEvidence } from './lifecycle.js';
import type { EvaluationComparison, EvaluationComparisonStep } from './comparisonStore.js';

export interface EvaluationAggregate {
  overall: number;
  cases: number;
  errors?: number;
  latencyMs?: number;
  costUsd?: number;
}

export interface RegressionPolicy {
  minimumOverall?: number;
  maximumScoreDrop?: number;
  maximumErrorRate?: number;
}

export interface RegressionCheck {
  name: string;
  status: 'passed' | 'failed';
  observed: number;
  threshold: number;
  detail?: string;
}

export interface RegressionResult {
  status: 'passed' | 'failed';
  scoreDelta: number;
  checks: RegressionCheck[];
}

export interface EvaluationAggregateSummary extends EvaluationAggregate {
  experimentId: number;
  status: string;
  medianLatencyMs?: number;
  p95LatencyMs?: number;
  costCoverage: { measured: number; total: number; knownSubtotalUsd: number };
  usageCoverage: { complete: number; partial: number; unknown: number; total: number };
  attemptHistory?: { recorded: number; unresolved: number };
}

export interface EvaluationRegressionResponse {
  comparison_state?: 'passed' | 'failed' | 'inconclusive' | 'not_comparable';
  candidate: EvaluationAggregateSummary;
  baseline: EvaluationAggregateSummary | null;
  result: RegressionResult | null;
  reason?: string;
}

export interface EvaluationScoreResult {
  input_tokens?: number | null;
  output_tokens?: number | null;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  scores: Record<string, number>;
  latency_ms: number | null;
  cost_usd: number | null;
}

/** Compute a bounded aggregate without touching a database or provider. */
export function summarizeEvaluationResults(
  experimentId: number,
  status: string,
  results: EvaluationScoreResult[],
): EvaluationAggregateSummary {
  const scored = results.filter(result => result.status !== 'skipped');
  const scoreValues = scored.map(result => {
    const raw = result.scores?.['overall'] ?? result.scores?.['non_empty'] ?? 0;
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  });
  const overall = scoreValues.length ? scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length : 0;
  const latencyValues = results.map(result => result.latency_ms).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const costs = results.filter(result => result.cost_usd != null).map(result => Number(result.cost_usd)).filter(value => Number.isFinite(value) && value >= 0);
  latencyValues.sort((a,b) => a-b);
  const mid = Math.floor(latencyValues.length / 2);
  const measured = (v:unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const completeUsage = results.filter(r => measured(r.input_tokens) && measured(r.output_tokens)).length;
  const partialUsage = results.filter(r => measured(r.input_tokens) !== measured(r.output_tokens)).length;
  return {
    experimentId,
    status,
    overall: Math.round(overall * 10_000) / 10_000,
    cases: scored.length,
    errors: results.filter(result => result.status === 'error').length,
    latencyMs: latencyValues.length ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length) : undefined,
    costUsd: results.length > 0 && costs.length === results.length ? costs.reduce((sum, value) => sum + value, 0) : undefined,
    medianLatencyMs: latencyValues.length ? (latencyValues.length % 2 ? latencyValues[mid]! : (latencyValues[mid-1]! + latencyValues[mid]!) / 2) : undefined,
    p95LatencyMs: latencyValues.length ? latencyValues[Math.ceil(latencyValues.length * 0.95)-1] : undefined,
    costCoverage: { measured:costs.length,total:results.length,knownSubtotalUsd:costs.reduce((sum,n) => sum+n,0) },
    usageCoverage: { complete:completeUsage,partial:partialUsage,unknown:results.length-completeUsage-partialUsage,total:results.length },
  };
}

type ExperimentEvidence = EvaluationEvidence;
function completeQualityEvidence(record: ExperimentEvidence): boolean {
  const e = record.experiment;
  const expected = e.expected_cases;
  const execution = e.configuration_snapshot?.['execution'] as Record<string,unknown> | undefined;
  const current=evaluationProgress(record).current_results;
  return e.evidence_kind === 'frozen_v1' && e.status === 'completed' && !!expected?.length
    && ((execution?.['executor_version']==='argus.native-reference.v1' && execution['type']==='argus')
      || (execution?.['executor_version']==='argus.codex-reference.v1' && execution['type']==='codex'))
    && execution['isolation_verified'] === true && e.configuration_snapshot?.['context_mode'] === 'isolated_reference'
    && !!e.configuration_snapshot && evaluationDigest(e.configuration_snapshot) === e.configuration_sha256
    && evaluationDigest(e.configuration_snapshot['evaluator']) === e.evaluator_sha256
    && current.length === expected.length && new Set(current.map(r => r.case_id)).size === expected.length
    // A technical retry must not replace a previously judged (even failed) answer.
    && !record.results.some(r => ['passed','failed'].includes(r.status) && current.some(n => n.case_id===r.case_id && n.attempt>r.attempt))
    && expected.every(c => current.some(r => r.case_id === c.id && (r.attempt===1 || record.attempts?.some(a => a.case_id===r.case_id && a.attempt===r.attempt))
      && r.evaluator_version === EVALUATOR_VERSION && ['passed','failed'].includes(r.status)
      && r.evidence?.['executor_version'] === execution['executor_version']
      && consistentJudgement(r)
      && Number.isFinite(r.scores['overall']) && r.scores['overall']! >= 0 && r.scores['overall']! <= 1));
}

function summarizeEvidence(record: ExperimentEvidence): EvaluationAggregateSummary {
  const progress=evaluationProgress(record);
  const current=summarizeEvaluationResults(record.experiment.id,record.experiment.status,progress.current_results);
  // Billing includes ALL observed attempts, not just the successful replacement.
  const history=summarizeEvaluationResults(record.experiment.id,record.experiment.status,[...record.results,
    ...Array.from({ length:progress.pending_attempts },() => ({ status:'error' as const,scores:{},latency_ms:null,cost_usd:null }))]);
  return { ...current,costUsd:history.costUsd,costCoverage:history.costCoverage,usageCoverage:history.usageCoverage,
    attemptHistory:{ recorded:record.results.length,unresolved:progress.pending_attempts } };
}

function consistentJudgement(r: EvaluationResult): boolean {
  const j = r.evidence?.['judgement'] as EvaluationJudgement | undefined;
  if (j?.version !== EVALUATOR_VERSION || !Array.isArray(j.assertions) || !j.assertions.length
      || j.status !== r.status || j.scores?.overall !== r.scores['overall']) return false;
  if (!j.assertions.every((a,index) => a.index === index && typeof a.passed === 'boolean')) return false;
  const passed = j.assertions.filter(a => a.passed).length;
  return j.scores.overall === passed / j.assertions.length && (r.status === 'passed') === (passed === j.assertions.length);
}

/** Never promote legacy, partial, skipped, repeated, foreign or differently judged runs. */
export function compareEvaluationEvidence(candidate: ExperimentEvidence, baseline: ExperimentEvidence | null): EvaluationRegressionResponse {
  const response: EvaluationRegressionResponse = {
    candidate:summarizeEvidence(candidate),
    baseline:baseline ? summarizeEvidence(baseline) : null,
    result:null,comparison_state:'inconclusive',
  };
  if (candidate.experiment.evidence_kind !== 'frozen_v1' || baseline && baseline.experiment.evidence_kind !== 'frozen_v1') {
    return { ...response,comparison_state:'not_comparable',reason:'Legacy smoke is not deterministic quality evidence.' };
  }
  if (!baseline) return { ...response,reason:'Choose a completed compatible baseline; no quality gate without baseline evidence.' };
  const a = candidate.experiment, b = baseline.experiment;
  if (a.baseline_experiment_id !== b.id || a.tenant_key !== b.tenant_key || a.workspace_key !== b.workspace_key
      || a.dataset_id !== b.dataset_id || a.dataset_sha256 !== b.dataset_sha256 || a.evaluator_sha256 !== b.evaluator_sha256
      || evaluationDigest(a.expected_cases) !== evaluationDigest(b.expected_cases)) {
    return { ...response,comparison_state:'not_comparable',reason:'Baseline and candidate do not share the same frozen cases, evaluators and workspace.' };
  }
  if (!completeQualityEvidence(candidate) || !completeQualityEvidence(baseline)) {
    return { ...response,reason:'Both runs need one final deterministic result per expected case; pending or replaced quality evidence cannot pass.' };
  }
  const result = evaluateRegression(response.baseline!,response.candidate);
  // Relative improvement alone must not promote a candidate with failed mandatory rules.
  const failed = evaluationProgress(candidate).current_results.filter(r => r.status !== 'passed').length;
  result.checks.push({ name:'mandatory_case_assertions',status:failed === 0 ? 'passed' : 'failed',observed:failed,threshold:0 });
  result.status = result.checks.every(c => c.status === 'passed') ? 'passed' : 'failed';
  return { ...response,comparison_state:result.status,result };
}

/** Every planned pair contributes. Never pick a favourable repeat or claim significance. */
export function summarizeEvaluationComparison(comparison:EvaluationComparison,records:Array<ExperimentEvidence & EvaluationComparisonStep>) {
  const rounds=Array.from({ length:comparison.repetitions },(_,i) => {
    const a=records.find(r => r.round===i+1 && r.variant==='baseline');
    const b=records.find(r => r.round===i+1 && r.variant==='candidate');
    return { round:i+1,baseline_experiment_id:a?.experiment.id ?? null,candidate_experiment_id:b?.experiment.id ?? null,
      evidence:b ? compareEvaluationEvidence(b,a ?? null) : null };
  });
  const compatible=records.length===comparison.repetitions*2 && comparison.plan.every(step =>
    records.filter(r => r.experiment.id===step.experiment_id && r.configuration_sha256===step.configuration_sha256
      && r.variant===step.variant && r.round===step.round).length===1);
  const allComplete=compatible && comparison.status==='completed' && rounds.every(r => r.evidence?.result);
  const summaries=records.map(summarizeEvidence);
  const knownCost=summaries.reduce((s,r) => s+r.costCoverage.knownSubtotalUsd,0);
  const measured=summaries.reduce((s,r) => s+r.costCoverage.measured,0);
  const attempts=summaries.reduce((s,r) => s+r.costCoverage.total,0);
  return { rounds,comparison_state:!compatible ? 'not_comparable' : !allComplete ? 'inconclusive'
    : rounds.every(r => r.evidence?.result?.status==='passed') ? 'passed' : 'failed',
    completed_steps:records.filter(r => r.experiment.status==='completed').length,total_steps:comparison.plan.length,
    planned_requests:records.reduce((s,r) => s+(r.experiment.expected_cases?.length ?? 0),0),
    remaining_requests:records.filter(r => r.experiment.status==='queued').reduce((s,r) => s+(r.experiment.expected_cases?.length ?? 0),0),
    cost_coverage:{ measured,total:attempts,known_subtotal_usd:knownCost },
    note:'Configuration comparison, not a statistical significance claim. All rounds must complete and every candidate must pass the mandatory rules. Costs include all recorded and unresolved attempts; unstarted requests are not zero-cost evidence.' };
}

function bounded(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, n));
}

/**
 * Compare aggregate candidate evidence with a pinned baseline. This function
 * is intentionally pure so CI, the API and future UI previews use identical
 * promotion semantics.
 */
export function evaluateRegression(
  baseline: EvaluationAggregate,
  candidate: EvaluationAggregate,
  policy: RegressionPolicy = {},
): RegressionResult {
  const minimumOverall = bounded(policy.minimumOverall, 0);
  const maximumScoreDrop = bounded(policy.maximumScoreDrop, 0.05);
  const maximumErrorRate = bounded(policy.maximumErrorRate, 0);
  const baselineOverall = bounded(baseline.overall);
  const candidateOverall = bounded(candidate.overall);
  const scoreDelta = Math.round((candidateOverall - baselineOverall) * 10_000) / 10_000;
  const candidateCases = Math.max(0, Math.floor(candidate.cases || 0));
  const candidateErrors = Math.max(0, Math.floor(candidate.errors || 0));
  const errorRate = candidateCases > 0 ? candidateErrors / candidateCases : candidateErrors > 0 ? 1 : 0;
  const checks: RegressionCheck[] = [
    {
      name: 'minimum_overall',
      status: candidateOverall >= minimumOverall ? 'passed' : 'failed',
      observed: candidateOverall,
      threshold: minimumOverall,
    },
    {
      name: 'maximum_score_drop',
      status: scoreDelta >= -maximumScoreDrop ? 'passed' : 'failed',
      observed: scoreDelta,
      threshold: -maximumScoreDrop,
      detail: `baseline=${baselineOverall.toFixed(4)} candidate=${candidateOverall.toFixed(4)}`,
    },
    {
      name: 'maximum_error_rate',
      status: errorRate <= maximumErrorRate ? 'passed' : 'failed',
      observed: errorRate,
      threshold: maximumErrorRate,
    },
  ];
  return {
    status: checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
    scoreDelta,
    checks,
  };
}
