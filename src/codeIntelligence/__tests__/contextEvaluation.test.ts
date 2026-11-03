import {
  evaluateCodeContextDryRunPromotion,
  scoreCodeContextDryRunCase,
  summarizeCodeContextDryRun,
  type CodeContextDryRunObservation,
} from '../contextEvaluation.js';

const evaluationCase = {
  id: 'routing',
  expectedFiles: ['lib/multistream.js', 'test/multistream.test.js'],
};
const citations = [
  'pino@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:lib/multistream.js#L1-L20',
  'pino@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:test/multistream.test.js#L1-L20',
];

function observation(variant: string, planFiles = evaluationCase.expectedFiles): CodeContextDryRunObservation {
  return {
    caseId: evaluationCase.id,
    variant,
    suppliedCitations: citations,
    planner: {
      parsed: true,
      likelyFiles: planFiles,
      testBoundary: ['test/multistream.test.js'],
      citations,
    },
    knowledge: {
      parsed: true,
      likelyFiles: evaluationCase.expectedFiles,
      testBoundary: ['test/multistream.test.js'],
      citations,
    },
    retrievalFiles: evaluationCase.expectedFiles,
    workspaceUnchanged: true,
    contextTokensEstimated: 100,
    inputTokens: 200,
    outputTokens: 50,
    durationMs: 1_000,
  };
}

describe('Stage-2 code-context evaluation', () => {
  it('scores exact commit citations, plan coverage and test boundaries', () => {
    expect(scoreCodeContextDryRunCase(evaluationCase, observation('candidate'))).toMatchObject({
      retrievalRecall: 1,
      planFileRecall: 1,
      knowledgeFileRecall: 1,
      testBoundaryRecall: 1,
      citationValidity: 1,
      structuredOutput: true,
      workspaceUnchanged: true,
    });
  });

  it('rejects invented citations even when the named file looks plausible', () => {
    const value = observation('candidate');
    value.knowledge.citations = ['pino@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:lib/multistream.js'];
    expect(scoreCodeContextDryRunCase(evaluationCase, value).citationValidity).toBe(2 / 3);
  });

  it('promotes only structured, citation-valid and write-safe candidate plans', () => {
    const baseline = summarizeCodeContextDryRun('baseline', [evaluationCase], [observation('baseline', ['lib/multistream.js'])]);
    const candidate = summarizeCodeContextDryRun('candidate', [evaluationCase], [observation('candidate')]);
    const promotion = evaluateCodeContextDryRunPromotion(baseline, candidate, {
      minimumPlanFileRecall: 0.75,
      minimumTestBoundaryRecall: 0.75,
      maximumPlanRecallDrop: 0,
      maximumContextTokenRatio: 1.5,
    });
    expect(promotion.status).toBe('passed');
    expect(promotion.checks.find(check => check.id === 'write_boundary')).toMatchObject({ passed: true });
  });
});
