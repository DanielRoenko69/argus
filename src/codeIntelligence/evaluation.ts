import type { CodeRetrievalStrategy } from './types.js';

export interface CodeRetrievalEvaluationCase {
  id: string;
  query: string;
  expectedFiles: string[];
  limit: number;
}

export interface CodeRetrievalEvaluationObservation {
  caseId: string;
  strategy: CodeRetrievalStrategy;
  returnedFiles: string[];
  latencyMs: number;
}

export interface CodeRetrievalCaseScore {
  caseId: string;
  recallAtK: number;
  reciprocalRank: number;
  top1Correct: boolean;
  unexpectedFileRate: number;
  distinctFiles: number;
  latencyMs: number;
}

export interface CodeRetrievalStrategySummary {
  strategy: CodeRetrievalStrategy;
  cases: number;
  meanRecallAtK: number;
  meanReciprocalRank: number;
  top1Accuracy: number;
  meanUnexpectedFileRate: number;
  meanDistinctFiles: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  caseScores: CodeRetrievalCaseScore[];
}

export interface CodeRetrievalPromotionPolicy {
  minimumRecallAtK: number;
  maximumRecallDrop: number;
  maximumMrrDrop: number;
  maximumUnexpectedFileRateIncrease: number;
  maximumLatencyRatio: number;
}

function boundedMetric(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizedPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

export function scoreCodeRetrievalCase(
  evaluationCase: CodeRetrievalEvaluationCase,
  observation: CodeRetrievalEvaluationObservation,
): CodeRetrievalCaseScore {
  const expected = new Set(evaluationCase.expectedFiles.map(normalizedPath));
  const returned = observation.returnedFiles.map(normalizedPath).filter(Boolean);
  const returnedDistinct = new Set(returned);
  const relevantReturned = new Set([...returnedDistinct].filter(file => expected.has(file)));
  const firstRelevant = returned.findIndex(file => expected.has(file));
  const unexpected = returned.filter(file => !expected.has(file)).length;
  return {
    caseId: evaluationCase.id,
    recallAtK: expected.size === 0 ? 0 : boundedMetric(relevantReturned.size / expected.size),
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    top1Correct: returned.length > 0 && expected.has(returned[0]!),
    unexpectedFileRate: returned.length === 0 ? 0 : boundedMetric(unexpected / returned.length),
    distinctFiles: returnedDistinct.size,
    latencyMs: Math.max(0, observation.latencyMs),
  };
}

export function summarizeCodeRetrievalStrategy(
  strategy: CodeRetrievalStrategy,
  cases: readonly CodeRetrievalEvaluationCase[],
  observations: readonly CodeRetrievalEvaluationObservation[],
): CodeRetrievalStrategySummary {
  const byCase = new Map(observations
    .filter(item => item.strategy === strategy)
    .map(item => [item.caseId, item]));
  const caseScores = cases.map(evaluationCase => {
    const observation = byCase.get(evaluationCase.id);
    if (!observation) throw new Error(`missing ${strategy} observation for evaluation case '${evaluationCase.id}'`);
    return scoreCodeRetrievalCase(evaluationCase, observation);
  });
  const latencies = caseScores.map(item => item.latencyMs);
  return {
    strategy,
    cases: caseScores.length,
    meanRecallAtK: mean(caseScores.map(item => item.recallAtK)),
    meanReciprocalRank: mean(caseScores.map(item => item.reciprocalRank)),
    top1Accuracy: mean(caseScores.map(item => item.top1Correct ? 1 : 0)),
    meanUnexpectedFileRate: mean(caseScores.map(item => item.unexpectedFileRate)),
    meanDistinctFiles: mean(caseScores.map(item => item.distinctFiles)),
    averageLatencyMs: mean(latencies),
    p95LatencyMs: percentile95(latencies),
    caseScores,
  };
}

export function evaluateCodeRetrievalPromotion(
  baseline: CodeRetrievalStrategySummary,
  candidate: CodeRetrievalStrategySummary,
  policy: CodeRetrievalPromotionPolicy,
) {
  const latencyRatio = candidate.averageLatencyMs / Math.max(1, baseline.averageLatencyMs);
  const unexpectedFileRateDelta = candidate.meanUnexpectedFileRate - baseline.meanUnexpectedFileRate;
  const checks = [
    { id: 'minimum_recall_at_k', passed: candidate.meanRecallAtK >= policy.minimumRecallAtK, actual: candidate.meanRecallAtK, threshold: policy.minimumRecallAtK },
    { id: 'maximum_recall_drop', passed: candidate.meanRecallAtK >= baseline.meanRecallAtK - policy.maximumRecallDrop, actual: candidate.meanRecallAtK - baseline.meanRecallAtK, threshold: -policy.maximumRecallDrop },
    { id: 'maximum_mrr_drop', passed: candidate.meanReciprocalRank >= baseline.meanReciprocalRank - policy.maximumMrrDrop, actual: candidate.meanReciprocalRank - baseline.meanReciprocalRank, threshold: -policy.maximumMrrDrop },
    {
      id: 'maximum_unexpected_file_rate_increase',
      passed: unexpectedFileRateDelta <= policy.maximumUnexpectedFileRateIncrease,
      actual: unexpectedFileRateDelta,
      threshold: policy.maximumUnexpectedFileRateIncrease,
    },
    { id: 'maximum_latency_ratio', passed: latencyRatio <= policy.maximumLatencyRatio, actual: latencyRatio, threshold: policy.maximumLatencyRatio },
  ];
  return {
    status: checks.every(check => check.passed) ? 'passed' as const : 'failed' as const,
    baseline: baseline.strategy,
    candidate: candidate.strategy,
    policy,
    checks,
  };
}
