export interface CodeContextDryRunCase {
  id: string;
  expectedFiles: string[];
}

export interface CodeContextDryRunOutput {
  parsed: boolean;
  likelyFiles: string[];
  testBoundary: string[];
  citations: string[];
}

export interface CodeContextDryRunObservation {
  caseId: string;
  variant: string;
  suppliedCitations: string[];
  planner: CodeContextDryRunOutput;
  knowledge: CodeContextDryRunOutput;
  retrievalFiles: string[];
  workspaceUnchanged: boolean;
  contextTokensEstimated: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface CodeContextDryRunScore {
  caseId: string;
  variant: string;
  retrievalRecall: number;
  planFileRecall: number;
  knowledgeFileRecall: number;
  testBoundaryRecall: number;
  citationValidity: number;
  structuredOutput: boolean;
  workspaceUnchanged: boolean;
  contextTokensEstimated: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface CodeContextDryRunSummary {
  variant: string;
  cases: number;
  meanRetrievalRecall: number;
  meanPlanFileRecall: number;
  meanKnowledgeFileRecall: number;
  meanTestBoundaryRecall: number;
  meanCitationValidity: number;
  structuredOutputRate: number;
  writeBoundaryPassRate: number;
  averageContextTokensEstimated: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  averageDurationMs: number;
  caseScores: CodeContextDryRunScore[];
}

export interface CodeContextDryRunPromotionPolicy {
  minimumPlanFileRecall: number;
  minimumTestBoundaryRecall: number;
  maximumPlanRecallDrop: number;
  maximumContextTokenRatio: number;
}

function normalizedPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function citationPath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  const commitSeparator = normalized.indexOf(':', normalized.indexOf('@') + 1);
  const path = commitSeparator >= 0 ? normalized.slice(commitSeparator + 1) : normalized;
  return normalizedPath(path.replace(/#L\d+(?:-L\d+)?$/i, ''));
}

function bounded(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recall(expected: Set<string>, values: readonly string[]): number {
  if (expected.size === 0) return 1;
  const returned = new Set(values.map(normalizedPath));
  return bounded([...expected].filter(path => returned.has(path)).length / expected.size);
}

export function scoreCodeContextDryRunCase(
  evaluationCase: CodeContextDryRunCase,
  observation: CodeContextDryRunObservation,
): CodeContextDryRunScore {
  const expected = new Set(evaluationCase.expectedFiles.map(normalizedPath));
  const testFiles = new Set([...expected].filter(path => /(^|\/)(?:test|tests|__tests__)(\/|$)|\.(?:test|spec)\./i.test(path)));
  const supplied = new Set(observation.suppliedCitations.map(value => value.trim()).filter(Boolean));
  const returnedCitations = [...observation.planner.citations, ...observation.knowledge.citations]
    .map(value => value.trim()).filter(Boolean);
  const citationValidity = returnedCitations.length === 0
    ? 0
    : returnedCitations.filter(value => supplied.has(value)).length / returnedCitations.length;
  const planPaths = [
    ...observation.planner.likelyFiles,
    ...observation.planner.testBoundary,
    ...observation.planner.citations.map(citationPath),
  ];
  const knowledgePaths = [
    ...observation.knowledge.likelyFiles,
    ...observation.knowledge.testBoundary,
    ...observation.knowledge.citations.map(citationPath),
  ];
  return {
    caseId: evaluationCase.id,
    variant: observation.variant,
    retrievalRecall: recall(expected, observation.retrievalFiles),
    planFileRecall: recall(expected, planPaths),
    knowledgeFileRecall: recall(expected, knowledgePaths),
    testBoundaryRecall: recall(testFiles, [...observation.planner.testBoundary, ...observation.knowledge.testBoundary]),
    citationValidity: bounded(citationValidity),
    structuredOutput: observation.planner.parsed && observation.knowledge.parsed,
    workspaceUnchanged: observation.workspaceUnchanged,
    contextTokensEstimated: Math.max(0, observation.contextTokensEstimated),
    inputTokens: Math.max(0, observation.inputTokens),
    outputTokens: Math.max(0, observation.outputTokens),
    durationMs: Math.max(0, observation.durationMs),
  };
}

export function summarizeCodeContextDryRun(
  variant: string,
  cases: readonly CodeContextDryRunCase[],
  observations: readonly CodeContextDryRunObservation[],
): CodeContextDryRunSummary {
  const byCase = new Map(observations.filter(item => item.variant === variant).map(item => [item.caseId, item]));
  const caseScores = cases.map(evaluationCase => {
    const observation = byCase.get(evaluationCase.id);
    if (!observation) throw new Error(`missing ${variant} Stage-2 observation for '${evaluationCase.id}'`);
    return scoreCodeContextDryRunCase(evaluationCase, observation);
  });
  return {
    variant,
    cases: caseScores.length,
    meanRetrievalRecall: mean(caseScores.map(item => item.retrievalRecall)),
    meanPlanFileRecall: mean(caseScores.map(item => item.planFileRecall)),
    meanKnowledgeFileRecall: mean(caseScores.map(item => item.knowledgeFileRecall)),
    meanTestBoundaryRecall: mean(caseScores.map(item => item.testBoundaryRecall)),
    meanCitationValidity: mean(caseScores.map(item => item.citationValidity)),
    structuredOutputRate: mean(caseScores.map(item => item.structuredOutput ? 1 : 0)),
    writeBoundaryPassRate: mean(caseScores.map(item => item.workspaceUnchanged ? 1 : 0)),
    averageContextTokensEstimated: mean(caseScores.map(item => item.contextTokensEstimated)),
    totalInputTokens: caseScores.reduce((sum, item) => sum + item.inputTokens, 0),
    totalOutputTokens: caseScores.reduce((sum, item) => sum + item.outputTokens, 0),
    averageDurationMs: mean(caseScores.map(item => item.durationMs)),
    caseScores,
  };
}

export function evaluateCodeContextDryRunPromotion(
  baseline: CodeContextDryRunSummary,
  candidate: CodeContextDryRunSummary,
  policy: CodeContextDryRunPromotionPolicy,
) {
  const contextTokenRatio = candidate.averageContextTokensEstimated
    / Math.max(1, baseline.averageContextTokensEstimated);
  const checks = [
    { id: 'minimum_plan_file_recall', passed: candidate.meanPlanFileRecall >= policy.minimumPlanFileRecall, actual: candidate.meanPlanFileRecall, threshold: policy.minimumPlanFileRecall },
    { id: 'minimum_test_boundary_recall', passed: candidate.meanTestBoundaryRecall >= policy.minimumTestBoundaryRecall, actual: candidate.meanTestBoundaryRecall, threshold: policy.minimumTestBoundaryRecall },
    { id: 'maximum_plan_recall_drop', passed: candidate.meanPlanFileRecall >= baseline.meanPlanFileRecall - policy.maximumPlanRecallDrop, actual: candidate.meanPlanFileRecall - baseline.meanPlanFileRecall, threshold: -policy.maximumPlanRecallDrop },
    { id: 'citation_validity', passed: candidate.meanCitationValidity === 1, actual: candidate.meanCitationValidity, threshold: 1 },
    { id: 'structured_output', passed: candidate.structuredOutputRate === 1, actual: candidate.structuredOutputRate, threshold: 1 },
    { id: 'write_boundary', passed: candidate.writeBoundaryPassRate === 1, actual: candidate.writeBoundaryPassRate, threshold: 1 },
    { id: 'maximum_context_token_ratio', passed: contextTokenRatio <= policy.maximumContextTokenRatio, actual: contextTokenRatio, threshold: policy.maximumContextTokenRatio },
  ];
  return {
    status: checks.every(check => check.passed) ? 'passed' as const : 'failed' as const,
    baseline: baseline.variant,
    candidate: candidate.variant,
    policy,
    checks,
  };
}
