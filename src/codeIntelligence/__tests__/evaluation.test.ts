import { describe, expect, it } from '@jest/globals';
import {
  evaluateCodeRetrievalPromotion,
  scoreCodeRetrievalCase,
  summarizeCodeRetrievalStrategy,
  type CodeRetrievalEvaluationCase,
} from '../evaluation.js';

const cases: CodeRetrievalEvaluationCase[] = [{
  id: 'health', query: 'health endpoint', expectedFiles: ['src/app.ts', 'test/app.test.ts'], limit: 4,
}];

describe('code retrieval evaluation', () => {
  it('scores recall, rank, unexpected files and diversity deterministically', () => {
    expect(scoreCodeRetrievalCase(cases[0]!, {
      caseId: 'health', strategy: 'hybrid_graph',
      returnedFiles: ['README.md', 'src/app.ts', 'test/app.test.ts', 'src/app.ts'], latencyMs: 12,
    })).toEqual({
      caseId: 'health', recallAtK: 1, reciprocalRank: 0.5, top1Correct: false,
      unexpectedFileRate: 0.25, distinctFiles: 3, latencyMs: 12,
    });
  });

  it('passes promotion only when quality and latency remain inside policy', () => {
    const baseline = summarizeCodeRetrievalStrategy('hybrid', cases, [{
      caseId: 'health', strategy: 'hybrid', returnedFiles: ['src/app.ts'], latencyMs: 10,
    }]);
    const candidate = summarizeCodeRetrievalStrategy('hybrid_graph', cases, [{
      caseId: 'health', strategy: 'hybrid_graph',
      returnedFiles: ['src/app.ts', 'test/app.test.ts'], latencyMs: 15,
    }]);
    const policy = {
      minimumRecallAtK: 0.75, maximumRecallDrop: 0, maximumMrrDrop: 0.05,
      maximumUnexpectedFileRateIncrease: 0, maximumLatencyRatio: 2,
    };
    const passingPromotion = evaluateCodeRetrievalPromotion(baseline, candidate, policy);
    expect(passingPromotion.status).toBe('passed');
    expect(passingPromotion.checks.find(check => check.id === 'maximum_latency_ratio')).toMatchObject({
      passed: true, actual: 1.5, threshold: 2,
    });
    expect(passingPromotion.checks.find(check => check.id === 'maximum_unexpected_file_rate_increase'))
      .toMatchObject({ passed: true, actual: 0, threshold: 0 });
    expect(evaluateCodeRetrievalPromotion(baseline, { ...candidate, averageLatencyMs: 30 }, policy).status).toBe('failed');
  });
});
